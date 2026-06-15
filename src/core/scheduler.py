import sqlite3
import urllib.request
import urllib.parse
import re
import os
from datetime import datetime, timedelta

# ==============================================================================
# CONFIGURACIÓN DE RUTAS DINÁMICAS (Subimos 2 niveles desde src/core/)
# ==============================================================================
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_NAME = os.path.join(BASE_DIR, 'data', 'playlist.db')

# Expiración por defecto del CDN (4 horas)
HORAS_EXPIRACION = 4

# ==============================================================================
# DETECTOR GENÉRICO DE PROTOCÓLO Y DURACIÓN M3U8
# ==============================================================================
def obtener_duracion_manual(url):
    print(f"🔍 Analizando M3U8: {url[:60]}...")
    
    try:
        parsed_url = urllib.parse.urlparse(url)
        referer_dinamico = f"{parsed_url.scheme}://{parsed_url.netloc}/"
    except Exception:
        referer_dinamico = "https://jkanime.net/"

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer_dinamico
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
        print(f"❌ Error decodificando M3U8: {e}")
        return 0

# ==============================================================================
# MIGRACIÓN AUTOMÁTICA DE BASE de DATOS
# ==============================================================================
def mantenimiento_arquitectura():
    """Asegura que la DB tenga todas las columnas necesarias"""
    try:
        # timeout=30 para evitar el error 'database is locked'
        with sqlite3.connect(DB_NAME, timeout=30) as conn:
            cursor = conn.cursor()
            migraciones = [
                ("duracion", "INTEGER DEFAULT 0"),
                ("fecha_captura", "DATETIME DEFAULT CURRENT_TIMESTAMP"),
                ("hora_inicio", "TEXT"),
                ("hora_fin", "TEXT"),
                ("dia", "TEXT"),
                ("visto", "INTEGER DEFAULT 0"),
                ("serie_parent", "TEXT")
            ]

            for columna, tipo in migraciones:
                try:
                    cursor.execute(f"ALTER TABLE contenidos ADD COLUMN {columna} {tipo}")
                    print(f"✅ Columna '{columna}' añadida.")
                except sqlite3.OperationalError:
                    pass  # Ya existe
            conn.commit()
    except Exception as e:
        print(f"❌ Error en mantenimiento de arquitectura: {e}")

# ==============================================================================
# LÓGICA DE MANTENIMIENTO Y AUTO-INCREMENTO
# ==============================================================================
def procesar_autoincremento_y_limpieza():
    """Actualiza duraciones, limpia expirados y analiza progresión de series"""
    try:
        # Usamos context manager 'with' para cerrar la conexión inmediatamente al terminar
        with sqlite3.connect(DB_NAME, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            conn.execute("PRAGMA journal_mode=WAL;")

            # --- PARTE A: Calcular duraciones de video ---
            cursor.execute("SELECT id, url_final FROM contenidos WHERE duracion = 0")
            pendientes_duracion = cursor.fetchall()

            if pendientes_duracion:
                print(f"\n📦 Procesando duración para {len(pendientes_duracion)} videos...")
                for row in pendientes_duracion:
                    id_video, url = row['id'], row['url_final']
                    duracion = obtener_duracion_manual(url)
                    if duracion > 0:
                        cursor.execute("UPDATE contenidos SET duracion = ? WHERE id = ?", (duracion, id_video))
                        print(f"   └─ ID {id_video} -> {duracion}s (Calculado)")
                conn.commit()

            # --- PARTE B: Control de Expiración ---
            punto_corte = (datetime.now() - timedelta(hours=HORAS_EXPIRACION)).strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute("SELECT id, titulo, dominio FROM contenidos WHERE fecha_captura < ? AND visto = 0", (punto_corte,))
            expirados = cursor.fetchall()

            if expirados:
                print(f"\n⚠️  Se detectaron {len(expirados)} URLs expiradas.")
                for exp in expirados:
                    print(f"   [!] ID {exp['id']} | '{exp['titulo']}' -> Requiere re-captura.")
            else:
                print("\n✨ Todos los enlaces en cola están frescos.")

            # --- PARTE C: Archivar Contenido Consumido ---
            cursor.execute("SELECT id, titulo, episodio FROM contenidos WHERE reproducido = 1 AND visto = 0")
            reproducidos_sin_archivar = cursor.fetchall()

            if reproducidos_sin_archivar:
                print(f"\n📦 Archivando contenido consumido...")
                for row in reproducidos_sin_archivar:
                    cursor.execute("UPDATE contenidos SET visto = 1 WHERE id = ?", (row['id'],))
                    print(f"   💾 Archivo -> '{row['titulo']}' (Ep {row['episodio']})")
                conn.commit()

            # --- PARTE D: Algoritmo de Auto-incremento ---
            cursor.execute("""
                SELECT titulo, MAX(episodio) as ultimo_ep, url_base, dominio, serie_parent
                FROM contenidos 
                WHERE clasificacion = 'SERIE' AND visto = 1 
                GROUP BY titulo
            """)
            series_consumidas = cursor.fetchall()

            if series_consumidas:
                print(f"\n📈 Análisis de progresión de series:")
                for serie in series_consumidas:
                    titulo, ultimo_ep = serie['titulo'], serie['ultimo_ep']
                    siguiente_ep = ultimo_ep + 1
                    
                    cursor.execute("SELECT id FROM contenidos WHERE titulo = ? AND episodio = ? AND visto = 0", (titulo, siguiente_ep))
                    if not cursor.fetchone():
                        print(f"   💡 Progresión: '{titulo}' -> Próximo: Ep {siguiente_ep}")
                    else:
                        print(f"   ✅ Ep {siguiente_ep} de '{titulo}' ya está en cola.")

    except Exception as e:
        print(f"❌ Error en procesamiento de limpieza: {e}")

# ==============================================================================
# INICIO DEL SCRIPT
# ==============================================================================
if __name__ == "__main__":
    print("====================================================")
    print("🚀 INICIANDO MANTENIMIENTO Y PLANIFICACIÓN DE PARRILLA")
    print("====================================================")
    mantenimiento_arquitectura()
    procesar_autoincremento_y_limpieza()
    print("\n🏁 Proceso de mantenimiento finalizado con éxito.")