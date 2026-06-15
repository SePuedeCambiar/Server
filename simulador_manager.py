import json
import time
import os

STATE_FILE = "bot_state_test.json"

def lanzar_bot_simulado(con_fix=True):
    print(f"\n--- Iniciando prueba (Fix={con_fix}) ---")
    
    if con_fix:
        print("[Manager] Aplicando FIX: Escribiendo estado 'STARTING'...")
        with open(STATE_FILE, "w") as f:
            json.dump({"estado": "STARTING", "message": "Iniciando navegador..."}, f)
    else:
        print("[Manager] SIN FIX: No escribo nada, dejo que el bot lo haga...")

    # Simulamos el tiempo que tarda Puppeteer en abrirse (3 segundos)
    print("[Manager] Lanzando proceso de Node.js (simulado)...")
    time.sleep(3) 

    # Ahora el "bot" finalmente escribe su primer estado real
    print("[Manager] El bot ya arrancó y escribe 'SELECT_SHOW'...")
    with open(STATE_FILE, "w") as f:
        json.dump({"estado": "SELECT_SHOW", "resultados": [{"text": "Anime 1"}]}, f)

if __name__ == "__main__":
    # PRUEBA 1: Sin el fix (como está ahora tu código)
    lanzar_bot_simulado(con_fix=False)
    
    time.sleep(5) # Pausa para que veas el resultado en la otra consola
    
    # PRUEBA 2: Con el fix
    lanzar_bot_simulado(con_fix=True)