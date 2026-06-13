#!/bin/bash

echo "===================================================="
echo "🚀 INICIANDO INFRAESTRUCTURA DE TV AUTÓNOMA SLIM"
echo "===================================================="

# 1. Asegurar que existe la carpeta de datos
mkdir -p /app/data

# 2. Inicializar base de datos de manera automática si no existe
python3 -c "
import sqlite3
import os

db_path = '/app/data/playlist.db'
db_exists = os.path.exists(db_path)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Crear la tabla si es nueva o se borró
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
    fecha_captura DATETIME DEFAULT CURRENT_TIMESTAMP
);
''')
conn.commit()
conn.close()

if not db_exists:
    print('📦 Base de datos e índices creados correctamente por primera vez.')
"

# 3. Lanzar el EMISOR de Vídeo en segundo plano
echo "🎬 Iniciando Motor de Transmisión (emisor.py)..."
python3 emisor.py > /app/tv_system.log 2>&1 &

# 4. Lanzar el PANEL DE CONTROL (FastAPI) en primer plano
echo "🚀 Iniciando Panel de Control Web (manager.py)..."
echo "===================================================="
exec python3 manager.py