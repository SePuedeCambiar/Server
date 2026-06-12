from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.templating import Jinja2Templates
import sqlite3
import subprocess
import os
import json
import jinja2
import logging

# ==============================================================================
# CONFIGURACIÓN DE LOGS
# ==============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("TV_Manager")

app = FastAPI()

# ==============================================================================
# ESTADO GLOBAL (Control de Procesos)
# ==============================================================================
# Variable para rastrear el proceso del bot y evitar duplicados
bot_process = None

# ==============================================================================
# CONFIGURACIÓN DE CORS Y RUTAS
# ==============================================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"], 
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'playlist.db')
CONFIGS_DIR = os.path.join(BASE_DIR, 'configs')
os.makedirs(CONFIGS_DIR, exist_ok=True)

jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.join(BASE_DIR, 'templates')),
    cache_size=0
)
templates = Jinja2Templates(env=jinja_env)

# ==============================================================================
# HELPERS DE INTERFAZ (Para respuestas coherentes)
# ==============================================================================
def dark_html_response(title, message, is_error=False):
    """Genera una página de respuesta con el estilo Dark del Panel"""
    color = "#cf6679" if is_error else "#03dac6"
    return HTMLResponse(content=f"""
        <html>
            <head>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
                <style>
                    body {{ background-color: #121212; color: white; font-family: sans-serif; text-align: center; padding-top: 100px; }}
                    .card {{ background-color: #1e1e1e; color: white; border: 1px solid #333; display: inline-block; padding: 40px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }}
                    h2 {{ color: {color}; }}
                    .btn-back {{ background-color: #6200ee; color: white; border: none; padding: 10px 20px; border-radius: 5px; text-decoration: none; font-weight: bold; }}
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>{title}</h2>
                    <p class="mb-4">{message}</p>
                    <a href="/" class="btn-back">⬅️ Volver al Panel</a>
                </div>
            </body>
        </html>
    """)

# ==============================================================================
# GESTIÓN DE BASE DE DATOS
# ==============================================================================
def get_db_connection():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        logger.error(f"Error crítico de base de datos: {e}")
        return None

# ==============================================================================
# API PARA LA EXTENSIÓN
# ==============================================================================

@app.get("/api/ping")
async def ping():
    logger.info("📡 Handshake recibido desde la extensión.")
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.post("/api/upload_recipe")
async def upload_recipe(request: Request):
    try:
        data = await request.json()
        dominio = data.get("dominio")
        if not dominio:
            return {"status": "error", "message": "El dominio es obligatorio."}

        file_path = os.path.join(CONFIGS_DIR, f"{dominio}_receta.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        logger.info(f"📥 Receta recibida y guardada para: {dominio}")
        return {"status": "success", "message": f"Receta de {dominio} guardada."}
    except Exception as e:
        logger.error(f"Error procesando receta: {e}")
        return {"status": "error", "message": str(e)}

@app.get("/api/get_last_link")
async def get_last_link():
    conn = get_db_connection()
    if conn:
        try:
            row = conn.execute("SELECT url_final FROM contenidos WHERE url_final IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
            if row:
                return {"url": row['url_final']}
            return {"url": "No se han capturado videos aún."}
        finally:
            conn.close()
    return {"url": "Error de conexión a la base de datos."}

# ==============================================================================
# PANEL DE CONTROL (HTML)
# ==============================================================================

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    conn = get_db_connection()
    if conn:
        try:
            rows = conn.execute("SELECT * FROM contenidos ORDER BY id DESC LIMIT 10").fetchall()
            playlist = [dict(row) for row in rows]
        finally:
            conn.close()
        return templates.TemplateResponse(request, "index.html", {"playlist": playlist})
    return HTMLResponse(content="Error de base de datos", status_code=500)

@app.get("/ver_listas", response_class=HTMLResponse)
async def ver_listas(request: Request):
    conn = get_db_connection()
    if conn:
        try:
            rows = conn.execute("SELECT * FROM contenidos ORDER BY id DESC").fetchall()
            playlist = [dict(row) for row in rows]
        finally:
            conn.close()
        return templates.TemplateResponse(request, "listas.html", {"playlist": playlist})
    return HTMLResponse(content="Error de base de datos", status_code=500)

@app.post("/add_site")
async def add_site(dominio: str = Form(...), nombre: str = Form(...)):
    receta_basica = {
        "dominio": dominio,
        "name": nombre,
        "metadata": {"version": "1.0", "created_by": "panel"}
    }
    with open(os.path.join(CONFIGS_DIR, f"{dominio}_receta.json"), "w") as f:
        json.dump(receta_basica, f, indent=2)
    return RedirectResponse(url="/", status_code=303)

@app.post("/add_content")
async def add_content(request: Request, hora_programada: str = Form(None)):
    """Lanza el reproductor.js con control de procesos para evitar saturar la RAM"""
    global bot_process

    # 1. Verificar si el bot ya se está ejecutando
    if bot_process is not None:
        # poll() devuelve None si el proceso sigue vivo
        if bot_process.poll() is None:
            logger.warning("⚠️ Intento de lanzar el bot mientras ya hay uno activo.")
            return dark_html_response(
                "⚠️ Bot Ocupado", 
                "Ya hay un proceso de captura ejecutándose en segundo plano. Por favor, espera a que termine para lanzar otro.", 
                is_error=True
            )

    # 2. Configuración del entorno
    env = os.environ.copy()

    comando_node = ["node", "reproductor.js"]
    if hora_programada:
        comando_node.append(f"--hora={hora_programada}")

    try:
        # 3. Lanzar el proceso y guardar la referencia
        bot_process = subprocess.Popen(comando_node, env=env)
        logger.info(f"🤖 Bot de captura lanzado exitosamente. PID: {bot_process.pid}. Horario: {hora_programada or 'Cola General'}")

        return dark_html_response(
            "🚀 Bot Iniciado", 
            "El proceso de captura ha sido lanzado en segundo plano. El servidor ahora está navegando y capturando el stream."
        )
    except Exception as e:
        logger.error(f"Error al lanzar el bot: {e}")
        return dark_html_response("❌ Error Interno", f"No se pudo iniciar el proceso: {e}", is_error=True)

@app.get("/delete/{video_id}")
async def delete_video(video_id: int):
    conn = get_db_connection()
    if conn:
        conn.execute("DELETE FROM contenidos WHERE id = ?", (video_id,))
        conn.commit()
        conn.close()
    return RedirectResponse(url="/ver_listas", status_code=303)

# ==============================================================================
# INICIO DEL SERVIDOR
# ==============================================================================
if __name__ == "__main__":
    import uvicorn
    logger.info("🚀 Iniciando TV Manager en puerto 9001...")
    uvicorn.run(app, host="0.0.0.0", port=9001)