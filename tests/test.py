import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
import subprocess
import json
import sys
import time

# ==============================================================================
# PROXY LOCAL TEMPORAL DE PRUEBAS (PUERTO 9090)
# ==============================================================================

class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Desactivamos los logs ruidosos para mantener limpia la consola
        pass

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_url.query)
        
        if parsed_url.path == "/manifest.m3u8":
            self.handle_manifest(query_params)
        elif parsed_url.path == "/segment.ts":
            self.handle_segment(query_params)
        else:
            self.send_response(404)
            self.end_headers()

    def handle_manifest(self, params):
        url = params.get('url')[0]
        referer = params.get('referer')[0]
        
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": referer
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                content = res.read().decode('utf-8', errors='ignore')
            
            lines = content.splitlines()
            new_lines = []
            base_url = url.rsplit('/', 1)[0]
            
            for line in lines:
                line_strip = line.strip()
                if line_strip and not line_strip.startswith("#"):
                    if not line_strip.startswith("http"):
                        abs_url = f"{base_url}/{line_strip}"
                    else:
                        abs_url = line_strip
                    
                    # Re-enrutamos al desofuscador local en el puerto 9090
                    proxy_url = f"http://localhost:9090/segment.ts?url={urllib.parse.quote(abs_url)}&referer={urllib.parse.quote(referer)}"
                    new_lines.append(proxy_url)
                else:
                    new_lines.append(line)
            
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.end_headers()
            self.wfile.write("\n".join(new_lines).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Error: {e}".encode())

    def handle_segment(self, params):
        url = params.get('url')[0]
        referer = params.get('referer')[0]
        
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": referer
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                data = res.read()
            
            data_len = len(data)
            start_idx = 0
            
            # Algoritmo de alineación de sincronización TS (0x47 cada 188 bytes)
            for i in range(min(150000, data_len - 188 * 4)):
                if data[i] == 0x47 and data[i+188] == 0x47 and data[i+188*2] == 0x47 and data[i+188*3] == 0x47:
                    start_idx = i
                    break
            
            if start_idx > 0:
                clean_ts = data[start_idx:]
            else:
                clean_ts = data
                
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.end_headers()
            self.wfile.write(clean_ts)
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Error: {e}".encode())

# ==============================================================================
# ORQUESTADOR DE LA POCO (PRUEBA DE CONCEPTO)
# ==============================================================================

def iniciar_servidor_prueba():
    server = HTTPServer(('localhost', 9090), ProxyHandler)
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    print("📡 Servidor Proxy desofuscador local iniciado en http://localhost:9090")

def probar_analisis_video(m3u8_url, referer_url):
    proxy_m3u8 = f"http://localhost:9090/manifest.m3u8?url={urllib.parse.quote(m3u8_url)}&referer={urllib.parse.quote(referer_url)}"
    
    print("\n🕵️  Ejecutando sonda de inspección profunda vía ffprobe contra el proxy local...")
    print("   (Esto descargará y desofuscará los primeros fragmentos en memoria)...")
    
    # ffprobe para extraer: Duración, Resolución, Códec de video y Códec de audio
    comando = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=codec_name,width,height",
        "-of", "json",
        proxy_m3u8
    ]
    
    try:
        resultado = subprocess.run(comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        
        if resultado.returncode == 0:
            analisis = json.loads(resultado.stdout)
            
            # Formatear la duración
            segundos_totales = float(analisis.get("format", {}).get("duration", 0))
            horas = int(segundos_totales // 3600)
            minutos = int((segundos_totales % 3600) // 60)
            segundos = int(segundos_totales % 60)
            
            # Obtener datos de los streams
            streams = analisis.get("streams", [])
            video_stream = next((s for s in streams if s.get("width")), {})
            audio_stream = next((s for s in streams if not s.get("width")), {})
            
            print("\n" + "="*54)
            print("🎉 ¡PRUEBA DE CONCEPTO EXITOSA!")
            print("="*54)
            print(f"🎬 Formato de Video:  {video_stream.get('codec_name', 'Desconocido')} ({video_stream.get('width')}x{video_stream.get('height')})")
            print(f"🔊 Formato de Audio:  {audio_stream.get('codec_name', 'Desconocido')}")
            print(f"⏰ Duración Real:     {horas:02d}:{minutos:02d}:{segundos:02d} ({segundos_totales:.2f} segundos)")
            print("="*54)
            print("El proxy local de-ofuscó el video de forma impecable.")
            print("FFmpeg puede leer, sincronizar y reproducir el archivo sin problemas.")
            print("="*54)
        else:
            print("\n❌ Error analizando el flujo a través del proxy.")
            print("Detalles de ffprobe:")
            print(resultado.stderr)
            
    except subprocess.TimeoutExpired:
        print("\n⏳ Tiempo de espera agotado. El CDN tardó demasiado en responder.")
    except FileNotFoundError:
        print("\n❌ Error: ffprobe no está instalado en este sistema de manera local.")

if __name__ == "__main__":
    print("======================================================")
    print("🧪 PROBANDO DE-OFUSCADOR GENÉRICO DE VIDEO EN MEMORIA")
    print("======================================================")
    
    # Pre-cargamos la última URL que capturó tu benchmark con éxito para ahorrarte tiempo
    url_defecto = "https://tiktokshopping.xyz/stream/5owUtiXOSNOPrQ3NFp_WiA/hjkrhuihghfvu/1781489924/30376983/index-f1-v1-a1.m3u8"
    referer_defecto = "https://cuevana.cz/pelicula/superman"
    
    m3u8 = input(f"🔗 URL del .m3u8 \n[Presiona Enter para usar: {url_defecto[:35]}...]: ").strip()
    if not m3u8:
        m3u8 = url_defecto
        
    referer = input(f"🔑 Referer \n[Presiona Enter para usar: {referer_defecto}]: ").strip()
    if not referer:
        referer = referer_defecto
        
    iniciar_servidor_prueba()
    probar_analisis_video(m3u8, referer)