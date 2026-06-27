import subprocess
import json

def test_youtube_search(query):
    print(f"🔍 Probando búsqueda de YouTube para: {query}")
    
    # Intentamos 3 variaciones del comando para ver cuál funciona
    comandos = [
        # Variante 1: El que tenemos en manager.py
        ["yt-dlp", f"ytsearch10:{query}", "--print", "%(title)s||%(id)s||%(duration)s", "--no-playlist"],
        
        # Variante 2: Formato JSON (Más robusto y moderno)
        ["yt-dlp", f"ytsearch10:{query}", "--dump-json", "--flat-playlist"],
        
        # Variante 3: Formato simple de títulos
        ["yt-dlp", f"ytsearch10:{query}", "--get-title", "--get-id"]
    ]

    for i, cmd in enumerate(comandos, 1):
        print(f"\n--- Probando Variante #{i} ---")
        try:
            print(f"Ejecutando: {' '.join(cmd)}")
            resultado = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            if resultado.returncode == 0:
                print("✅ COMANDO EXITOSO")
                print("Salida:\n", resultado.stdout)
                if resultado.stdout.strip():
                    print("✨ El comando devolvió datos.")
                    return True
                else:
                    print("⚠️ El comando funcionó pero la salida está VACÍA.")
            else:
                print(f"❌ ERROR ({resultado.returncode}): {resultado.stderr}")
        except Exception as e:
            print(f"❌ EXCEPCIÓN: {e}")

    return False

if __name__ == "__main__":
    keyword = input("Introduce una palabra clave para probar (ej: hunter): ")
    exito = test_youtube_search(keyword)
    if not exito:
        print("\n🚩 CONCLUSIÓN: yt-dlp no está devolviendo resultados. Es probable que necesite actualizarse o que YouTube esté bloqueando la IP del contenedor.")