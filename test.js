const { connect } = require('puppeteer-real-browser');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;

async function main() {
    console.log("======================================================");
    console.log("🧠 SMART HAMMER: TEST DE PERSISTENCIA ADAPTATIVA");
    console.log("======================================================");

    const targetUrl = await pregunta("🔗 Pega la URL de la película: ");
    
    const { browser, page } = await connect({
        headless: false,
        args: ["--start-maximized", "--no-sandbox"],
        turnstile: true,
        connectOption: { 
            defaultViewport: { width: 1920, height: 1080 } // FIJO para evitar el error de 'null width'
        }
    });

    page.evaluateOnNewDocument(() => { window.open = () => null; });

    page.on('response', (res) => {
        const url = res.url().toLowerCase();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
            global.videoCapturado = res.url();
            console.log(`\n✨ [SISTEMA] ¡URL DETECTADA!: ${res.url()}`);
        }
    });

    try {
        console.log("\n🚀 Navegando...");
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Espera inicial para que carguen los anuncios
        await new Promise(r => setTimeout(r, 5000));

        const centerX = 1920 / 2;
        const centerY = 1080 / 2;

        console.log("\n🔨 Iniciando ciclo de clicks adaptativos...");
        console.log("Sugerencia: Si ves que el bot hace click y no pasa nada, espera. Si ves un anuncio, el bot lo cerrará en el siguiente click.");

        let clickCount = 0;
        const maxClicks = 20; // Aumentamos el límite para atravesar todas las capas

        while (clickCount < maxClicks && !global.videoCapturado) {
            clickCount++;
            console.log(`🖱️  Intento de disparo #${clickCount}...`);
            
            await page.mouse.click(centerX, centerY);

            // ESPERA DINÁMICA:
            // Después de cada click, esperamos a ver si la red captura la URL.
            // Damos 5 segundos por click para que el "Modo Cine" o la transición ocurra.
            for (let i = 0; i < 5; i++) {
                if (global.videoCapturado) break;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (global.videoCapturado) {
            console.log("\n======================================================");
            console.log("✅ TEST EXITOSO");
            console.log(`La URL fue capturada tras ${clickCount} clicks.`);
            console.log(`URL: ${global.videoCapturado}`);
            console.log("======================================================");
        } else {
            console.log("\n❌ TEST FALLIDO");
            console.log("Se alcanzaron los 20 clicks y no se detectó el stream.");
        }

    } catch (e) {
        console.error(`❌ Error: ${e.message}`);
    } finally {
        await new Promise(r => setTimeout(r, 10000));
        await browser.close();
    }
}

main();