const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS Y ESTADO
// ============================================================================
const db = new Database('playlist.db');
db.pragma('journal_mode = WAL');

// Archivo puente para comunicarse con el manager.py y el index.html
const STATE_FILE = path.join(__dirname, 'configs', 'bot_state.json');

// Auto-detección de modo: Si no hay pantalla (Docker), corre invisible
const MODO_INVISIBLE = false; // Forzar a false para que use Xvfb y pase Cloudflare

/**
 * Escribe el estado actual del bot en el archivo JSON para que el Panel Web lo lea
 */
async function enviarEstado(estado, datos = {}) {
    const payload = { 
        estado, 
        ...datos, 
        timestamp: new Date().toISOString() 
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

/**
 * Detiene el bot y espera a que el usuario responda a través del Panel Web
 */
async function esperarRespuesta(estado, preguntaTexto, datosExtra = {}) {
    console.log(`⏳ [Web-Bridge] Esperando respuesta para: ${preguntaTexto}`);
    
    // Enviamos el estado actual y los datos necesarios (ej: la lista de resultados)
    await enviarEstado(estado, { 
        pregunta: preguntaTexto, 
        waiting: true, 
        ...datosExtra 
    });

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            if (fs.existsSync(STATE_FILE)) {
                try {
                    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                    if (state.respuesta !== undefined) {
                        const resp = state.respuesta;
                        clearInterval(interval);
                        // Limpiamos la respuesta para evitar bucles infinitos
                        const newState = { ...state, respuesta: undefined, waiting: false };
                        fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
                        resolve(resp);
                    }
                } catch (e) { console.error("Error leyendo respuesta:", e); }
            }
        }, 1000);
    });
}

// ============================================================================
// 2. FUNCIONES de SOPORTE Y NAVEGACIÓN
// ============================================================================

function cargarRecetaPorDominio(dominioBuscado) {
    const configsDir = path.join(__dirname, 'configs');
    if (!fs.existsSync(configsDir)) return null;
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    for (const archivo of archivos) {
        const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivo), 'utf8'));
        if (receta.dominio === dominioBuscado) return receta;
    }
    return null;
}

