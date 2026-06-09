from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import sqlite3
import subprocess
import os
from typing import List

app = FastAPI()
templates = Jinja2Templates(directory="templates")

DB_PATH = 'playlist.db'
CONFIGS_DIR = 'configs'

# --- FUNCIONES DE APOYO ---
def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ==============================================================================
# RUTAS DE LA INTERFAZ (FRONTEND)
# ==============================================================================

@app.get("/", response_class=HTMLResponse)
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    conn = get_db_connection()
    # 1. Obtenemos las filas
    rows = conn.execute("SELECT * FROM contenidos ORDER BY id DESC").fetchall()
    # 🚀 CORRECCIÓN: Convertimos cada sqlite3.Row en un dict real de Python
    playlist = [dict(row) for row in rows]
    conn.close()
    return templates.TemplateResponse("index.html", {"request": request, "playlist": playlist})

@app.get("/ver_listas", response_class=HTMLResponse)
async def ver_listas(request: Request):
    conn = get_db_connection()
    # 1. Obtenemos las filas
    rows = conn.execute("SELECT * FROM contenidos").fetchall()
    # 🚀 CORRECCIÓN: Convertimos cada sqlite3.Row en un dict real de Python
    playlist = [dict(row) for row in rows]
    conn.close()
    return templates.TemplateResponse("listas.html", {"request": request, "playlist": playlist})
# ==============================================================================
# RUTAS DE ACCIÓN (BACKEND)
# ==============================================================================

@app.post("/add_site")
async def add_site(dominio: str = Form(...), nombre: str = Form(...)):
    # Crea un archivo de receta básico en la carpeta configs
    receta_basica = {
        "dominio": dominio,
        "name": nombre,
        "searchPattern": "/search?q={query}",
        "itemSelector": "a",
        "titleSelector": "span",
        "linkSelector": "a",
        "metadata": {"version": "1.0"}
    }
    with open(f"{CONFIGS_DIR}/{dominio}_receta.json", "w") as f:
        import json
        json.dump(receta_basica, f, indent=2)
    
    return RedirectResponse(url="/", status_code=303)

@app.post("/add_content")
async def add_content():
    # 🚀 ESTA ES LA PARTE DIFÍCIL: Lanzar el grabador
    # Como el servidor es headless, lanzamos el reproductor en modo interactivo 
    # pero en la terminal del servidor. 
    # Para una versión pro, esto debería ser una API que devuelve resultados al navegador.
    subprocess.Popen(["node", "reproductor.js"]) 
    return {"status": "Grabador iniciado en la terminal del servidor"}

@app.get("/delete/{video_id}")
async def delete_video(video_id: int):
    conn = get_db_connection()
    conn.execute("DELETE FROM contenidos WHERE id = ?", (video_id,))
    conn.commit()
    conn.close()
    return RedirectResponse(url="/ver_listas", status_code=303)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9001)