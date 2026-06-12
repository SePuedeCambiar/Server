const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database('playlist.db');
db.pragma('journal_mode = WAL');

// ============================================================================
// SISTEMA de COMUNICACIÓN CON EL PANEL WEB
// ============================================================================
const STATE_FILE = path.join(__dirname, 'configs', 'bot_state.json');

async function enviarEstado(estado, datos = {}) {
    const payload = { estado, ...datos, timestamp: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

async function esperarRespuesta(preguntaTexto) {
    console.log(`⏳ Esperando respuesta para: ${preguntaTexto}`);
    await enviarEstado('AWAITING_RESPONSE', { pregunta: preguntaTexto });

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            if (fs.existsSync(STATE_FILE)) {
                const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                if (state.respuesta !== undefined) {
                    const resp = state.respuesta;
                    clearInterval(interval);
                    // Limpiamos la respuesta para no leer la misma dos veces
                    const newState = { ...state, respuesta: undefined };
                    fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
                    resolve(resp);
                }
            }
        }, 1000);
    });
}

// ============================================================================
// LÓGICA DE NAVEGACIÓN (Casi igual a la original)
// ============================================================================
async function esperarBypass(page) {
    for (let i = 0; i < 20; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            if (!titulo.toLowerCase().includes('just a moment') && !url.includes('challenges.cloudflare.com')) {
                return true;
            }
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {}
    }
    return false;
}

async function activarVideoSandbox(page) {
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video'];
    const startTime = Date.now();
    while (Date.now() - startTime < 20000) {
        if (global.videoCapturado) return true;
        const frames = page.frames();
        for (const frame of frames) {
            for (const selector of playSelectors) {
                try {
                    const el = await frame.$(selector);
                    if (el) {
                        await frame.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
                        await new Promise(r => setTimeout(r, 2000));
                        if (global.videoCapturado) return true;
                    }
                } catch (e) {}
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

// ============================================================================
// ORQUESTADOR FINAL
// ============================================================================
async function main() {
    const args = process.argv.slice(2);
    const ARG_DOMINIO = args.find(arg => arg.startsWith('--dominio='))?.split('=')[1];
    const ARG_KEYWORD = args.find(arg => arg.startsWith('--keyword='))?.split('=')[1];

    if (!ARG_DOMINIO || !ARG_KEYWORD) {
        console.error("❌ Faltan argumentos: --dominio y --keyword");
        process.exit(1);
    }

    const { browser, page } = await connect({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        turnstile: true
    });

    page.on('response', (res) => {
        const url = res.url().toLowerCase();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
            global.videoCapturado = url;
        }
    });

    try {
        const configsDir = path.join(__dirname, 'configs');
        const receta = JSON.parse(fs.readFileSync(path.join(configsDir, `${ARG_DOMINIO}_receta.json`), 'utf8'));

        await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        const sSelector = receta.searchSelector || 'input[type="search"]';
        await page.waitForSelector(sSelector);
        await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, ARG_KEYWORD);
        
        const subSelector = receta.submitSelector || 'button[type="submit"]';
        await page.click(subSelector).catch(() => page.keyboard.press('Enter'));
        await esperarBypass(page);

        const resultados = await page.evaluate((kw) => {
            return Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText.trim() }))
                .filter(e => e.text.toLowerCase().includes(kw.toLowerCase()));
        }, ARG_KEYWORD);

        if (resultados.length === 0) throw new Error("No se encontraron resultados.");

        // --- PASO 1: Seleccionar Show ---
        await enviarEstado('SELECT_SHOW', { resultados });
        const seleccionIdx = parseInt(await esperarRespuesta("Selecciona el show")) - 1;
        const show = resultados[seleccionIdx] || resultados[0];

        await page.goto(show.href, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // --- PASO 2: Serie o Película ---
        await enviarEstado('SELECT_TYPE', { titulo: show.text });
        const tipo = await esperarRespuesta("¿Serie o Película?");
        const clasificacionFinal = (tipo === 'P') ? 'PELICULA_OVA' : 'SERIE';

        let targetUrl = show.href;
        if (clasificacionFinal === 'SERIE') {
            // --- PASO 3: Capítulo ---
            await enviarEstado('SELECT_EPISODE', { titulo: show.text });
            const ep = await esperarRespuesta("Número de capítulo");
            const urlLimpia = show.href.replace(/\/$/, "");
            targetUrl = receta.episodeUrlPattern ? receta.episodeUrlPattern.replace('{showUrl}', urlLimpia).replace('{number}', ep) : `${urlLimpia}/${ep}/`;
        }

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);
        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio, reproducido) VALUES (?, ?, ?, ?, ?, ?, 0)')
              .run(ARG_KEYWORD, clasificacionFinal, 1, global.videoCapturado, show.href, ARG_DOMINIO);
            console.log("✅ Guardado en DB");
        }
    } catch (e) {
        console.error("❌ Error:", e.message);
        await enviarEstado('ERROR', { message: e.message });
    } finally {
        await browser.close();
    }
}

main();