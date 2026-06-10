from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.templating import Jinja2Templates  # importante: desde starlette.templating
from fastapi.staticfiles import StaticFiles
import sqlite3
import subprocess
import os
import json
import jinja2  # importamos jinja2 directamente
from typing import List

app = FastAPI()

# --- Configuración de Jinja2 con caché deshabilitada ---
jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader('templates'),
    cache_size=0  # Evita el error de caché
)
templates = Jinja2Templates(env=jinja_env)

DB_PATH = 'playlist.db'
CONFIGS_DIR = 'configs'

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM contenidos ORDER BY id DESC").fetchall()
    playlist = [dict(row) for row in rows]
    conn.close()
    # 🔥 CORRECCIÓN: request como primer argumento
    return templates.TemplateResponse(request, "index.html", {"request": request, "playlist": playlist})

@app.get("/ver_listas", response_class=HTMLResponse)
async def ver_listas(request: Request):
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM contenidos").fetchall()
    playlist = [dict(row) for row in rows]
    conn.close()
    return templates.TemplateResponse(request, "listas.html", {"request": request, "playlist": playlist})

@app.post("/add_site")
async def add_site(dominio: str = Form(...), nombre: str = Form(...)):
    receta_basica = {
        "dominio": dominio,
        "name": nombre,
        "searchPattern": "/search?q={query}",
        "itemSelector": "a",
        "titleSelector": "span",
        "linkSelector": "a",
        "metadata": {"version": "1.0"}
    }
    os.makedirs(CONFIGS_DIR, exist_ok=True)  # asegura que exista la carpeta
    with open(f"{CONFIGS_DIR}/{dominio}_receta.json", "w") as f:
        json.dump(receta_basica, f, indent=2)
    return RedirectResponse(url="/", status_code=303)

@app.post("/add_content")
async def add_content():
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