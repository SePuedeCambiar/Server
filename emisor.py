import subprocess
import os
import time
import sqlite3
import re
import logging
from threading import Thread, Event
from datetime import datetime

# ==============================================================================
# CONFIGURACIÓN GLOBAL
# ==============================================================================
class Config:
    # Rutas y Archivos
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DB_PATH = os.path.join(BASE_DIR, "playlist.db")
    LOG_FILE = os.path.join(BASE_DIR, "tv_system.log")
    FFMPEG_LOG = os.path.join(BASE_DIR, "ffmpeg_errors.log")
    COOKIES_FILE = os.path.join(BASE_DIR, "cookies.txt")
    ALMACEN = "/dev/shm/almacen_tv"
    
    # Streaming
    RTMP_URL = "rtmp://localhost:1935/novela"
    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    
    # Optimización
    VIDEO_SCALE = "scale=1280:720,fps=25,format=yuv420p"
    # En la clase Config, cambia FFMPEG_PARAMS
    FFMPEG_PARAMS = [
    "-c:v", "libx264", 
    "-preset", "veryfast",     # Cambiado de ultrafast a veryfast para mejor calidad/estabilidad
    # "-tune", "zerolatency",   # <--- ELIMINA ESTA LÍNEA COMPLETAMENTE
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-f", "flv"
]
    @classmethod
    def preparar_entorno(cls):
        if not os.path.exists(cls.ALMACEN):
            os.makedirs(cls.ALMACEN)
        # Limpiar RAM al iniciar
        for f in os.listdir(cls.ALMACEN):
            os.remove(os.path.join(cls.ALMACEN, f))

# Configuración de Logs
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    handlers=[logging.FileHandler(Config.LOG_FILE), logging.StreamHandler()]
)
logger = logging.getLogger("TV_System")

# ==============================================================================
# GESTIÓN DE BASE DE DATOS
# ==============================================================================
class PlaylistDB:
    def __init__(self):
        self.conn = sqlite3.connect(Config.DB_PATH, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row

    def obtener_siguiente(self):
        # Obtiene el primer video que no haya sido reproducido o el más antiguo
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM contenidos ORDER BY id ASC LIMIT 1")
        return cursor.fetchone()

    def borrar_actual(self, video_id):
        self.conn.execute("DELETE FROM contenidos WHERE id = ?", (video_id,))
        self.conn.commit()

# ==============================================================================
# MÓDULO DE DESCARGA (Soporta MP4 y M3U8)
# ==============================================================================
class Downloader:
    def __init__(self):
        self.almacen = Config.ALMACEN

    def descargar(self, video_data):
        url = video_data['url_final']
        video_id = video_data['id']
        
        # --- CASO A: Es un m3u8 (Directo) ---
        if ".m3u8" in url:
            logger.info(f"[BG] Detectado HLS directo para ID {video_id}. Creando marcador...")
            with open(f"{self.almacen}/next_{video_id}.url", "w") as f:
                f.write(f"{url}\nhttps://jkanime.net/") # Referer genérico
            return True

        # --- CASO B: MP4 (yt-dlp) ---
        logger.info(f"[BG] Descargando MP4 para ID {video_id} via yt-dlp...")
        destino = f"{self.almacen}/next_{video_id}.mp4"
        
        comando = [
            "yt-dlp", "--impersonate", "chrome",
            "--cookies", Config.COOKIES_FILE,
            "-f", "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best",
            "--no-playlist", "--merge-output-format", "mp4",
            "-o", destino, url
        ]
        
        try:
            subprocess.run(comando, capture_output=True, check=True)
            if os.path.exists(destino) and os.path.getsize(destino) > 0:
                return True
        except Exception as e:
            logger.error(f"[BG] Error descargando ID {video_id}: {e}")
            return False

# ==============================================================================
# MÓDULO DE TRANSMISIÓN (Soporta archivos y streams)
# ==============================================================================
class Streamer:
    def __init__(self):
        self.rtmp_url = Config.RTMP_URL

    def emitir(self, video_data):
        video_id = video_data['id']
        url_file = f"{Config.ALMACEN}/next_{video_id}.mp4"
        url_meta = f"{Config.ALMACEN}/next_{video_id}.url"
        
        # 1. Transmisión desde M3U8 (Directo)
        if os.path.exists(url_meta):
            with open(url_meta, "r") as f:
                lines = f.read().splitlines()
                stream_url, referer = lines[0], lines[1]
            
            logger.info(f"🎬 Transmitiendo Stream HLS: {stream_url}")
            
            # 🚀 CORRECCIÓN AQUÍ: Añadimos '-re' para que no sature el servidor
            # Esto obliga a FFmpeg a leer a la velocidad real del video (25fps)
            comando = [
                "ffmpeg", "-y", 
                "-re",                      # <--- CRÍTICO: Lee a velocidad real
                "-thread_queue_size", "1024",
                "-referer", referer, 
                "-user_agent", Config.USER_AGENT,
                "-i", stream_url,
                "-vf", Config.VIDEO_SCALE,
                *Config.FFMPEG_PARAMS, self.rtmp_url
            ]
            self._ejecutar_ffmpeg(comando, url_meta)

        # 2. Transmisión desde MP4 (Archivo en RAM)
        elif os.path.exists(url_file):
            logger.info(f"🎬 Transmitiendo Archivo RAM: {url_file}")
            
            # Aquí mantenemos tu optimización de readrate para llenar el caché de MediaMTX
            comando = [
                "ffmpeg", "-y", 
                "-readrate", "2",           # Lee al doble de velocidad para llenar búfer
                "-i", url_file,
                "-vf", Config.VIDEO_SCALE,
                *Config.FFMPEG_PARAMS, self.rtmp_url
            ]
            self._ejecutar_ffmpeg(comando, url_file)
        else:
            logger.error("❌ No se encontró archivo listo para emitir.")
            return False
        return True

    def _ejecutar_ffmpeg(self, comando, path_to_clean):
        try:
            with open(Config.FFMPEG_LOG, "a") as log:
                subprocess.run(comando, stdout=subprocess.DEVNULL, stderr=log, check=True)
            if os.path.exists(path_to_clean):
                os.remove(path_to_clean)
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"❌ FFmpeg falló con código {e.returncode}")
            return False
    def __init__(self):
        self.rtmp_url = Config.RTMP_URL

    def emitir(self, video_data):
        video_id = video_data['id']
        url_file = f"{Config.ALMACEN}/next_{video_id}.mp4"
        url_meta = f"{Config.ALMACEN}/next_{video_id}.url"
        
        # 1. Transmisión desde M3U8 (Directo)
        if os.path.exists(url_meta):
            with open(url_meta, "r") as f:
                lines = f.read().splitlines()
                stream_url, referer = lines[0], lines[1]
            
            logger.info(f"🎬 Transmitiendo Stream HLS: {stream_url}")
            comando = [
                "ffmpeg", "-y", "-thread_queue_size", "1024",
                "-referer", referer, "-user_agent", Config.USER_AGENT,
                "-i", stream_url,
                "-vf", Config.VIDEO_SCALE,
                *Config.FFMPEG_PARAMS, self.rtmp_url
            ]
            self._ejecutar_ffmpeg(comando, url_meta)

        # 2. Transmisión desde MP4 (Archivo en RAM)
        elif os.path.exists(url_file):
            logger.info(f"🎬 Transmitiendo Archivo RAM: {url_file}")
            comando = [
                "ffmpeg", "-y", "-readrate", "2", 
                "-i", url_file,
                "-vf", Config.VIDEO_SCALE,
                *Config.FFMPEG_PARAMS, self.rtmp_url
            ]
            self._ejecutar_ffmpeg(comando, url_file)
        else:
            logger.error("❌ No se encontró archivo listo para emitir.")
            return False
        return True

    def _ejecutar_ffmpeg(self, comando, path_to_clean):
        try:
            with open(Config.FFMPEG_LOG, "a") as log:
                subprocess.run(comando, stdout=subprocess.DEVNULL, stderr=log, check=True)
            if os.path.exists(path_to_clean):
                os.remove(path_to_clean)
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"❌ FFmpeg falló con código {e.returncode}")
            return False

