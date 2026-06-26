from fastapi import FastAPI, Request, Form, Response, Query, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
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
import bcrypt
import jwt
from datetime import datetime, timedelta

# ==============================================================================
# 1. CONFIGURACIÓN DE SEGURIDAD Y JWT
# ==============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("TV_Manager")

app = FastAPI()

SECRET_KEY = os.getenv("JWT_SECRET", "super-secret-tv-key-2024-change-me-in-prod")
ALGORITHM = "HS256"
COOKIE_NAME = "access_token"
TOKEN_EXPIRE_HOURS = 24

def get_password_hash(password: str) -> str:
    pwd_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(pwd_bytes, salt).decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(
            plain_password.encode('utf-8'),
            hashed_password.encode('utf-8')
        )
    except Exception as e:
        logger.error(f"Error verificando contraseña: {e}")
        return False

def crear_token_acceso(username: str, rol: str) -> str:
    expiracion = datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {
        "sub": username,
        "rol": rol,
        "exp": expiracion
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def obtener_usuario_actual(request: Request):
    """Dependency para verificar sesión mediante JWT en Cookies"""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return {"username": payload.get("sub"), "rol": payload.get("rol")}
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido o expirado")

def obtener_usuario_ui(request: Request):
    """Devuelve el usuario o redirige al Login si es una ruta web (HTML)"""
    try:
        return obtener_usuario_actual(request)
    except HTTPException:
        raise HTTPException(status_code=303, headers={"Location": "/login"})

# Control de proceso para evitar saturar la RAM
proceso_grabador = None

# ==============================================================================
# CONFIGURACIÓN DE RUTAS Y CONFIGS
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
# GESTIÓN DE BASE DE DATOS
# ==============================================================================
def get_db_connection():
    try:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        logger.error(f"Error de base de datos: {e}")
        return None

def inicializar_usuarios():
    """Crea la tabla de usuarios y el administrador por defecto"""
    conn = get_db_connection()
    if not conn: 
        return
    try:
        # Asegurar tabla de usuarios
        conn.execute('''
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                rol TEXT DEFAULT 'admin'
            )
        ''')
        conn.commit()

        user_exists = conn.execute("SELECT 1 FROM usuarios LIMIT 1").fetchone()
        if not user_exists:
            logger.info("🔑 Creando usuario administrador por defecto...")
            user = "admin"
            password = "admin_password_2024"
            hashed = get_password_hash(password)
            conn.execute("INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?)",
                         (user, hashed, 'admin'))
            conn.commit()
            logger.info(f"✅ Administrador por defecto listo: {user} / {password}")
    except Exception as e:
        logger.error(f"❌ Error inicializando usuarios en DB: {e}")
    finally:
        conn.close()

# ==============================================================================
# RUTAS DE LOGIN Y CONTROL DE ACCESO
# ==============================================================================
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html")

@app.post("/login")
async def login_action(username: str = Form(...), password: str = Form(...)):
    conn = get_db_connection()
    if not conn:
        return RedirectResponse(url="/login?error=error_db", status_code=303)
    
    user = conn.execute("SELECT * FROM usuarios WHERE username = ?", (username,)).fetchone()
    conn.close()

    if user and verify_password(password, user['password_hash']):
        token = crear_token_acceso(username, user['rol'])
        response = RedirectResponse(url="/", status_code=303)
        # Seteamos cookie HttpOnly segura contra ataques XSS
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            httponly=True,
            samesite="lax",
            max_age=TOKEN_EXPIRE_HOURS * 3600
        )
        return response
    
    return RedirectResponse(url="/login?error=credenciales_invalidas", status_code=303)

@app.get("/logout")
async def logout_action():
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(COOKIE_NAME)
    return response

# ==============================================================================
# SISTEMA DE ADMINISTRACIÓN DE USUARIOS (RBAC)
# ==============================================================================
@app.get("/admin/usuarios", response_class=HTMLResponse)
async def admin_users_page(request: Request, user: dict = Depends(obtener_usuario_ui)):
    if user['rol'] != 'admin':
        return HTMLResponse(content="Acceso denegado: Se requiere rol de Admin", status_code=403)
    
    conn = get_db_connection()
    usuarios = []
    if conn:
        usuarios = [dict(row) for row in conn.execute("SELECT id, username, rol FROM usuarios").fetchall()]
        conn.close()
    
    return templates.TemplateResponse(request, "usuarios.html", {"usuarios": usuarios, "current_user": user})

@app.post("/admin/usuarios/crear")
async def create_user(
    username: str = Form(...), 
    password: str = Form(...), 
    rol: str = Form(...), 
    user: dict = Depends(obtener_usuario_actual)
):
    if user['rol'] != 'admin':
        raise HTTPException(status_code=403, detail="No autorizado")
    
    hashed = get_password_hash(password)
    conn = get_db_connection()
    try:
        conn.execute("INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?)", (username, hashed, rol))
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="El nombre de usuario ya existe")
    finally:
        conn.close()
    return RedirectResponse(url="/admin/usuarios", status_code=303)

