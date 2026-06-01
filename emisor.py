import subprocess
import logging
import os
from threading import Thread

class Config:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    LISTA_URLS = os.path.join(BASE_DIR, "lista.txt")
    FALLIDAS_URLS = os.path.join(BASE_DIR, "urls_fallidas.txt")
    LOG_FILE = os.path.join(BASE_DIR, "tv_system.log")
    FFMPEG_LOG = os.path.join(BASE_DIR, "ffmpeg_errors.log")
    COOKIES_FILE = os.path.join(BASE_DIR, "cookies.txt")
    ALMACEN = "/dev/shm/almacen_tv"
    API_URL = "http://localhost:9000/" 
    RTSP_URL = "rtsp://localhost:8554/novela"

    @classmethod
    def preparar_entorno(cls):
        if not os.path.exists(cls.ALMACEN):
            os.makedirs(cls.ALMACEN)
            print(f"Carpeta de RAM creada en: {cls.ALMACEN}")
        archivos_necesarios = [
            cls.LISTA_URLS, 
            cls.FALLIDAS_URLS, 
            cls.LOG_FILE, 
            cls.FFMPEG_LOG, 
            cls.COOKIES_FILE
        ]
        for ruta in archivos_necesarios:
            if not os.path.exists(ruta):
                with open(ruta, 'w') as f:
                    pass
                print(f"Archivo creado: {os.path.basename(ruta)} en {ruta}")

class LecturaYEscrituraEnLista:
    def __init__(self):
        self.ruta_lista = Config.LISTA_URLS

    def leer(self):
        print("--- Leyendo Lista de Videos ---")
        try:
            with open(self.ruta_lista, 'r') as archivo:
                urls = archivo.readlines()
                if not urls:
                    print("La lista está vacía. Agrega URLs al archivo.")
                    return [] 
                for i, url in enumerate(urls, 1):
                    url_limpia = url.strip()
                    if url_limpia:
                        print(f"{i}. {url_limpia}")
                return [u.strip() for u in urls if u.strip()]
        except Exception as e:
            print(f"Error al leer el archivo: {e}")
            return [] 

    def borradoYavance(self):
        urls = self.leer() 
        if not urls:
            print("No hay URLs para borrar.")
            return None
        url_a_procesar = urls[0] 
        resto_de_urls = urls[1:] 
        with open(self.ruta_lista, 'w') as archivo:
            for u in resto_de_urls:
                archivo.write(u + "\n")
        print(f"Procesada y borrada: {url_a_procesar}")
        return url_a_procesar
    
class descargarVideos:
    def __init__(self):
        self.cookies = Config.COOKIES_FILE
        self.almacen = Config.ALMACEN
        self.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        self.referer = "https://mixdrop.is/"

    def descargar_directo_wget(self, url, destino):
        """Método de respaldo: Descarga bruta usando wget"""
        print(f"[FALLBACK] Intentando descarga directa con WGET: {url}")
        comando = [
            "wget",
            "-q",
            "--user-agent", self.user_agent,
            "--referer", self.referer,
            "-O", destino,
            url
        ]
        try:
            subprocess.run(comando, capture_output=True, text=True, check=True)
            if os.path.exists(destino) and os.path.getsize(destino) > 0:
                return True
        except Exception as e:
            print(f"[FALLBACK] WGET también falló: {e}")
        return False

    def descargar(self, url):
        obtenido = os.path.join(self.almacen, "siguiente.mp4")
        
        # --- INTENTO 1: yt-dlp (El método inteligente) ---
        print(f"🚀 Intentando descargar con yt-dlp: {url}")
        comando_yt = [
            "yt-dlp",
            "--impersonate", "chrome",
            "--cookies", self.cookies,
            "--extractor-args", "youtube:player_client=tv,mweb",
            "-f", "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best",
            "--no-playlist",
            "--merge-output-format", "mp4",
            "-o", obtenido,
            url
        ]
        
        try:
            subprocess.run(comando_yt, capture_output=True, text=True, check=True)
            if os.path.exists(obtenido) and os.path.getsize(obtenido) > 0:
                print("Descarga exitosa con yt-dlp")
                return True
        except subprocess.CalledProcessError as e:
            print(f"yt-dlp falló. Error: {e.stderr[:100]}...") 
        if self.descargar_directo_wget(url, obtenido):
            print("Descarga exitosa usando WGET (Fallback)")
            return True

        print(f"Todos los métodos de descarga fallaron para: {url}")
        return False

