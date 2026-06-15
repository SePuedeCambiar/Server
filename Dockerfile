# 1. Usamos Debian Stable Slim para minimizar el consumo de RAM y Disco
FROM debian:stable-slim

# Evitar preguntas interactivas durante la instalación
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

# 2. Instalar dependencias esenciales del sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl ffmpeg wget ca-certificates \
    xvfb \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libasound2 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 3. Instalar Google Chrome Stable oficial (Requerido para bypass de Cloudflare)
RUN wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    apt-get update && apt-get install -y ./google-chrome-stable_current_amd64.deb && \
    rm google-chrome-stable_current_amd64.deb

# 4. Instalar Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Crear la carpeta de trabajo
WORKDIR /app

# Copiar todos los archivos al contenedor
COPY . /app

# 5. Configuración del entorno virtual de Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir fastapi uvicorn jinja2 python-multipart requests passlib PyJWT

# 6. Instalación de dependencias de Node.js
RUN npm install puppeteer-real-browser better-sqlite3

# Asegurar que el script de inicio sea ejecutable
RUN chmod +x start.sh

# Exponer el puerto del Panel de Control
EXPOSE 9001

# Ejecutar el director de orquesta mediante el script de arranque
CMD ["./start.sh"]