@app.get("/admin/usuarios/eliminar/{user_id}")
async def delete_user(user_id: int, user: dict = Depends(obtener_usuario_actual)):
    if user['rol'] != 'admin':
        raise HTTPException(status_code=403, detail="No autorizado")
    
    conn = get_db_connection()
    # Evitar que se elimine a sí mismo
    check_user = conn.execute("SELECT username FROM usuarios WHERE id = ?", (user_id,)).fetchone()
    if check_user and check_user['username'] == user['username']:
        conn.close()
        raise HTTPException(status_code=400, detail="No puedes eliminar tu propio usuario actual")
        
    conn.execute("DELETE FROM usuarios WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return RedirectResponse(url="/admin/usuarios", status_code=303)

# ==============================================================================
# API DE COMUNICACIÓN (Endpoints AJAX de UI)
# ==============================================================================
@app.get("/api/ping")
async def ping():
    return {"status": "ok", "message": "Servidor de TV conectado correctamente."}

@app.get("/api/sites")
async def get_sites(user: dict = Depends(obtener_usuario_actual)):
    try:
        archivos = os.listdir(CONFIGS_DIR)
        dominios = [f.replace("_receta.json", "") for f in archivos if f.endswith("_receta.json")]
        return {"sites": dominios}
    except Exception as e:
        return {"sites": [], "error": str(e)}

@app.get("/api/bot_status")
async def bot_status(user: dict = Depends(obtener_usuario_actual)):
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            return {"estado": "ERROR", "message": f"Error leyendo estado: {e}"}
    return {"estado": "IDLE"}

@app.post("/api/bot_answer")
async def bot_answer(request: Request, user: dict = Depends(obtener_usuario_actual)):
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
    # La carga de recetas del sistema principal puede realizarse de forma interna sin auth o con ella
    try:
        data = await request.json()
        dominio = data.get("dominio")
        if not dominio: 
            return {"status": "error", "message": "Dominio obligatorio."}
        file_path = os.path.join(CONFIGS_DIR, f"{dominio}_receta.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return {"status": "success", "message": f"Receta de {dominio} guardada."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ==============================================================================
# RUTAS DEL PANEL DE CONTROL WEB
# ==============================================================================
@app.get("/", response_class=HTMLResponse)
async def index(request: Request, user: dict = Depends(obtener_usuario_ui)):
    conn = get_db_connection()
    playlist = []
    if conn:
        try:
            rows = conn.execute("SELECT * FROM contenidos ORDER BY id DESC LIMIT 10").fetchall()
            playlist = [dict(row) for row in rows]
        finally:
            conn.close()
    return templates.TemplateResponse(request, "index.html", {"playlist": playlist, "user": user})

@app.get("/ver_listas", response_class=HTMLResponse)
async def ver_listas(request: Request, user: dict = Depends(obtener_usuario_ui)):
    conn = get_db_connection()
    playlist = []
    if conn:
        try:
            rows = conn.execute("SELECT * FROM contenidos ORDER BY id DESC").fetchall()
            playlist = [dict(row) for row in rows]
        finally:
            conn.close()
    return templates.TemplateResponse(request, "listas.html", {"playlist": playlist, "user": user})

@app.post("/add_content")
async def add_content(
    dominio: str = Form(...),
    keyword: str = Form(...),
    dia: str = Form(None),
    hora_inicio: str = Form(None),
    hora_fin: str = Form(None),
    user: dict = Depends(obtener_usuario_actual)
):
    if user['rol'] != 'admin':
        return HTMLResponse(content="Acceso denegado: Se requiere rol de Admin", status_code=403)
        
    global proceso_grabador
    if proceso_grabador is not None:
        proceso_grabador.poll()
        if proceso_grabador.returncode is None:
            return HTMLResponse(content="⚠️ El bot ya está trabajando en otra tarea.", status_code=429)

    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"estado": "STARTING", "message": "🤖 Despertando navegador inteligente..."}, f, indent=2)

    env = os.environ.copy()
    comando = ["node", BOT_SCRIPT_PATH, f"--dominio={dominio}", f"--keyword={keyword}"]
    
    # Si viene con programación horaria de bloque
    if dia:
        comando.append(f"--dia={dia}")
    if hora_inicio:
        comando.append(f"--hora={hora_inicio}") # emisor usa '--hora=' para sincronizar
        
    try:
        proceso_grabador = subprocess.Popen(comando, env=env)
        logger.info(f"🤖 Bot lanzado desde {BOT_SCRIPT_PATH} para {keyword}")
        return HTMLResponse(content="🚀 Bot iniciado. Revisa la consola del panel.", status_code=200)
    except Exception as e:
        return HTMLResponse(content=f"Error: {e}", status_code=500)

@app.get("/delete/{video_id}")
async def delete_video(video_id: int, user: dict = Depends(obtener_usuario_ui)):
    if user['rol'] != 'admin':
        return HTMLResponse(content="No autorizado", status_code=403)
        
    conn = get_db_connection()
    if conn:
        conn.execute("DELETE FROM contenidos WHERE id = ?", (video_id,))
        conn.commit()
        conn.close()
    return RedirectResponse(url="/ver_listas", status_code=303)

# ==============================================================================
# PROXY DE-OFUSCADOR DE VIDEO (CON CORRECCIONES DE OPERADORES)
# ==============================================================================
@app.get("/proxy/manifest.m3u8")
def proxy_manifest(url: str = Query(...), referer: str = Query(...)):
    headers = {"User-Agent": "Mozilla/5.0", "Referer": referer}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code != 200: 
            return Response(content="Error m3u8", status_code=r.status_code)
        lines = r.text.splitlines()
        new_lines = []
        base_url = url.rsplit('/', 1)[0]
        es_subplaylist = False
        for line in lines:
            line_strip = line.strip()
            if not line_strip: 
                continue
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
        if r.status_code != 200: 
            return Response(content="Error segment", status_code=r.status_code)
        data = r.content
        start_idx = 0
        # CORREGIDO: Se corrigieron los operadores rotos de su código original '_2' y '_ 3' por multiplicación de enteros
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
    inicializar_usuarios()
    logger.info("🚀 Iniciando TV Manager en puerto 9001...")
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9001)