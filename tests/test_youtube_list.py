import subprocess
import json

def test_youtube_listing(query):
    print("======================================================")
    print(f"🧪 TEST DE LISTADO YOUTUBE: {query}")
    print("======================================================")
    
    # Usamos la Variante #2 que sabemos que funciona
    comando = [
        "yt-dlp", 
        f"ytsearch10:{query}", 
        "--dump-json", 
        "--flat-playlist"
    ]
    
    try:
        print("📡 Solicitando datos a YouTube via JSON...")
        resultado = subprocess.run(comando, capture_output=True, text=True, check=True)
        
        # yt-dlp devuelve un objeto JSON por cada línea encontrada
        lineas = resultado.stdout.strip().split('\n')
        videos_procesados = []

        for i, linea in enumerate(lineas, 1):
            try:
                # Parseamos cada línea como un objeto JSON independiente
                datos = json.loads(linea)
                
                titulo = datos.get('title', 'Sin título')
                v_id = datos.get('id', 'N/A')
                duracion_seg = datos.get('duration', 0)
                
                # Convertimos segundos a formato MM:SS
                mins = int(duracion_seg // 60)
                secs = int(duracion_seg % 60)
                tiempo_formateado = f"{mins}:{secs:02d}"
                
                url = f"https://www.youtube.com/watch?v={v_id}"
                
                videos_procesados.append({
                    "index": i,
                    "titulo": titulo,
                    "tiempo": tiempo_formateado,
                    "url": url
                })
            except json.JSONDecodeError:
                print(f"⚠️ Error parseando línea {i}")

        # IMPRESIÓN DE RESULTADOS
        if videos_procesados:
            print("\n✅ LISTADO GENERADO CORRECTAMENTE:\n")
            print(f"{'#':<3} | {'Duración':<10} | {'Título'}")
            print("-" * 60)
            for v in videos_procesados:
                print(f"{v['index']:<3} | {v['tiempo']:<10} | {v['titulo']}")
            
            print("\n" + "="*60)
            print(f"Total de videos procesados: {len(videos_procesados)}")
        else:
            print("\n❌ No se pudo procesar ningún video del JSON.")

    except subprocess.CalledProcessError as e:
        print(f"❌ Error ejecutando yt-dlp: {e}")
    except Exception as e:
        print(f"❌ Error inesperado: {e}")

if __name__ == "__main__":
    keyword = input("Introduce palabra clave para el test de lista: ")
    test_youtube_listing(keyword)