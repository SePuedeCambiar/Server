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

# Variable global para evitar múltiples instancias del bot en el Celeron
proceso_grabador = None

# ==============================================================================
# CONFIGURACIÓN DE RUTAS Y CORS
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
STATE_FILE = os.path.join(CONFIGS_DIR, 'bot_state.json') # Archivo de comunicación
os.makedirs(CONFIGS_DIR, exist_ok=True)

jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.join(BASE_DIR, 'templates')),
    cache_size=0
)
templates = Jinja2Templates(env=jinja_env)

# ==============================================================================
# GESTIÓN DE BASE DE DATOS (Modo WAL para concurrencia)
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
# ENDPOINTS DE COMUNICACIÓN CON EL BOT (EL "PUENTE")
# ==============================================================================

@app.get("/api/bot_status")
async def bot_status():
    """Lee el archivo JSON donde el bot escribe sus preguntas"""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error leyendo bot_state.json: {e}")
            return {"estado": "ERROR", "message": "Error leyendo estado"}
    return {"estado": "IDLE"}

@app.post("/api/bot_answer")
async def bot_answer(request: Request):
    """Escribe la respuesta del usuario en el JSON para que el bot la lea"""
    try:
        data = await request.json()
        respuesta = data.get("respuesta")
        
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
            
            state["respuesta"] = respuesta # Inyectamos la respuesta
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            
            logger.info(f"📩 Respuesta enviada al bot: {respuesta}")
            return {"status": "success"}
        
        return {"status": "error", "message": "Bot no activo o archivo de estado no encontrado"}
    except Exception as e:
        logger.error(f"Error enviando respuesta: {e}")
        return {"status": "error", "message": str(e)}

# ==============================================================================
# API PARA LA EXTENSIÓN Y GESTIÓN DE SITIOS
# ==============================================================================

@app.get("/api/ping")
async def ping():
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.get("/api/sites")
async def get_sites():
    """Devuelve los dominios con recetas cargadas"""
    try:
        archivos = os.listdir(CONFIGS_DIR)
        dominios = [f.replace("_receta.json", "") for f in archivos if f.endswith("_receta.json")]
        return {"sites": dominios}
    except Exception as e:
        return {"sites": [], "error": str(e)}

@app.post("/api/upload_recipe")
async def upload_recipe(request: Request):
    try:
        data = await request.json()
        dominio = data.get("dominio")
        if not dominio: return {"status": "error", "message": "Dominio obligatorio"}
        
        file_path = os.path.join(CONFIGS_DIR, f"{dominio}_receta.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return {"status": "success", "message": f"Receta de {dominio} guardada."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ==============================================================================
# RUTAS DEL PANEL DE CONTROL (HTML)
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

@app.post("/add_content")
async def add_content(dominio: str = Form(...), keyword: str = Form(...)):
    """Lanza el bot interactivo en segundo plano"""
    global proceso_grabador

    # Protección de RAM Celeron
    if proceso_grabador is not None:
        proceso_grabador.poll()
        if proceso_grabador.returncode is None:
            return HTMLResponse(content="<h2>⚠️ Bot Ocupado</h2><p>Espera a que termine la captura actual.</p><a href='/'>Volver</a>", status_code=429)

    # Limpiar estado anterior antes de empezar
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    env = os.environ.copy()
    env["DISPLAY"] = ":0"

    # Lanzamos el bot con los argumentos básicos. El resto se maneja vía JSON.
    comando_node = ["node", "reproductor.js", f"--dominio={dominio}", f"--keyword={keyword}"]

    try:
        proceso_grabador = subprocess.Popen(comando_node, env=env)
        logger.info(f"🤖 Bot interactivo lanzado para: {keyword}")
        return HTMLResponse(content="<h2>🚀 Bot Iniciado</h2><p>Mira la consola en el panel para interactuar con el bot.</p><a href='/'>Volver</a>")
    except Exception as e:
        logger.error(f"Error lanzando bot: {e}")
        return HTMLResponse(content=f"Error: {e}", status_code=500)

@app.get("/delete/{video_id}")
async def delete_video(video_id: int):
    conn = get_db_connection()
    if conn:
        conn