# ==============================================================================
# EJECUTOR PRINCIPAL (Con Prefetching del 20%)
# ==============================================================================
class TVExecutor:
    def __init__(self):
        self.db = PlaylistDB()
        self.downloader = Downloader()
        self.streamer = Streamer()
        self.stop_event = Event()
        self.is_downloading = False

    def monitor_progress(self, video_id, duration):
        """Sigue el progreso de FFmpeg para disparar la siguiente descarga"""
        # Nota: Para implementarlo real, necesitaríamos leer el stderr de FFmpeg en tiempo real.
        # Como simplificación robusta, calculamos el tiempo estimado de inicio de descarga.
        # Si el video dura 1000s, a los 800s disparamos la descarga del siguiente.
        time.sleep(duration * 0.8) 
        if not self.is_downloading:
            self.disparar_siguiente()

    def disparar_siguiente(self):
        siguiente = self.db.obtener_siguiente()
        if siguiente:
            self.is_downloading = True
            Thread(target=self._descarga_hilo, args=(siguiente,), daemon=True).start()

    def _descarga_hilo(self, video_data):
        logger.info(f"[Prefetch] Preparando siguiente video: {video_data['titulo']}")
        self.downloader.descargar(video_data)
        self.is_downloading = False

    def ejecutar(self):
        logger.info("🚀 Iniciando TV Autónoma v2.0 (Seamless Prefetch)")
        Config.preparar_entorno()

        while not self.stop_event.is_set():
            # 1. Obtener el video actual
            actual = self.db.obtener_siguiente()
            if not actual:
                logger.warn("🏁 No hay más contenidos en la base de datos.")
                break

            # 2. Asegurar que el actual esté descargado antes de emitir
            if not os.path.exists(f"{Config.ALMACEN}/next_{actual['id']}.mp4") and \
               not os.path.exists(f"{Config.ALMACEN}/next_{actual['id']}.url"):
                logger.info(f"⏳ Esperando descarga inicial de: {actual['titulo']}")
                self.downloader.descargar(actual)

            # 3. Calcular duración para el prefetch (Solo si es MP4)
            # Aquí podrías llamar a tu script de Python de duraciones
            duration = 1200 # Valor por defecto (20 min) si no se conoce

            # 4. Emitir y monitorear en paralelo
            Thread(target=self.monitor_progress, args=(actual['id'], duration), daemon=True).start()
            
            exito = self.streamer.emitir(actual)
            
            if exito:
                logger.info(f"✅ Finalizado: {actual['titulo']}")
                self.db.borrar_actual(actual['id'])
            else:
                logger.error("❌ Error en transmisión. Reintentando en 5s...")
                time.sleep(5)

if __name__ == "__main__":
    try:
        tv = TVExecutor()
        tv.ejecutar()
    except KeyboardInterrupt:
        logger.info("🛑 Apagando sistema...")
        # Limpieza final de RAM
        for f in os.listdir(Config.ALMACEN):
            os.remove(os.path.join(Config.ALMACEN, f))