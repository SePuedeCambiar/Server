#!/bin/bash

echo "===================================================="
echo "🚀 INICIANDO INFRAESTRUCTURA DE TV AUTÓNOMA SLIM"
echo "===================================================="

# Ya no necesitamos Xvfb, Fluxbox, VNC ni noVNC.
# El bot correrá en modo headless directamente.

# 1. Lanzar el EMISOR de Vídeo en segundo plano
echo "🎬 Iniciando Motor de Transmisión (emisor.py)..."
python3 emisor.py > /app/tv_system.log 2>&1 &

# 2. Lanzar el PANEL DE CONTROL (FastAPI) en primer plano
echo "🚀 Iniciando Panel de Control Web (manager.py)..."
echo "===================================================="
exec python3 manager.py