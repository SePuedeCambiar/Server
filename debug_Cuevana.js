const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

async function main() {
    console.log("======================================================");
    console.log("🔨 IFRAME HUNTER: BUSCADOR AGRESIVO DE REPRODUCTOR");
    console.log("======================================================");

    const targetUrl = await pregunta("🔗 Pega la URL de la película: ");
    
    const { browser, page } = await connect({
        headless: false,
        args: ["--start-maximized", "--no-sandbox"],
        turnstile: true,
        connectOption: { defaultViewport: null }
    });

    page.evaluateOnNewDocument(() => { window.open = () => null; });

    try {
        console.log("\n🚀 Navegando...");
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log("⏳ Esperando 5 segundos para que la página se asiente...");
        await new Promise(r => setTimeout(r, 5000));

        // 1. Buscamos todos los elementos que podrían ser el botón de Play
        const candidates = await page.evaluate(() => {
            const results = [];
            // Buscamos por clases, IDs y texto
            document.querySelectorAll('*').forEach(el => {
                const text = el.innerText?.toLowerCase() || "";
                const className = el.className?.toString().toLowerCase() || "";
                const id = el.id?.toLowerCase() || "";
                
                if (text.includes('play') || className.includes('play') || id.includes('play') || el.tagName === 'VIDEO') {
                    results.push({
                        tag: el.tagName,
                        id: el.id,
                        class: el.className,
                        text: text.trim().substring(0, 20)
                    });
                }
            });
            return results;
        });

        console.log(`🎯 Se encontraron ${candidates.length} candidatos a botón de Play.`);

        let iframeEncontrado = false;
        for (let i = 0; i < candidates.length; i++) {
            const cand = candidates[i];
            console.log(`\nTentando candidato #${i}: <${cand.tag}> class="${cand.class}"`);

            try {
                // Intentamos hacer click usando un selector basado en su clase e ID
                const selector = cand.id ? `#${cand.id}` : (cand.class ? `.${cand.class.split(' ').join('.')}` : 'body');
                await page.click(selector).catch(() => {});
                
                // Esperamos a ver si el número de frames aumenta
                for (let j = 0; j < 5; j++) {
                    await new Promise(r => setTimeout(r, 1000));
                    if (page.frames().length > 1) {
                        console.log("✅ ¡BINGO! El click disparó la inyección del reproductor.");
                        iframeEncontrado = true;
                        break;
                    }
                }
            } catch (e) {
                console.log(`   ⚠️ Falló click en candidato #${i}`);
            }
            if (iframeEncontrado) break;
        }

        if (iframeEncontrado) {
            console.log("\n🎉 ÉXITO: El reproductor ya está cargado. Ahora podemos usar la extracción profunda.");
        } else {
            console.log("\n❌ FALLO: Ningún elemento disparó la inyección del iframe.");
        }

    } catch (e) {
        console.error(`❌ Error crítico: ${e.message}`);
    } finally {
        console.log("\nCerrando en 10 segundos...");
        await new Promise(r => setTimeout(r, 10000));
        await browser.close();
    }
}

main();