async function esperarBypass(page, maxIntentos = 30) {
    console.log("🛡️ Verificando estado del bypass...");
    await new Promise(r => setTimeout(r, 4000));
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            let esDesafio = titulo.toLowerCase().includes('just a moment') ||
                            url.includes('challenges.cloudflare.com') ||
                            titulo.toLowerCase().includes('verificando que eres humano');
            if (!esDesafio) {
                const contenido = await page.content();
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) esDesafio = true;
            }
            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Resolviendo escudo...`);
                await new Promise(r => setTimeout(r, 4000));
            } else if (url !== 'about:blank' && !url.startsWith('about:') && url.trim().length > 10) {
                console.log("✅ Bypass completado.");
                return true;
            }
        } catch (e) {}
    }
    return false;
}

async function clickInteligente(page, selector) {
    try {
        await page.waitForSelector(selector, { timeout: 8000 });
        await page.click(selector);
    } catch (e) {
        try { await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 1500));
}

function generarUrlEpisodio(showUrl, capitulo, receta) {
    const urlLimpia = showUrl.replace(/\/$/, "");
    if (receta.episodeUrlPattern) {
        return receta.episodeUrlPattern.replace('{showUrl}', urlLimpia).replace('{number}', capitulo);
    }
    return `${urlLimpia}/${capitulo}/`;
}

async function activarVideoSandbox(page) {
    console.log("\n🎬 Buscando reproductor en frames...");
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.video-play'];
    const startTime = Date.now();
    
    while (Date.now() - startTime < 30000) {
        if (global.videoCapturado) return true;
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 1. Probar selectores conocidos
                for (const selector of playSelectors) {
                    const el = await frame.$(selector);
                    if (el) {
                        console.log(`🎯 Botón detectado: ${selector}`);
                        await frame.evaluate((sel) => { 
                            const btn = document.querySelector(sel);
                            if(btn) btn.click(); 
                        }, selector);
                        await new Promise(r => setTimeout(r, 3000));
                        if (global.videoCapturado) return true;
                    }
                }
                // 2. Click central si es un frame de reproductor
                if (frame.url().includes('player') || frame.url().includes('mudos')) {
                    await frame.evaluate(() => {
                        const elem = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
                        if (elem) elem.click();
                    });
                    await new Promise(r => setTimeout(r, 3000));
                    if (global.videoCapturado) return true;
                }
            } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

// ============================================================================
// 3. ORQUESTADOR PRINCIPAL
// ============================================================================
async function main() {
    const args = process.argv.slice(2);
    const ARG_DOMINIO = args.find(arg => arg.startsWith('--dominio='))?.split('=')[1];
    const ARG_KEYWORD = args.find(arg => arg.startsWith('--keyword='))?.split('=')[1];
    const ARG_HORA = args.find(arg => arg.startsWith('--hora='))?.split('=')[1] || null;

    if (!ARG_DOMINIO || !ARG_KEYWORD) {
        console.error("❌ Argumentos faltantes. Uso: node reproductor.js --dominio=x --keyword=y");
        process.exit(1);
    }

    console.log("======================================================");
    console.log(`🤖 BOT INTERACTIVO | Buscando: ${ARG_KEYWORD} en ${ARG_DOMINIO}`);
    console.log(`🖥️ Modo Invisible: ${MODO_INVISIBLE}`);
    console.log("======================================================");

    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
        turnstile: true,
        connectOption: { defaultViewport: null }
    });

    await page.evaluateOnNewDocument(() => { window.open = () => null; });

    page.on('response', (response) => {
        try {
            const url = response.url().toLowerCase();
            if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
                global.videoCapturado = url;
                console.log(`✨ Stream interceptado: ${url}`);
            }
        } catch (e) {}
    });

    try {
        const receta = cargarRecetaPorDominio(ARG_DOMINIO);
        if (!receta) throw new Error(`No se encontró receta para ${ARG_DOMINIO}`);

        // --- PASO 1: BÚSQUEDA ---
        await page.goto(`https://${receta.dominio}`, { waitUntil: 'networkidle2' });
        await esperarBypass(page);

        const sSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
        await page.waitForSelector(sSelector, { timeout: 15000 });
        await page.$eval(sSelector, (el, val) => {
            el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
        }, ARG_KEYWORD);

        const subSelector = receta.submitSelector || 'button[type="submit"], input[type="submit"], .search-submit';
        try { 
            await page.click(subSelector); 
        } catch (e) { 
            await page.$eval(sSelector, (el) => el.closest('form')?.submit()); 
        }  
        await esperarBypass(page);

        // Extraer resultados
        const enlaces = await page.evaluate((kw) => {
            return Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText.trim() }))
                .filter(e => e.text.toLowerCase().includes(kw.toLowerCase()) && e.href.length > 10);
        }, ARG_KEYWORD);
        
        if (enlaces.length === 0) throw new Error("No se encontraron resultados en la página.");

        // Interacción Panel: Seleccionar Show
        const seleccionIdx = parseInt(await esperarRespuesta('SELECT_SHOW', "Selecciona el show", { resultados: enlaces })) - 1;
        const show = enlaces[seleccionIdx] || enlaces[0];
        const urlBaseFinal = show.href;

        // --- PASO 2: FICHA DEL SHOW ---
        await page.goto(urlBaseFinal, { waitUntil: 'networkidle2' });
        await esperarBypass(page);

        // Interacción Panel: Seleccionar Tipo
        const tipo = await esperarRespuesta('SELECT_TYPE', "¿Serie o Película?", { titulo: show.text });
        const clasificacionFinal = (tipo === 'P') ? 'PELICULA_OVA' : 'SERIE';

        let targetUrl = urlBaseFinal;
        let capituloElegido = 1;

        if (clasificacionFinal === 'SERIE') {
            // EXTRACCIÓN DINÁMICA DE EPISODIOS
            const totalEpisodios = await page.evaluate(() => {
                const text = document.body.innerText;
                const m = text.match(/Episodios:\s*(\d+)/i); 
                return m ? parseInt(m[1], 10) : null;
            });

            // Interacción Panel: Seleccionar Capítulo
            const ep = await esperarRespuesta('SELECT_EPISODE', `Capítulo (1 al ${totalEpisodios || '?'})`, { total: totalEpisodios });
            capituloElegido = parseInt(ep, 10) || 1;
            targetUrl = generarUrlEpisodio(urlBaseFinal, capituloElegido, receta);
        }

        // --- PASO 3: CAPTURA FINAL ---
        console.log(`➡️ Navegando al video final: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        await esperarBypass(page);

        // Intento de click en reproductor
        const diag = await page.evaluate(() => ({
            hasPlay: document.querySelector('.video-play') !== null,
            servers: Array.from(document.querySelectorAll('li[role="presentation"], .server-item')).map(el => el.innerText.trim())
        }));

        if (diag.hasPlay) await clickInteligente(page, '.video-play');
        if (diag.servers.length > 0) {
            await page.evaluate(() => {
                document.querySelector('li[role="presentation"], .server-item')?.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        }

        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace: ${global.videoCapturado}`);
            const insert = db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio, hora_programada, reproducido) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
            insert.run(ARG_KEYWORD, clasificacionFinal, capituloElegido, global.videoCapturado, urlBaseFinal, ARG_DOMINIO, ARG_HORA);
            await enviarEstado('IDLE', { message: '¡Contenido guardado con éxito!' });
        } else {
            throw new Error("No se pudo capturar la URL del stream.");
        }

    } catch (e) {
        console.error(`❌ ERROR CRÍTICO: ${e.message}`);
        await enviarEstado('ERROR', { message: e.message });
    } finally {
        await browser.close();
    }
}

main();