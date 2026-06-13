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
# 1. CONFIGURACIÓN DE LOGS Y SISTEMA
# ==============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("TV_Manager")

app = FastAPI()

# Control de proceso para evitar saturar la RAM del Celeron
proceso_grabador = None

# Configuración de rutas
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'playlist.db')
CONFIGS_DIR = os.path.join(BASE_DIR, 'configs')
STATE_FILE = os.path.join(CONFIGS_DIR, 'bot_state.json')
os.makedirs(CONFIGS_DIR, exist_ok=True)

# Middleware de CORS para permitir comunicación con la extensión de Chrome
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuración de Plantillas (HTML)
jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.join(BASE_DIR, 'templates')),
    cache_size=0
)
templates = Jinja2Templates(env=jinja_env)

# ==============================================================================
# 2. GESTIÓN DE BASE DE DATOS (Modo WAL para concurrencia)
# ==============================================================================
def get_db_connection():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        logger.error(f"Error de base de datos: {e}")
        return None

# ==============================================================================
# 3. API DE COMUNICACIÓN CON EL BOT Y LA WEB
# ==============================================================================

@app.get("/api/ping")
async def ping():
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.get("/api/sites")
async def get_sites():
    """Devuelve la lista de dominios con recetas cargadas"""
    try:
        archivos = os.listdir(CONFIGS_DIR)
        dominios = [f.replace("_receta.json", "") for f in archivos if f.endswith("_receta.json")]
        return {"sites": dominios}
    except Exception as e:
        return {"sites": [], "error": str(e)}

@app.get("/api/bot_status")
async def bot_status():
    """Lee el archivo de estado del bot para que la web sepa qué mostrar"""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            return {"estado": "ERROR", "message": f"Error leyendo estado: {e}"}
    return {"estado": "IDLE"}

@app.post("/api/bot_answer")
async def bot_answer(request: Request):
    """Recibe la respuesta del usuario desde la web y la escribe para el bot"""
    try:
        data = await request.json()
        respuesta = data.get("respuesta")
        
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
            
            state["respuesta"] = respuesta
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            return {"status": "success"}
        return {"status": "error", "message": "El bot no está activo actualmente."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/upload_recipe")
async def upload_recipe(request: Request):
    """Sube la receta grabada desde la extensión de Chrome"""
    try:
        data = await request.json()
        dominio = data.get("dominio")
        if not dominio: return {"status": "error", "message": "Dominio obligatorio."}
        
        file_path = os.path.join(CONFIGS_DIR, f"{dominio}_receta.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return {"status": "success", "message": f"Receta de {dominio} guardada."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ==============================================================================
#// 4. RUTAS DEL PANEL DE CONTROL (HTML)
#// ==============================================================================

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
async def add_content(
    dominio: str = Form(...), 
    keyword: str = Form(...)
):
    """Lanza el bot de captura interactivo"""
    global proceso_grabador

    # 1. Protección de RAM (Celeron)
    if proceso_grabador is not None:
        proceso_grabador.poll()
        if proceso_grabador.returncode is None:
            return HTMLResponse(content="⚠️ El bot ya está trabajando. Espera a que termine.", status_code=429)

    # 2. Limpiar estado previo antes de iniciar un nuevo bot
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    # 3. Lanzar bot con argumentos necesarios
    env = os.environ.copy()
    env["DISPLAY"] = ":0" # Requerido para Puppeteer aunque sea headless en algunos casos
    
    comando = ["node", "reproductor.js", f"--dominio={dominio}", f"--keyword={keyword}"]
    
    try:
        proceso_grabador = subprocess.Popen(comando, env=env)
        logger.info(f"🤖 Bot interactivo lanzado: {keyword} en {dominio}")
        return HTMLResponse(content="🚀 Bot iniciado. Revisa la consola del panel.", status_code=200)
    except Exception as e:
        logger.error(f"Error lanzando bot: {e}")
        return HTMLResponse(content=f"Error: {e}", status_code=500)

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