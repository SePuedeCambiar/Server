import sqlite3
import os
import sys

# Importamos la configuración y la función de hash desde manager
try:
    from manager import get_password_hash, BASE_DIR
except ImportError:
    # Esto es para que funcione si se ejecuta desde la raíz del proyecto
    sys.path.append(os.path.join(os.path.dirname(__file__), '..', '..'))
    from manager import get_password_hash, BASE_DIR

def crear_admin_inicial():
    # Aseguramos que la ruta a la DB sea la correcta
    db_path = os.path.join(BASE_DIR, 'data', 'playlist.db')
    
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        # Usuario y clave por defecto
        user = "admin"
        password = "admin_password_2024"
        hashed = get_password_hash(password)

        # Intentamos insertar el usuario
        cursor.execute("INSERT INTO usuarios (username, password_hash, rol) VALUES (?, ?, ?)", 
                       (user, hashed, 'admin'))
        conn.commit()
        print(f"✅ Usuario administrador creado con éxito: {user} / {password}")
    except sqlite3.IntegrityError:
        print("ℹ️ El usuario administrador ya existe en la base de datos.")
    except Exception as e:
        print(f"❌ Error crítico al crear admin: {e}")
    finally:
        if 'conn' in locals():
            conn.close()

if __name__ == "__main__":
    crear_admin_inicial()