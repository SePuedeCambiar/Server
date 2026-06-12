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

# Variable global para evitar lanzar múltiples bots y saturar la RAM del Celeron
proceso_grabador = None

# ==============================================================================
# CONFIGURACIÓN DE SEGURIDAD Y RUTAS
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

# Configuración de plantillas HTML
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
# API PARA EL BOT Y LA EXTENSIÓN (Comunicación)
# ==============================================================================

@app.get("/api/ping")
async def ping():
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.get("/api/sites")
async def get_sites():
    """Devuelve la lista de dominios que tienen una receta cargada"""
    try:
        archivos = os.listdir(CONFIGS_DIR)
        dominios = [f.replace("_receta.json", "") for f in archivos if f.endswith("_receta.json")]
        return {"sites": dominios}
    except Exception as e:
        logger.error(f"Error leyendo recetas: {e}")
        return {"sites": [], "error": str(e)}

@app.get("/api/bot_status")
async def bot_status():
    """Lee el archivo de estado donde el bot deja sus preguntas"""
    state_path = os.path.join(CONFIGS_DIR, "bot_state.json")
    if os.path.exists(state_path):
        with open(state_path, "r") as f:
            return json.load(f)
    return {"estado": "IDLE"}

@app.post("/api/bot_answer")
async def bot_answer(request: Request):
    """Envía la respuesta del usuario al bot a través del archivo de estado"""
    try:
        data = await request.json()
        respuesta = data.get("respuesta")
        state_path = os.path.join(CONFIGS_DIR, "bot_state.json")
        
        if os.path.exists(state_path):
            with open(state_path, "r") as f:
                state = json.load(f)
            
            state["respuesta"] = respuesta
            with open(state_path, "w") as f:
                json.dump(state, f, indent=2)
            return {"status": "success"}
        return {"status": "error", "message": "El bot no está activo"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/upload_recipe")
async def upload_recipe(request: Request):
    """Permite que la extensión de Chrome guarde nuevas recetas"""
    try:
        data = await request.json()
        dominio = data.get("dominio")
        if not dominio: return {"status": "error", "message": "El dominio es obligatorio."}
        file_path = os.path.join(CONFIGS_DIR, f"{dominio}_receta.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return {"status": "success", "message": f"Receta de {dominio} guardada."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/get_last_link")
async def get_last_link():
    conn = get_db_connection()
    if conn:
        try:
            row = conn.execute("SELECT url_final FROM contenidos WHERE url_final IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
            if row: return {"url": row['url_final']}
            return {"url": "No se han capturado videos aún."}
        finally:
            conn.close()
    return {"url": "Error de conexión a la base de datos."}

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
    """
    Lanza el Bot de captura en modo interactivo. 
    El bot se comunicará con el usuario vía /api/bot_status y /api/bot_answer.
    """
    global proceso_grabador

    # PROTECCIÓN DE RAM: No lanzar más de un bot a la vez
    if proceso_grabador is not None:
        proceso_grabador.poll()
        if proceso_grabador.returncode is None:
            return HTMLResponse(content="<h2>⚠️ El Bot ya está trabajando. Espera a que termine.</h2><a href='/'>Volver</a>", status_code=429)

    # Argumentos para el reproductor.js
    comando_node = [
        "node", "reproductor.js",
        f"--dominio={dominio}",
        f"--keyword={keyword}"
    ]

    try:
        # Lanzamos el proceso en segundo plano
        proceso_grabador = subprocess.Popen(comando_node)
        logger.info(f"🤖 Bot de captura lanzado para: {keyword} en {dominio}")
        return HTMLResponse(content="<h2>🚀 Bot Iniciado</h2><p>Mira la consola en el panel para interactuar con el bot.</p><a href='/'>Volver</a>")
    except Exception as e:
        logger.error(f"Error al lanzar el bot: {e}")
        return HTMLResponse(content=f"Error interno: {e}", status_code=500)

@app.post("/add_site")
async def add_site(dominio: str = Form(...), nombre: str = Form(...)):
    receta_basica = {"dominio": dominio, "name": nombre, "metadata": {"version": "1.0"}}
    with open(os.path.join(CONFIGS_DIR, f"{dominio}_receta.json"), "w") as f:
        json.dump(receta_basica, f, indent=2)
    return RedirectResponse(url="/", status_code=303)

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