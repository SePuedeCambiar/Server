#!/bin/bash

echo "===================================================="
echo "🚀 INICIANDO INFRAESTRUCTURA DE TV AUTÓNOMA SLIM"
echo "===================================================="

# 1. Asegurar que existan las carpetas necesarias
mkdir -p /app/data
mkdir -p /app/configs

# 2. Inicializar base de datos con la arquitectura completa
# Creamos las tablas de contenidos y usuarios antes de lanzar cualquier servicio
python3 -c "
import sqlite3
import os

db_path = '/app/data/playlist.db'
db_exists = os.path.exists(db_path)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Tabla de contenidos (Parrilla, videos y programación)
cursor.execute('''
CREATE TABLE IF NOT EXISTS contenidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    clasificacion TEXT,
    episodio INTEGER,
    url_final TEXT,
    url_base TEXT,
    dominio TEXT,
    hora_programada TEXT,
    reproducido INTEGER DEFAULT 0,
    duracion INTEGER DEFAULT 0,
    fecha_captura DATETIME DEFAULT CURRENT_TIMESTAMP,
    hora_inicio TEXT,
    hora_fin TEXT,
    dia TEXT,
    visto INTEGER DEFAULT 0,
    serie_parent TEXT
);
''')

# Tabla de usuarios (Seguridad y Login)
cursor.execute('''
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    rol TEXT DEFAULT 'admin'
);
''')

conn.commit()
conn.close()

if not db_exists:
    print('📦 Base de datos creada desde cero con soporte de usuarios y bloques.')
else:
    print('✅ Base de datos detectada. Verificando estructura...')
"

# 3. Lanzar el SCHEDULER (El Cerebro)
# Redirigimos la salida a /proc/1/fd/1 para que aparezca en 'docker compose logs'
echo "📅 Iniciando Planificador y Mantenimiento (scheduler.py)..."
(while true; do 
    python3 src/core/scheduler.py > /proc/1/fd/1 2>&1
    sleep 600 
done) &

# 4. Lanzar el EMISOR de Vídeo en segundo plano
# Redirigimos la salida a /proc/1/fd/1 para ver errores de FFmpeg en la consola de Docker
echo "🎬 Iniciando Motor de Transmisión (emisor.py)..."
python3 src/core/emisor.py > /proc/1/fd/1 2>&1 &

# 5. Lanzar el PANEL DE CONTROL (FastAPI) en primer plano
# El manager.py ahora ejecuta internamente la función 'inicializar_usuarios()'
echo "🚀 Iniciando Panel de Control Web (manager.py)..."
echo "===================================================="
exec python3 src/api/manager.py