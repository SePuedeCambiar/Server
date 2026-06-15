
import json
import time
import os

STATE_FILE = "bot_state_test.json"

def polling():
    print("👀 Frontend escuchando cambios en el archivo...")
    while True:
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, "r") as f:
                    state = json.load(f)
                
                estado = state.get("estado")
                
                if estado == "STARTING":
                    print("🔵 [UI] MOSTRANDO SPINNER: 'Inicializando sistema...'")
                elif estado == "SELECT_SHOW":
                    print("🟢 [UI] MOSTRANDO RESULTADOS: 'Selecciona tu anime'")
                elif estado == "IDLE":
                    print("⚪ [UI] MOSTRANDO: 'Sistema en espera'")
                else:
                    print(f"❓ [UI] Estado desconocido: {estado}")
                    
            except Exception as e:
                print(f"Error leyendo: {e}")
        else:
            # ESTO ES LO QUE PASA ACTUALMENTE:
            # Si el archivo no existe o está vacío, la UI asume que no hay nada
            print("🔴 [UI] ERROR/IDLE: No hay bot activo. (Aquí es donde el usuario se confunde)")
        
        time.sleep(1)

if __name__ == "__main__":
    polling()