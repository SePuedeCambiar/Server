import sqlite3
import urllib.request
import re
from datetime import datetime, timedelta

# --- CONFIGURACIÓN ---
DB_NAME = 'playlist.db'
# Definimos que una URL expira después de 4 horas (ajustable)
HORAS_EXPIRACION = 4

def obtener_duracion_manual(url):
    print(f"🔍 Analizando M3U8: {url[:60]}...")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://jkanime.net/'
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as response:
            contenido = response.read().decode('utf-8', errors='ignore')

        if ".m3u8" in contenido and "#EXT-X-STREAM-INF" in contenido:
            match = re.search(r'(https?://[^\s"\']+\.m3u8)', contenido)
            if match:
                return obtener_duracion_manual(match.group(1))
            return 0

        duraciones = re.findall(r'#EXTINF:([0-9.]+)', contenido)
        if not duraciones:
            return 0

        total_segundos = sum(float(d) for d in duraciones)
        return int(total_segundos)
    except Exception as e:
        print(f"❌ Error descargando M3U8: {e}")
        return 0

def mantenimiento_arquitectura():
    """Asegura que la DB tenga todas las columnas necesarias para la nueva arquitectura"""
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # 1. Asegurar columna 'duracion'
    try:
        cursor.execute("ALTER TABLE contenidos ADD COLUMN duracion INTEGER DEFAULT 0")
        print("✅ Columna 'duracion' añadida.")
    except sqlite3.OperationalError:
        pass # Ya existe

    # 2. Asegurar columna 'fecha_captura' (Crucial para la expiración)
    try:
        # Usamos DATETIME para guardar la fecha y hora exacta de la captura
        cursor.execute("ALTER TABLE contenidos ADD COLUMN fecha_captura DATETIME DEFAULT CURRENT_TIMESTAMP")
        print("✅ Columna 'fecha_captura' añadida.")
    except sqlite3.OperationalError:
        pass # Ya existe

    conn.commit()
    conn.close()

def actualizar_datos_y_limpiar():
    """Calcula duraciones y detecta URLs expiradas"""
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # --- PARTE A: Actualizar Duraciones (Tu lógica original) ---
    cursor.execute("SELECT id, url_final FROM contenidos WHERE duracion = 0")
    pendientes_duracion = cursor.fetchall()

    if pendientes_duracion:
        print(f"📦 Calculando duración para {len(pendientes_duracion)} videos...")
        for row in pendientes_duracion:
            id_video, url = row
            duracion = obtener_duracion_manual(url)
            if duracion > 0:
                cursor.execute("UPDATE contenidos SET duracion = ? WHERE id = ?", (duracion, id_video))
                conn.commit()
                print(f"✅ Video {id_video} -> {duracion}s")

    # --- PARTE B: Análisis de Expiración ---
    # Calculamos el punto de corte (Hora actual menos X horas)
    punto_corte = (datetime.now() - timedelta(hours=HORAS_EXPIRACION)).strftime('%Y-%m-%d %H:%M:%S')

    cursor.execute("SELECT id, titulo FROM contenidos WHERE fecha_captura < ?", (punto_corte,))
    expirados = cursor.fetchall()

    if expirados:
        print(f"\n⚠️  Se detectaron {len(expirados)} URLs expiradas.")
        for exp in expirados:
            print(f"   ID {exp[0]} [{exp[1]}] -> Requiere refresco de URL.")
    else:
        print("\n✨ Todas las URLs están frescas.")

    conn.close()

if __name__ == "__main__":
    print("🚀 Iniciando Mantenimiento de Base de Datos...")
    mantenimiento_arquitectura()
    actualizar_datos_y_limpiar()
    print("\n🏁 Proceso completado.")