import urllib.request
import urllib.parse
import os

def analizar_respuesta_bruta(url, referer=None):
    print(f"\n🚀 INICIANDO AUTOPSIA DE URL: {url}")
    print("-" * 60)
    
    if not referer:
        try:
            parsed = urllib.parse.urlparse(url)
            referer = f"{parsed.scheme}://{parsed.netloc}/"
        except:
            referer = "https://cuevana.cz/"

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    }

    try:
        print(f"📡 Enviando petición con Referer: {referer}")
        req = urllib.request.Request(url, headers=headers)
        
        with urllib.request.urlopen(req, timeout=15) as response:
            # 1. Analizar Cabeceras
            print(f"\n✅ RESPUESTA DEL SERVIDOR:")
            print(f"   Status: {response.status}")
            print(f"   Content-Type: {response.info().get_content_type()}")
            
            # 2. Leer contenido
            contenido = response.read().decode('utf-8', errors='ignore')
            
            print("\n--- PRIMEROS 1000 CARACTERES DEL CUERPO ---")
            print(contenido[:1000])
            print("-" * 60)

            # 3. Buscar patrones de video
            print("\n🔍 BUSCANDO PISTAS DE VIDEO EN EL HTML...")
            
            # Buscar enlaces que terminen en .m3u8 o .mp4
            enlaces = re.findall(r'(https?://[^\s"\']+\.(?:m3u8|mp4)[^\s"\']*)', contenido)
            if enlaces:
                print(f"🎯 ¡ENCONTRADOS {len(enlaces)} enlaces de video potenciales!")
                for i, link in enumerate(enlaces, 1):
                    print(f"   {i}. {link}")
            else:
                print("❌ No se encontraron enlaces directos a .m3u8 o .mp4.")

            # Buscar si hay redirecciones en JS (window.location)
            if "window.location" in contenido or "location.replace" in contenido:
                print("⚠️ Detectada redirección mediante JavaScript.")

            # Buscar si es un desafío de Cloudflare
            if "cf-challenge" in contenido or "ray-id" in contenido or "Just a moment" in contenido:
                print("🚨 ALERTA: El servidor ha respondido con un desafío de CLOUDFLARE.")

    except Exception as e:
        print(f"❌ ERROR CRÍTICO DURANTE LA PETICIÓN: {e}")

if __name__ == "__main__":
    import re
    # La URL que falló en tu test
    url_superman = "https://tiktokshopping.xyz/v/rxhm2g9m3et4"
    referer_superman = "https://cuevana.cz/"
    
    analizar_respuesta_bruta(url_superman, referer_superman)