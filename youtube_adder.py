import subprocess
import sqlite3
import json
import os

# --- CONFIGURACIÓN ---
DB_PATH = 'playlist.db'

def buscar_en_youtube(keyword, limite=10):
    print(f"🔍 Buscando '{keyword}' en YouTube vía yt-dlp...")
    
    # Comando para obtener Título e ID del video en formato JSON
    # 'ytsearch' es una funcionalidad nativa de yt-dlp
    comando = [
        "yt-dlp", 
        f"ytsearch{limite}:{keyword}", 
        "--print", "%(title)s||%(id)s", 
        "--no-playlist"
    ]
    
    try:
        resultado = subprocess.run(comando, capture_output=True, text=True, check=True)
        lineas = resultado.stdout.strip().split('\n')
        
        videos = []
        for linea in lineas:
            if "||" in linea:
                titulo, video_id = linea.split("||")
                videos.append({
                    "titulo": titulo,
                    "url": f"https://www.youtube.com/watch?v={video_id}"
                })
        return videos
    except Exception as e:
        print(f"❌ Error en la búsqueda: {e}")
        return []

def agregar_a_db(titulo, url):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Para YouTube, usamos 'youtube' como dominio. 
    # El orquestador ya sabe usar yt-dlp si ve que es un link de YouTube.
    try:
        cursor.execute(
            "INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio) VALUES (?, ?, ?, ?, ?, ?)",
            (titulo, 'PELICULA_OVA', 1, url, url, 'youtube')
        )
        conn.commit()
        print(f"✅ Añadido: {titulo}")
    except Exception as e:
        print(f"❌ Error al guardar en DB: {e}")
    finally:
        conn.close()

def main():
    print("====================================================")
    print("📺 YOUTUBE CONTENT ADDER (vía yt-dlp)")
    print("====================================================")
    
    keyword = input("\n🔍 ¿Qué quieres buscar en YouTube?: ").strip()
    if not keyword: return

    videos = buscar_en_youtube(keyword)
    
    if not videos:
        print("❌ No se encontraron resultados.")
        return

    print("\n--- RESULTADOS ENCONTRADOS ---")
    for i, v in enumerate(videos, 1):
        print(f"{i}. {v['titulo']}")

    print("\n👉 Ingresa los números de los videos que quieras añadir (separados por coma, ej: 1,3,5) o 'S' para todos:")
    opcion = input("Selección: ").strip().upper()

    if opcion == 'S':
        for v in videos:
            agregar_a_db(v['titulo'], v['url'])
    else:
        try:
            seleccionados = [int(x.strip()) - 1 for x in opcion.split(',')]
            for idx in seleccionados:
                if 0 <= idx < len(videos):
                    v = videos[idx]
                    agregar_a_db(v['titulo'], v['url'])
        except ValueError:
            print("❌ Entrada inválida.")

if __name__ == "__main__":
    main()