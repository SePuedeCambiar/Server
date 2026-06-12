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

# Variable global para controlar el proceso del bot y evitar saturar la RAM del Celeron
proceso_grabador = None

# ==============================================================================
# CONFIGURACIÓN de CORS Y RUTAS
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
# GESTIÓN DE BASE DE DATOS (Modo WAL)
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
# API PARA LA EXTENSIÓN Y EL PANEL
# ==============================================================================

@app.get("/api/ping")
async def ping():
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.get("/api/sites")
async def get_sites():
    """Devuelve la lista de dominios que tienen una receta cargada para el menú desplegable"""
    try:
        archivos = os.listdir(CONFIGS_DIR)
        dominios = [f.replace("_receta.json", "") for f in archivos if f.endswith("_receta.json")]
        return {"sites": dominios}
    except Exception as e:
        logger.error(f"Error leyendo recetas: {e}")
        return {"sites": [], "error": str(e)}

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
async def add_content(
    request: Request, 
    dominio: str = Form(...), 
    keyword: str = Form(...), 
    clasificacion: str = Form("SERIE"), 
    episodio: int = Form(1), 
    hora_programada: str = Form(None)
):
    """
    Recibe los datos del formulario y los pasa como argumentos al bot de Node.js
    """
    global proceso_grabador

    # 1. PROTECCIÓN DE RAM: Verificar si el bot ya está corriendo
    if proceso_grabador is not None:
        proceso_grabador.poll() # Actualiza el estado del proceso
        if proceso_grabador.returncode is None:
            return HTMLResponse(content="""
                <html><body style="font-family:sans-serif; text-align:center; padding-top:50px; background-color:#121212; color:white;">
                <h2 style="color:#cf6679;">⚠️ Bot Ocupado</h2>
                <p>Ya hay una captura en curso. Por favor espera a que termine.</p>
                <a href="/" style="color:#03dac6;">Volver al Panel</a>
                </body></html>
            """, status_code=429)

    # 2. CONSTRUCCIÓN DEL COMANDO PARA el BOT
    # Usamos los flags que el nuevo reproductor.js espera
    comando_node = [
        "node", "reproductor.js",
        f"--dominio={dominio}",
        f"--keyword={keyword}",
        f"--clas={clasificacion}",
        f"--ep={episodio}"
    ]
    
    if hora_programada:
        comando_node.append(f"--hora={hora_programada}")

    try:
        # Lanzamos el proceso en segundo plano
        proceso_grabador = subprocess.Popen(comando_node)
        logger.info(f"🤖 Bot lanzado: {keyword} en {dominio} (Ep: {episodio})")

        return HTMLResponse(content="""
            <html><body style="font-family:sans-serif; text-align:center; padding-top:50px; background-color:#121212; color:white;">
            <h2 style="color:#03dac6;">🚀 Bot Iniciado</h2>
            <p>El bot está buscando y capturando el contenido en segundo plano.</p>
            <a href="/" style="color:#6200ee; text-decoration:none; font-weight:bold;">Volver al Panel</a>
            </body></html>
        """)
    except Exception as e:
        logger.error(f"Error al lanzar el bot: {e}")
        return HTMLResponse(content=f"Error interno: {e}", status_code=500)

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