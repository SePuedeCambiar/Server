import sqlite3
import subprocess
import re

def obtener_duracion(url):
    print(f"🔍 Analizando duración de: {url[:60]}...")
    try:
        # Comando ffprobe para obtener la duración en segundos
        comando = [
            "ffprobe", "-v", "error", 
            "-show_entries", "format=duration", 
            "-of", "default=noprint_wrappers=1:nokey=1", 
            "-i", url
        ]
        resultado = subprocess.run(comando, capture_output=True, text=True, timeout=30)
        
        if resultado.returncode == 0:
            # El resultado es un float (ej: 1234.567), lo convertimos a entero
            return int(float(resultado.stdout.strip()))
    except Exception as e:
        print(f"❌ Error analizando {url}: {e}")
    return 0

def actualizar_base_de_datos():
    conn = sqlite3.connect('playlist.db')
    cursor = conn.cursor()

    # Buscamos todos los contenidos que aún no tienen duración calculada
    cursor.execute("SELECT id, url_final FROM contenidos WHERE duracion = 0")
    pendientes = cursor.fetchall()

    if not pendientes:
        print("✅ Todos los contenidos ya tienen duración calculada.")
        return

    print(f"📦 Se encontraron {len(pendientes)} videos para analizar.")

    for row in pendientes:
        id_video, url = row
        duracion = obtener_duracion(url)
        
        if duracion > 0:
            cursor.execute("UPDATE contenidos SET duracion = ? WHERE id = ?", (duracion, id_video))
            conn.commit()
            print(f"✅ Video {id_video} guardado: {duracion} segundos.")
        else:
            print(f"⚠️ No se pudo obtener duración para el video {id_video}.")

    conn.close()
    print("\n✨ Proceso de análisis completado.")

if __name__ == "__main__":
    actualizar_base_de_datos()