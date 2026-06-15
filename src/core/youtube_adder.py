import subprocess
import sqlite3
import os
import urllib.parse

# ==============================================================================
# CONFIGURACIÓN DE RUTAS DINÁMICAS (Subimos 2 niveles desde src/core/)
# ==============================================================================
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(BASE_DIR, 'data', 'playlist.db')

# ==============================================================================
# MOTOR DE BÚSQUEDA Y EXTRACCIÓN DE METADATOS DE YOUTUBE
# ==============================================================================
def buscar_en_youtube(keyword, limite=10):
    print(f"🔍 Buscando '{keyword}' en YouTube vía yt-dlp...")
    
    # Extraemos el Título, el ID de video y la duración en segundos (nativa de yt-dlp)
    comando = [
        "yt-dlp",
        f"ytsearch{limite}:{keyword}",
        "--print", "%(title)s||%(id)s||%(duration)s",
        "--no-playlist"
    ]
    
    try:
        resultado = subprocess.run(comando, capture_output=True, text=True, check=True)
        lineas = resultado.stdout.strip().split('\n')
        videos = []
        
        for linea in lineas:
            if "||" in linea:
                partes = linea.split("||")
                if len(partes) >= 3:
                    titulo, video_id, duracion_sec = partes[0], partes[1], partes[2]
                    
                    # Convertir duración a entero (segundos) de manera segura
                    try:
                        duracion = int(float(duracion_sec)) if duracion_sec else 0
                    except ValueError:
                        duracion = 0
                        
                    videos.append({
                        "titulo": titulo,
                        "url": f"https://www.youtube.com/watch?v={video_id}",
                        "duracion": duracion
                    })
        return videos
    except Exception as e:
        print(f"❌ Error ejecutando búsqueda en yt-dlp: {e}")
        return []

# ==============================================================================
# ESCRITURA EN BASE DE DATOS
# ==============================================================================
def agregar_a_db(titulo, url, duracion):
    # Validamos que la carpeta data exista por seguridad
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        # Insertamos el video con la clasificación PELICULA_OVA, visto = 0 y su duración real
        cursor.execute("""
            INSERT INTO contenidos (
                titulo, clasificacion, episodio, url_final, url_base, dominio, duracion, visto, reproducido
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
        """, (titulo, 'PELICULA_OVA', 1, url, url, 'youtube', duracion))
        
        conn.commit()
        
        # Formateo de duración para que el usuario la entienda (MM:SS)
        minutos = duracion // 60
        segundos = duracion % 60
        print(f"✅ Añadido con éxito: '{titulo}' [{minutos:02d}:{segundos:02d}]")
        
    except Exception as e:
        print(f"❌ Error al guardar en base de datos: {e}")
    finally:
        conn.close()

# ==============================================================================
# INTERFAZ DE CONSOLA (INTERACTIVA)
# ==============================================================================
def main():
    print("====================================================")
    print("📺 YOUTUBE CONTENT ADDER (vía yt-dlp & SQLite)")
    print("====================================================")
    
    keyword = input("\n🔍 ¿Qué quieres buscar en YouTube?: ").strip()
    if not keyword: 
        return

    videos = buscar_en_youtube(keyword)
    if not videos:
        print("❌ No se encontraron resultados en YouTube.")
        return

    print("\n--- RESULTADOS ENCONTRADOS ---")
    for i, v in enumerate(videos, 1):
        minutos = v['duracion'] // 60
        segundos = v['duracion'] % 60
        print(f"{i}. {v['titulo']} [{minutos:02d}:{segundos:02d}]")

    print("\n👉 Selecciona los videos que quieras agendar a la cola:")
    print("   Escribe los números separados por comas (ej: 1,3,5) o ingresa 'S' para agendar todo.")
    
    opcion = input("Selección: ").strip().upper()

    if opcion == 'S':
        print("\n📦 Agendando lista completa...")
        for v in videos:
            agregar_a_db(v['titulo'], v['url'], v['duracion'])
    else:
        try:
            seleccionados = [int(x.strip()) - 1 for x in opcion.split(',')]
            print("\n📦 Procesando selección...")
            for idx in seleccionados:
                if 0 <= idx < len(videos):
                    v = videos[idx]
                    agregar_a_db(v['titulo'], v['url'], v['duracion'])
                else:
                    print(f"⚠️  Índice {idx + 1} fuera de rango. Ignorado.")
        except ValueError:
            print("❌ Entrada inválida. Proceso cancelado.")

if __name__ == "__main__":
    main()