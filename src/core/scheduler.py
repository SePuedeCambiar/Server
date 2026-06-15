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
    
    # 🔗 DEDUCCIÓN DE REFERER DINÁMICO (Bug corregido de jkanime)
    try:
        parsed_url = urllib.parse.urlparse(url)
        referer_dinamico = f"{parsed_url.scheme}://{parsed_url.netloc}/"
    except Exception:
        referer_dinamico = "https://jkanime.net/" # Fallback seguro

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer_dinamico
    }
    
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as response:
            contenido = response.read().decode('utf-8', errors='ignore')

        if ".m3u8" in contenido and "#EXT-X-STREAM-INF" in contenido:
            # Es un manifiesto maestro, buscamos la sub-playlist de mayor calidad
            match = re.search(r'(https?://[^\s"\']+\.m3u8)', contenido)
            if match:
                return obtener_duracion_manual(match.group(1))
            return 0

        # Sumar la duración de todos los segmentos (.ts / .image)
        duraciones = re.findall(r'#EXTINF:([0-9.]+)', contenido)
        if not duraciones:
            return 0

        total_segundos = sum(float(d) for d in duraciones)
        return int(total_segundos)
    except Exception as e:
        print(f"❌ Error decodificando M3U8: {e}")
        return 0

# ==============================================================================
# MIGRACIÓN AUTOMÁTICA DE BASE DE DATOS (NUEVA ARQUITECTURA DE BLOQUES)
# ==============================================================================
def mantenimiento_arquitectura():
    """Asegura que la DB tenga todas las columnas para la TV Programada e Historial"""
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # Columnas a asegurar en la tabla 'contenidos'
    migraciones = [
        ("duracion", "INTEGER DEFAULT 0"),
        ("fecha_captura", "DATETIME DEFAULT CURRENT_TIMESTAMP"),
        ("hora_inicio", "TEXT"),           # Parrilla: Hora en formato HH:MM
        ("hora_fin", "TEXT"),              # Parrilla: Hora en formato HH:MM
        ("dia", "TEXT"),                   # Parrilla: Día de emisión (Lunes, Martes, etc.)
        ("visto", "INTEGER DEFAULT 0"),     # Historial: 0 = No visto, 1 = Consumido / Archivo
        ("serie_parent", "TEXT")           # Normalización de Títulos (ej: "Bleach")
    ]

    for columna, tipo in migraciones:
        try:
            cursor.execute(f"ALTER TABLE contenidos ADD COLUMN {columna} {tipo}")
            print(f"✅ Columna '{columna}' añadida correctamente.")
        except sqlite3.OperationalError:
            pass  # La columna ya existe, no hacemos nada

    conn.commit()
    conn.close()

# ==============================================================================
# LÓGICA DE PROGRAMACIÓN DIARIA Y AUTO-INCREMENTO DE CAPÍTULOS
# ==============================================================================
def procesar_autoincremento_y_limpieza():
    """
    1. Calcula duraciones faltantes.
    2. Detecta enlaces de CDN expirados.
    3. Archiva contenidos marcados como reproducidos para limpiar la cola activa.
    4. Auto-incrementa series: Recomienda y agenda el capítulo siguiente.
    """
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # --- PARTE A: Calcular duraciones de video ---
    cursor.execute("SELECT id, url_final FROM contenidos WHERE duracion = 0")
    pendientes_duracion = cursor.fetchall()

    if pendientes_duracion:
        print(f"\n📦 Procesando duración para {len(pendientes_duracion)} videos...")
        for row in pendientes_duracion:
            id_video, url = row
            duracion = obtener_duracion_manual(url)
            if duracion > 0:
                cursor.execute("UPDATE contenidos SET duracion = ? WHERE id = ?", (duracion, id_video))
                conn.commit()
                print(f"   └─ ID {id_video} -> {duracion}s (Calculado)")

    # --- PARTE B: Control de Expiración de Enlaces de CDNs ---
    punto_corte = (datetime.now() - timedelta(hours=HORAS_EXPIRACION)).strftime('%Y-%m-%d %H:%M:%S')
    cursor.execute("SELECT id, titulo, dominio FROM contenidos WHERE fecha_captura < ? AND visto = 0", (punto_corte,))
    expirados = cursor.fetchall()

    if expirados:
        print(f"\n⚠️  Se detectaron {len(expirados)} URLs que han expirado:")
        for exp in expirados:
            print(f"   [!] ID {exp[0]} | '{exp[1]}' ({exp[2]}) -> Requiere re-captura.")
    else:
        print("\n✨ Todos los enlaces en cola están frescos.")

    # --- PARTE C: Archivar Contenido Consumido ---
    # Si 'reproducido' es 1, lo marcamos como 'visto' = 1 para archivarlo de la cola activa
    cursor.execute("SELECT id, titulo, episodio FROM contenidos WHERE reproducido = 1 AND visto = 0")
    reproducidos_sin_archivar = cursor.fetchall()

    if reproducidos_sin_archivar:
        print(f"\n📦 Archivando contenido consumido de la cola...")
        for row in reproducidos_sin_archivar:
            id_video, titulo, ep = row
            cursor.execute("UPDATE contenidos SET visto = 1 WHERE id = ?", (id_video,))
            print(f"   💾 Archivo Histórico -> '{titulo}' (Episodio {ep}) marcado como CONSUMIDO.")
        conn.commit()

    # --- PARTE D: Algoritmo de Auto-incremento de Series ---
    # Buscaremos las series consumidas recientemente para recomendar agendar el siguiente episodio
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
            titulo, ultimo_ep, url_base, dominio, serie_parent = serie
            siguiente_ep = ultimo_ep + 1
            
            # Verificar si el siguiente capítulo ya está en cola
            cursor.execute("""
                SELECT id FROM contenidos 
                WHERE titulo = ? AND episodio = ? AND visto = 0
            """, (titulo, siguiente_ep))
            ya_agendado = cursor.fetchone()

            if not ya_agendado:
                print(f"   💡 Progresión detectada: '{titulo}' -> Último visto: {ultimo_ep}.")
                print(f"      👉 Próximo recomendado: Capítulo {siguiente_ep}.")
                print(f"      👉 Receta lista para ejecutar: node src/bot/reproductor.js --dominio={dominio} --keyword=\"{titulo}\" (Solicitando Ep: {siguiente_ep})")
                # Nota: En el siguiente módulo del gestor podemos automatizar este comando por cron diario
            else:
                print(f"   ✅ Siguiente capítulo ({siguiente_ep}) de '{titulo}' ya se encuentra listo en la cola de reproducción.")

    conn.close()

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