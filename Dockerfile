# Usamos Ubuntu como base sólida
FROM ubuntu:22.04

# Evitar preguntas interactivas durante la instalación
ENV DEBIAN_FRONTEND=noninteractive

# 1. Instalar dependencias esenciales del sistema, herramientas de video y wget/ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl ffmpeg wget ca-certificates chromium \
    # Librerías mínimas para que Chromium arranque en modo headless
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
# 2. Descargar e instalar Google Chrome Stable oficial de Google (REQUERIDO para puppeteer-real-browser)
RUN wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    apt-get update && apt-get install -y ./google-chrome-stable_current_amd64.deb && \
    rm google-chrome-stable_current_amd64.deb

# 3. Instalar Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Crear la carpeta de trabajo
WORKDIR /app

# Copiar todos tus archivos al contenedor
COPY . /app

# Instalar dependencias de Python
RUN pip3 install fastapi uvicorn jinja2 python-multipart requests

# Instalar dependencias de Node
RUN npm install puppeteer-real-browser better-sqlite3

# Asegurar que el script de inicio es ejecutable
RUN chmod +x start.sh

# Exponer los puertos (9001 FastAPI, 6080 noVNC)
EXPOSE 9001 6080

# Ejecutar el director de orquesta al iniciar
CMD ["./start.sh"]