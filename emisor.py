import subprocess
import os
import time
import sqlite3
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
    ALMACEN = "/dev/shm/almacen_tv"  # Disco en RAM para evitar desgaste de SSD

    # Streaming
    RTMP_URL = "rtmp://mediamtx:1935/novela"
    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    # Optimización FFmpeg
    VIDEO_SCALE = "scale=1280:720,fps=25,format=yuv420p"
    FFMPEG_PARAMS = [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-f", "flv"
    ]

    @classmethod
    def preparar_entorno(cls):
        if not os.path.exists(cls.ALMACEN):
            os.makedirs(cls.ALMACEN)
        # Limpiar RAM al iniciar para evitar basura de ejecuciones previas
        for f in os.listdir(cls.ALMACEN):
            try: os.remove(os.path.join(cls.ALMACEN, f))
            except: pass

# Configuración de Logs
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    handlers=[logging.FileHandler(Config.LOG_FILE), logging.StreamHandler()]
)
logger = logging.getLogger("TV_System")

# ==============================================================================
# GESTIÓN DE BASE DE DATOS (Con Soporte de Horarios y WAL)
# ==============================================================================
class PlaylistDB:
    def __init__(self):
        self.conn = sqlite3.connect(Config.DB_PATH, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        # ACTIVAR MODO WAL para evitar errores de "Database is locked"
        self.conn.execute("PRAGMA journal_mode=WAL;")

    def obtener_siguiente(self):
        """
        Lógica de selección:
        1. Busca el primer video programado cuya hora sea <= hora actual y no haya sido reproducido.
        2. Si no hay, busca el primer video de la cola general no reproducido.
        """
        cursor = self.conn.cursor()
        ahora_str = datetime.now().strftime("%H:%M")

        # Intentar obtener contenido programado
        cursor.execute("""
            SELECT * FROM contenidos 
            WHERE reproducido = 0 AND hora_programada IS NOT NULL AND hora_programada <= ? 
            ORDER BY hora_programada ASC LIMIT 1
        """, (ahora_str,))
        res = cursor.fetchone()

        if res:
            logger.info(f"📅 Contenido programado detectado: {res['titulo']} ({res['hora_programada']})")
            return res

        # Fallback: siguiente en la cola general
        cursor.execute("SELECT * FROM contenidos WHERE reproducido = 0 AND hora_programada IS NULL ORDER BY id ASC LIMIT 1")
        return cursor.fetchone()

    def marcar_reproducido(self, video_id):
        """En lugar de borrar, marcamos como reproducido para mantener historial"""
        self.conn.execute("UPDATE contenidos SET reproducido = 1 WHERE id = ?", (video_id,))
        self.conn.commit()

# ==============================================================================
# MÓDULO DE DESCARGA
# ==============================================================================
class Downloader:
    def __init__(self):
        self.almacen = Config.ALMACEN

    def descargar(self, video_data):
        url = video_data['url_final']
        video_id = video_data['id']

        if ".m3u8" in url:
            logger.info(f"[BG] Marcador HLS para ID {video_id}")
            with open(f"{self.almacen}/next_{video_id}.url", "w") as f:
                f.write(f"{url}\nhttps://jkanime.net/") 
            return True

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
            return os.path.exists(destino) and os.path.getsize(destino) > 0
        except Exception as e:
            logger.error(f"[BG] Error descargando ID {video_id}: {e}")
            return False

# ==============================================================================
# MÓDULO DE TRANSMISIÓN
# ==============================================================================
class Streamer:
    def __init__(self):
        self.rtmp_url = Config.RTMP_URL

    def emitir(self, video_data):
        video_id = video_data['id']
        url_file = f"{Config.ALMACEN}/next_{video_id}.mp4"
        url_meta = f"{Config.ALMACEN}/next_{video_id}.url"

        if os.path.exists(url_meta):
            with open(url_meta, "r") as f:
                lines = f.read().splitlines()
                stream_url, referer = lines[0], lines[1]

            logger.info(f"🎬 Transmitiendo Stream HLS: {stream_url}")
            comando = [
                "ffmpeg", "-y", "-re", 
                "-thread_queue_size", "1024",
                "-referer", referer, "-user_agent", Config.USER_AGENT,
                "-i", stream_url, "-vf", Config.VIDEO_SCALE,
                *Config.FFMPEG_PARAMS, self.rtmp_url
            ]
            return self._ejecutar_ffmpeg(comando, url_meta)

        elif os.path.exists(url_file):
            logger.info(f"🎬 Transmitiendo Archivo RAM: {url_file}")
            comando = [
                "ffmpeg", "-y", "-readrate", "2",
                "-i", url_file, "-vf", Config.VIDEO_SCALE,
                *Config.FFMPEG_PARAMS, self.rtmp_url
            ]
            return self._ejecutar_ffmpeg(comando, url_file)
        
        logger.error("❌ No se encontró archivo listo para emitir.")
        return False

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
# EJECUTOR PRINCIPAL
# ==============================================================================
class TVExecutor:
    def __init__(self):
        self.db = PlaylistDB()
        self.downloader = Downloader()
        self.streamer = Streamer()
        self.stop_event = Event()
        self.is_downloading = False

    def monitor_progress(self, video_id, duration):
        """Dispara la descarga del siguiente video cuando el actual esté al 80%"""
        time.sleep(duration * 0.8)
        if not self.is_downloading:
            self.disparar_siguiente()

    def disparar_siguiente(self):
        siguiente = self.db.obtener_siguiente()
        if siguiente:
            self.is_downloading = True
            Thread(target=self._descarga_hilo, args=(siguiente,), daemon=True).start()

    def _descarga_hilo(self, video_data):
        logger.info(f"[Prefetch] Preparando siguiente: {video_data['titulo']}")
        self.downloader.descargar(video_data)
        self.is_downloading = False

    def ejecutar(self):
        logger.info("🚀 Iniciando TV Autónoma v2.1 (Scheduled & WAL Mode)")
        Config.preparar_entorno()

        while not self.stop_event.is_set():
            actual = self.db.obtener_siguiente()
            if not actual:
                logger.warning("🏁 No hay más contenidos pendientes. Esperando 30s...")
                time.sleep(30)
                continue

            # Asegurar descarga
            if not os.path.exists(f"{Config.ALMACEN}/next_{actual['id']}.mp4") and \
               not os.path.exists(f"{Config.ALMACEN}/next_{actual['id']}.url"):
                self.downloader.descargar(actual)

            # Prefetch (Duración estimada 20min si no se conoce)
            duration = 1200 
            Thread(target=self.monitor_progress, args=(actual['id'], duration), daemon=True).start()

            if self.streamer.emitir(actual):
                logger.info(f"✅ Finalizado: {actual['titulo']}")
                self.db.marcar_reproducido(actual['id'])
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
            try: os.remove(os.path.join(Config.ALMACEN, f))
            except: pass