class trasmitir:
    def __init__(self):
        self.rtsp_url = Config.RTSP_URL
        self.almacen = Config.ALMACEN
        self.ffmpeglogs = Config.FFMPEG_LOG

    def emitir(self, video_path):
        print(f"🎬 Transmitiendo: {video_path}")
        comando = [
            "ffmpeg", "-re", "-i", video_path,
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-async", "1",
            "-rtsp_transport", "tcp", "-f", "rtsp",
            "-max_delay", "500000", "-buffer_size", "10M",
            self.rtsp_url          
        ]
        try:
            with open(self.ffmpeglogs, "a") as log_file:
                subprocess.run(comando, stdout=subprocess.DEVNULL, stderr=log_file, check=True)
            print("Reproducción finalizada con éxito")
            return True
        except subprocess.CalledProcessError as e:
            print(f"Error en la transmisión, revisa {self.ffmpeglogs}")
            return False
        except Exception as e:
            print(f"Error en el streamer: {e}")
            return False

    def limpiarVideo(self, video_path): 
        try:
            if os.path.exists(video_path):
                os.remove(video_path)
                print("🧹 Video eliminado de la RAM")
                return True
        except Exception as e:
            print(f"No se pudo borrar el video: {e}")
            return False


class ejecutor:
    def __init__(self):
        self.lista = LecturaYEscrituraEnLista()
        self.downloader = descargarVideos()
        self.streamer = trasmitir()
        self.archivo_actual = os.path.join(Config.ALMACEN, "Current.mp4")
        self.archivo_siguiente = os.path.join(Config.ALMACEN, "siguiente.mp4")
        self.descargando = False # Bandera para saber si hay un hilo activo

    def hilo_descarga(self, url):
        """Función que correrá en segundo plano"""
        print(f"[BG] Iniciando descarga en segundo plano: {url}")
        if self.downloader.descargar(url):
            print("[BG] Siguiente video listo en RAM")
        else:
            print(f"[BG] Falló la descarga de {url}")
        self.descargando = False

    def ejecutar(self):
        print("Iniciando Sistema Autónomo Pro...")
        Config.preparar_entorno()

        # 1. Carga inicial (Sincrónica para asegurar que tenemos algo que emitir)
        url_inicial = self.lista.borradoYavance()
        if not url_inicial or not self.downloader.descargar(url_inicial):
            print("No hay URLs o falló la descarga inicial.")
            return
        
        os.rename(self.archivo_siguiente, self.archivo_actual)

        while True:
            # --- PASO A: Lanzar descarga del SIGUIENTE video en segundo plano ---
            if not self.descargando:
                siguiente_url = self.lista.borradoYavance()
                if siguiente_url:
                    self.descargando = True
                    # Creamos el hilo para que no bloquee la transmisión
                    thread = Thread(target=self.hilo_descarga, args=(siguiente_url,))
                    thread.start()
                else:
                    print("🏁 No quedan más URLs en la lista.")

            # --- PASO B: Transmitir el video ACTUAL (Esto es bloqueante) ---
            exito_emision = self.streamer.emitir(self.archivo_actual)
            
            # Limpiar video actual
            self.streamer.limpiarVideo(self.archivo_actual)

            # --- PASO C: Rotación de archivos ---
            # Si mientras transmitíamos el hilo terminó de descargar el siguiente:
            if os.path.exists(self.archivo_siguiente):
                os.rename(self.archivo_siguiente, self.archivo_actual)
                print("Rotación completada: Siguiente $\rightarrow$ Actual")
            else:
                print("El siguiente video no terminó de descargar. Esperando...")
                # Aquí podrías poner un sleep o intentar descargar uno nuevo
                while not os.path.exists(self.archivo_siguiente):
                    # Esperamos a que el hilo de descarga termine o manejamos el error
                    if not self.descargando: 
                        # Si ya no hay hilo descargando y no hay archivo, tenemos que buscar otra URL
                        url_emergencia = self.lista.borradoYavance()
                        if not url_emergencia: break
                        self.descargando = True
                        Thread(target=self.hilo_descarga, args=(url_emergencia,)).start()
                    import time
                    time.sleep(1)
                os.rename(self.archivo_siguiente, self.archivo_actual)

if __name__ == "__main__":
    try: 
        tv = ejecutor()
        tv.ejecutar()
    except KeyboardInterrupt:
        print("\n Sistema detenido por usuario")
        if os.path.exists(Config.ALMACEN):
            for f in os.listdir(Config.ALMACEN):
                os.remove(os.path.join(Config.ALMACEN, f))
        print("Adios")