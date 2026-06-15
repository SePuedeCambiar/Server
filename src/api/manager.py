from fastapi import FastAPI, Request, Form, Response, Query, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from starlette.templating import Jinja2Templates
import sqlite3
import subprocess
import os
import json
import jinja2
import logging
import requests
import urllib.parse
import secrets
import bcrypt  # <--- Usamos bcrypt directo

# ==============================================================================
# 1. CONFIGURACIÓN DE LOGS Y SEGURIDAD
# ==============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("TV_Manager")

app = FastAPI()

# --- SISTEMA DE SEGURIDAD (BCRYPT DIRECTO) ---
security = HTTPBasic()

def get_password_hash(password: str) -> str:
    """Cifra la contraseña usando bcrypt"""
    pwd_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifica la contraseña contra el hash de la DB"""
    try:
        return bcrypt.checkpw(
            plain_password.encode('utf-8'), 
            hashed_password.encode('utf-8')
        )
    except Exception as e:
        logger.error(f"Error verificando contraseña: {e}")
        return False

def verificar_seguridad(credentials: HTTPBasicCredentials = Depends(security)):
    """Valida el usuario en la base de datos"""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Error de conexión a DB")
    
    try:
        user = conn.execute("SELECT password_hash FROM usuarios WHERE username = ?", (credentials.username,)).fetchone()
        conn.close()

        if user and verify_password(credentials.password, user['password_hash']):
            return credentials.username
        
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas",
            headers={"WWW-Authenticate": "Basic"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error crítico en login: {e}")
        raise HTTPException(status_code=500, detail="Error interno de autenticación")

# Control de proceso para evitar saturar la RAM del Celeron
proceso_grabador = None

# ==============================================================================
# CONFIGURACIÓN DE RUTAS
# ==============================================================================
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(BASE_DIR, 'data', 'playlist.db')
CONFIGS_DIR = os.path.join(BASE_DIR, 'configs')
STATE_FILE = os.path.join(CONFIGS_DIR, 'bot_state.json')
BOT_SCRIPT_PATH = os.path.join(BASE_DIR, 'src', 'bot', 'reproductor.js')

os.makedirs(CONFIGS_DIR, exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.join(BASE_DIR, 'src', 'templates')),
    cache_size=0
)
templates = Jinja2Templates(env=jinja_env)

# ==============================================================================
# 2. GESTIÓN DE BASE DE DATOS (CON SOLUCIÓN A DATABASE LOCKED)
# ==============================================================================
def get_db_connection():
    try:
        # timeout=30 evita el error "database is locked" cuando el scheduler está trabajando
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        logger.error(f"Error de base de datos: {e}")
        return None

def inicializar_usuarios():
    """Crea el usuario admin la primera vez que arranca el servidor"""
    conn = get_db_connection()
    if not conn: return

    try:
        user_exists = conn.execute("SELECT 1 FROM usuarios LIMIT 1").fetchone()
        if not user_exists:
            logger.info("🔑 Creando usuario administrador por defecto...")
            user = "admin"
            password = "admin_password_2024"
            hashed = get_password_hash(password)
            conn.execute("INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?)", 
                         (user, hashed, 'admin'))
            conn.commit()
            logger.info(f"✅ Administrador creado: {user} / {password}")
        else:
            logger.info("✅ Usuarios ya configurados en la base de datos.")
    except Exception as e:
        logger.error(f"❌ Error inicializando usuarios: {e}")
    finally:
        conn.close()

# ==============================================================================
# 3. API DE COMUNICACIÓN
# ==============================================================================

@app.get("/api/ping")
async def ping():
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.get("/api/sites")
async def get_sites(username: str = Depends(verificar_seguridad)):
    try:
        archivos = os.listdir(CONFIGS_DIR)
        dominios = [f.replace("_receta.json", "") for f in archivos if f.endswith("_receta.json")]
        return {"sites": dominios}
    except Exception as e:
        return {"sites": [], "error": str(e)}

@app.get("/api/bot_status")
async def bot_status(username: str = Depends(verificar_seguridad)):
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            return {"estado": "ERROR", "message": f"Error leyendo estado: {e}"}
    return {"estado": "IDLE"}

@app.post("/api/bot_answer")
async def bot_answer(request: Request, username: str = Depends(verificar_seguridad)):
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
        return {"status": "error", "message": "El bot no está activo."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/upload_recipe")
async def upload_recipe(request: Request):
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
# 4. RUTAS DEL PANEL DE CONTROL
# ==============================================================================

@app.get("/", response_class=HTMLResponse)
async def index(request: Request, username: str = Depends(verificar_seguridad)):
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
async def ver_listas(request: Request, username: str = Depends(verificar_seguridad)):
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
    keyword: str = Form(...),
    username: str = Depends(verificar_seguridad)
):
    global proceso_grabador
    if proceso_grabador is not None:
        proceso_grabador.poll()
        if proceso_grabador.returncode is None:
            return HTMLResponse(content="⚠️ El bot ya está trabajando.", status_code=429)

    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"estado": "STARTING", "message": "🤖 Despertando navegador inteligente..."}, f, indent=2)

    env = os.environ.copy()
    comando = ["node", BOT_SCRIPT_PATH, f"--dominio={dominio}", f"--keyword={keyword}"]
    try:
        proceso_grabador = subprocess.Popen(comando, env=env)
        logger.info(f"🤖 Bot lanzado desde {BOT_SCRIPT_PATH}")
        return HTMLResponse(content="🚀 Bot iniciado. Revisa la consola del panel.", status_code=200)
    except Exception as e:
        return HTMLResponse(content=f"Error: {e}", status_code=500)

@app.get("/delete/{video_id}")
async def delete_video(video_id: int, username: str = Depends(verificar_seguridad)):
    conn = get_db_connection()
    if conn:
        conn.execute("DELETE FROM contenidos WHERE id = ?", (video_id,))
        conn.commit()
        conn.close()
    return RedirectResponse(url="/ver_listas", status_code=303)

# ==============================================================================
# 5. PROXY DE-OFUSCADOR DE VIDEO
# ==============================================================================

@app.get("/proxy/manifest.m3u8")
def proxy_manifest(url: str = Query(...), referer: str = Query(...)):
    headers = {"User-Agent": "Mozilla/5.0", "Referer": referer}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code != 200: return Response(content="Error m3u8", status_code=r.status_code)
        lines = r.text.splitlines()
        new_lines = []
        base_url = url.rsplit('/', 1)[0]
        es_subplaylist = False
        for line in lines:
            line_strip = line.strip()
            if not line_strip: continue
            if line_strip.startswith("#EXT-X-STREAM-INF"):
                es_subplaylist = True
                new_lines.append(line)
            elif not line_strip.startswith("#"):
                abs_url = line_strip if line_strip.startswith("http") else f"{base_url}/{line_strip}"
                safe_abs_url = urllib.parse.quote(abs_url, safe='')
                safe_referer = urllib.parse.quote(referer, safe='')
                if es_subplaylist or ".m3u" in abs_url.lower():
                    proxy_url = f"http://localhost:9001/proxy/manifest.m3u8?url={safe_abs_url}&referer={safe_referer}"
                    es_subplaylist = False
                else:
                    proxy_url = f"http://localhost:9001/proxy/segment.ts?url={safe_abs_url}&referer={safe_referer}"
                new_lines.append(proxy_url)
            else:
                new_lines.append(line)
        return Response(content="\n".join(new_lines), media_type="application/vnd.apple.mpegurl")
    except Exception as e:
        return Response(content=str(e), status_code=500)

@app.get("/proxy/segment.ts")
def proxy_segment(url: str = Query(...), referer: str = Query(...)):
    headers = {"User-Agent": "Mozilla/5.0", "Referer": referer}
    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code != 200: return Response(content="Error segment", status_code=r.status_code)
        data = r.content
        start_idx = 0
        for i in range(min(150000, len(data) - 188 * 4)):
            if data[i] == 0x47 and data[i + 188] == 0x47 and data[i + 188 * 2] == 0x47 and data[i + 188 * 3] == 0x47:
                start_idx = i
                break
        return Response(content=data[start_idx:], media_type="video/mp2t")
    except Exception as e:
        return Response(content=str(e), status_code=500)

# ==============================================================================
# INICIO DEL SERVIDOR
# ==============================================================================
if __name__ == "__main__":
    # Ejecutamos la creación del admin antes de iniciar Uvicorn
    inicializar_usuarios()
    logger.info("🚀 Iniciando TV Manager en puerto 9001 con Protección de Login...")
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9001)