#!/bin/bash

echo "===================================================="
echo "🚀 INICIANDO INFRAESTRUCTURA DE TV AUTÓNOMA SLIM"
echo "===================================================="

# 1. Asegurar que existe la carpeta de datos
mkdir -p /app/data

# 2. Inicializar base de datos con la arquitectura de bloques y tiempos
python3 -c "
import sqlite3
import os

db_path = '/app/data/playlist.db'
db_exists = os.path.exists(db_path)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

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
conn.commit()
conn.close()

if not db_exists:
    print('📦 Base de datos creada con soporte de tiempos y bloques.')
"

# 3. Lanzar el SCHEDULER (El Cerebro) en un bucle infinito
# Se ejecuta cada 10 minutos para actualizar duraciones y archivar contenido visto
echo "📅 Iniciando Planificador y Mantenimiento (scheduler.py)..."
(while true; do 
    python3 src/core/scheduler.py >> /app/scheduler.log 2>&1
    sleep 600 
done) &

# 4. Lanzar el EMISOR de Vídeo en segundo plano
echo "🎬 Iniciando Motor de Transmisión (emisor.py)..."
python3 src/core/emisor.py > /app/tv_system.log 2>&1 &

# 5. Lanzar el PANEL DE CONTROL (FastAPI) en primer plano
echo "🚀 Iniciando Panel de Control Web (manager.py)..."
echo "===================================================="
exec python3 src/api/manager.py