#!/bin/bash

export DISPLAY=:0

echo "===================================================="
echo "🚀 INICIANDO INFRAESTRUCTURA DE TV AUTÓNOMA v2.1"
echo "===================================================="

# 2. Iniciar Xvfb (Pantalla Virtual)
# Creamos un monitor virtual de 1280x720 con 24 bits de color
Xvfb :0 -screen 0 1280x720x24 &

# Esperamos a que el servidor X realmente esté listo antes de seguir
until xset -q; do
    echo "⏳ Esperando a que Xvfb inicie..."
    sleep 1
done
echo "✅ Xvfb listo."

# 3. Iniciar Fluxbox (Gestor de Ventanas)
# Necesario para que xterm y el navegador se posicionen correctamente
(sleep 2 && fluxbox) &
echo "✅ Fluxbox lanzado."

# 4. Iniciar el servidor VNC
# Permite que x11vnc capture la pantalla :0 y la envíe al puerto 5900
x11vnc -display :0 -nopw -listen localhost -xkb -forever -bg
echo "✅ VNC activo en localhost:5900."

# 5. Iniciar noVNC (Puente Web)
# Convierte el flujo VNC (TCP) en WebSockets para que puedas verlo en el navegador
websockify --web /usr/share/novnc/ 6080 localhost:5900 &
echo "✅ noVNC activo en puerto 6080."

# 6. Lanzar el EMISOR de Vídeo en segundo plano
# Este es el motor que revisa la DB y transmite por RTMP. 
# Redirigimos toda la salida al log para poder debuguear desde 'docker logs' o el archivo .log
echo "🎬 Iniciando Motor de Transmisión (emisor.py)..."
python3 emisor.py > /app/tv_system.log 2>&1 &

# 7. Lanzar el PANEL DE CONTROL (FastAPI) en primer plano
# Usamos 'exec' para que manager.py se convierta en el proceso principal (PID 1) del contenedor.
# Esto asegura que si el panel cae, el contenedor se reinicie, y que reciba las señales de apagado.
echo "🚀 Iniciando Panel de Control Web (manager.py)..."
echo "===================================================="
exec python3 manager.py