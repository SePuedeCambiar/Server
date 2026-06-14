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
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DB_PATH = os.path.join(BASE_DIR, "data", "playlist.db")
    LOG_FILE = os.path.join(BASE_DIR, "tv_system.log")
    FFMPEG_LOG = os.path.join(BASE_DIR, "ffmpeg_errors.log")
    COOKIES_FILE = os.path.join(BASE_DIR, "cookies.txt")
    ALMACEN = "/dev/shm/almacen_tv"  # Disco en RAM para evitar desgaste de SSD/SD

    # Streaming
    RTMP_URL = "rtmp://mediamtx:1935/novela"
    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    # MODO_EMISION
    MODO_EMISION = 'copy' 

    # Parámetros para modo 'transcode' (Renderizado tradicional)
    VIDEO_SCALE = "scale=1280:720,fps=25,format=yuv420p"
    FFMPEG_TRANSCODE_PARAMS = [
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-f", "flv"
    ]

    # Parámetros para modo 'copy' - ARCHIVOS LOCALES
    FFMPEG_COPY_PURE = [
        "-c:v", "copy",
        "-c:a", "copy",
        "-f", "flv"
    ]

    # Parámetros para modo 'copy' - STREAMS REMOTOS
    FFMPEG_COPY_SMART = [
        "-c:v", "copy",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k",
        "-f", "flv"
    ]

    @classmethod
    def preparar_entorno(cls):
        if not os.path.exists(cls.ALMACEN):
            os.makedirs(cls.ALMACEN)
        for f in os.listdir(cls.ALMACEN):
            try: os.remove(os.path.join(cls.ALMACEN, f))
            except: pass

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
        self.conn.execute("PRAGMA journal_mode=WAL;")

    def obtener_siguiente(self):
        cursor = self.conn.cursor()
        ahora_str = datetime.now().strftime("%H:%M")

        # 1. Contenido programado
        cursor.execute("""
            SELECT * FROM contenidos 
            WHERE reproducido = 0 AND hora_programada IS NOT NULL AND hora_programada <= ? 
            ORDER BY hora_programada ASC LIMIT 1
        """, (ahora_str,))
        res = cursor.fetchone()
        if res:
            return res

        # 2. Cola general (Fallback)
        cursor.execute("SELECT * FROM contenidos WHERE reproducido = 0 AND hora_programada IS NULL ORDER BY id ASC LIMIT 1")
        return cursor.fetchone()

    def marcar_reproducido(self, video_id):
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
            logger.info(f"[BG] Registrando marcador HLS para ID {video_id}")
            
            # 📡 DETERMINACIÓN DINÁMICA DEL REFERER BASADO EN LA DB
            try:
                dominio = video_data['dominio'] if video_data['dominio'] else 'jkanime.net'
            except Exception:
                dominio = 'jkanime.net'
            
            referer = f"https://{dominio}/"
            logger.info(f"[BG] Configurando Referer para el reproductor: {referer}")

            with open(f"{self.almacen}/next_{video_id}.url", "w") as f:
                f.write(f"{url}\n{referer}")
            return True

        logger.info(f"[BG] Descargando MP4 para ID {video_id} vía yt-dlp...")
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

        # --- CASO 1: STREAM REMOTO (HLS/m3u8) ---
        if os.path.exists(url_meta):
            with open(url_meta, "r") as f:
                lines = f.read().splitlines()
                stream_url, referer = lines[0], lines[1]

            logger.info(f"🎬 TRANSMITIENDO HLS VIVO: {stream_url}")
            logger.info(f"🔑 Referer utilizado: {referer}")
            
            if Config.MODO_EMISION == 'copy':
                comando = [
                    "ffmpeg", "-y", "-re",
                    "-thread_queue_size", "2048",
                    "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
                    "-fflags", "+genpts+discardcorrupt",
                    "-referer", referer, "-user_agent", Config.USER_AGENT,
                    "-i", stream_url,
                    *Config.FFMPEG_COPY_SMART, self.rtmp_url
                ]
            else:
                comando = [
                    "ffmpeg", "-y", "-re",
                    "-thread_queue_size", "2048",
                    "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
                    "-fflags", "+genpts+discardcorrupt",
                    "-referer", referer, "-user_agent", Config.USER_AGENT,
                    "-i", stream_url, "-vf", Config.VIDEO_SCALE,
                    *Config.FFMPEG_TRANSCODE_PARAMS, self.rtmp_url
                ]
            return self._ejecutar_ffmpeg(comando, url_meta)

        # --- CASO 2: ARCHIVO LOCAL (MP4 en RAM) ---
        elif os.path.exists(url_file):
            logger.info(f"🎬 TRANSMITIENDO ARCHIVO RAM: {url_file}")
            
            if Config.MODO_EMISION == 'copy':
                comando = [
                    "ffmpeg", "-y", "-readrate", "1.3", 
                    "-i", url_file,
                    *Config.FFMPEG_COPY_PURE, self.rtmp_url
                ]
            else:
                comando = [
                    "ffmpeg", "-y", "-readrate", "1.3", 
                    "-i", url_file, "-vf", Config.VIDEO_SCALE,
                    *Config.FFMPEG_TRANSCODE_PARAMS, self.rtmp_url
                ]
            return self._ejecutar_ffmpeg(comando, url_file)

        logger.error("❌ No se encontró recurso listo para emitir.")
        return False

    def _ejecutar_ffmpeg(self, comando, path_to_clean):
        try:
            with open(Config.FFMPEG_LOG, "a") as log:
                subprocess.run(comando, stdout=subprocess.DEVNULL, stderr=log, check=True)
            if os.path.exists(path_to_clean):
                os.remove(path_to_clean)
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"❌ FFmpeg falló con código {e.returncode}. Revisa {Config.FFMPEG_LOG}")
            return False

# ==============================================================================
# EJECUTOR PRINCIPAL (Orquestador)
# ==============================================================================
class TVExecutor:
    def __init__(self):
        self.db = PlaylistDB()
        self.downloader = Downloader()
        self.streamer = Streamer()
        self.stop_event = Event()
        self.is_downloading = False

    def monitor_progress(self, video_id, duration):
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
        logger.info(f"🚀 Iniciando TV Autónoma en modo [{Config.MODO_EMISION.upper()}]")
        Config.preparar_entorno()

        while not self.stop_event.is_set():
            actual = self.db.obtener_siguiente()
            if not actual:
                logger.info("💤 Esperando contenido en la base de datos...")
                time.sleep(30)
                continue

            if not os.path.exists(f"{Config.ALMACEN}/next_{actual['id']}.mp4") and \
               not os.path.exists(f"{Config.ALMACEN}/next_{actual['id']}.url"):
                self.downloader.descargar(actual)

            duracion = actual.get('duracion', 1200) if isinstance(actual, dict) else 1200
            Thread(target=self.monitor_progress, args=(actual['id'], duracion), daemon=True).start()

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
        for f in os.listdir(Config.ALMACEN):
            try: os.remove(os.path.join(Config.ALMACEN, f))
            except: pass