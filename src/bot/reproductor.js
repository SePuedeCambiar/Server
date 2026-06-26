const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN
// ============================================================================
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(ROOT_DIR, 'data', 'playlist.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const STATE_FILE = path.join(ROOT_DIR, 'configs', 'bot_state.json');
const MODO_INVISIBLE = false;

global.videoCapturado = null;
global.currentMainPage = null;

async function enviarEstado(estado, datos = {}) {
    const payload = { estado, ...datos, timestamp: new Date().toISOString() };
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2)); }
    catch (e) { console.error("Error escribiendo estado:", e); }
}

async function esperarRespuesta(estado, preguntaTexto, datosExtra = {}) {
    console.log(`⏳ [Web-Bridge] Esperando respuesta para: ${preguntaTexto}`);
    await enviarEstado(estado, { pregunta: preguntaTexto, waiting: true, ...datosExtra });
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            if (fs.existsSync(STATE_FILE)) {
                try {
                    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                    if (state.respuesta !== undefined) {
                        const resp = state.respuesta;
                        clearInterval(interval);
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
// 2. FUNCIONES DE SOPORTE (LÓGICA ORIGINAL)
// ============================================================================
function cargarRecetaPorDominio(dominioBuscado) {
    const configsDir = path.join(ROOT_DIR, 'configs');
    if (!fs.existsSync(configsDir)) return null;
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    for (const archivo of archivos) {
        const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivo), 'utf8'));
        if (receta.dominio === dominioBuscado) return receta;
    }
    return null;
}

function blindarNavegador(browser, mainPage) {
    global.currentMainPage = mainPage;
    mainPage.evaluateOnNewDocument(() => { window.open = () => null; });
    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const page = await target.page();
            if (page && page !== global.currentMainPage) await page.close().catch(() => {});
        }
    });
}

async function esperarIFramesExternos(page) {
    console.log("⏳ Esperando inyección del reproductor externo...");
    const start = Date.now();
    while (Date.now() - start < 15000) {
        const frames = page.frames();
        const tieneHostExterno = frames.some(f => {
            try {
                const urlStr = f.url();
                // Filtramos iframes pequeños o vacíos para no engañar al bot
                if (!urlStr || urlStr.includes('about:blank') || urlStr.includes('cuevana') || urlStr.includes('jkanime')) return false;
                
                // Solo consideramos iframes que tengan un tamaño razonable (el reproductor)
                const frameElement = f.frameElement();
                if (frameElement) {
                    const rect = f.frameElement().boundingBox(); // Esto es simplificado
                    return true; 
                }
                return true;
            } catch(e) { return false; }
        });
        if (tieneHostExterno) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function medirLatenciaHost(page) {
    const frames = page.frames();
    let targetHost = null;
    for (const frame of frames) {
        try {
            const urlStr = frame.url();
            if (urlStr && !urlStr.includes('about:blank') && !urlStr.includes('cuevana') && !urlStr.includes('jkanime')) {
                targetHost = new URL(urlStr).hostname;
                break;
            }
        } catch (e) {}
    }
    if (!targetHost) return 800;
    const rttHost = await page.evaluate(async (host) => {
        const start = Date.now();
        try {
            await fetch(`https://${host}/favicon.ico`, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            return Date.now() - start;
        } catch (e) { return 800; }
    }, targetHost);
    return rttHost;
}

async function esperarBypass(page, maxIntentos = 30) {
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            if (!titulo.toLowerCase().includes('just a moment') && !page.url().includes('challenges.cloudflare.com')) return true;
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {}
    }
    return false;
}

async function navegarYAbortar(page, url, selector, esPaginaCritica = false) {
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        if (esPaginaCritica) {
            await page.waitForSelector(selector, { timeout: 15000 });
            return;
        }
        await page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});
        await page.evaluate(() => window.stop()).catch(() => {});
    } catch (e) {}
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

// ============================================================================
// EXTRACCIÓN AGRESIVA (LÓGICA EXACTA DEL BENCHMARK)
// ============================================================================
async function activarVideoSandbox(page, rttHost, cpuScore) {
    console.log("\n🎬 Iniciando Extracción Agresiva (Modo Benchmark)...");
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.jw-icon-display', '.plyr__control--overlaid'];
    const startTime = Date.now();
    
    // Usamos la misma lógica de baseWait del benchmark
    let baseWait = rttHost ? Math.max(500, rttHost) : 2000;
    let k = 0;

    while (Date.now() - startTime < 60000) {
        if (global.videoCapturado) return true;
        try {
            const frames = page.frames();
            for (const frame of frames) {
                try {
                    if (frame.url().includes('about:blank')) continue;

                    // 1. Robo directo de src
                    const src = await frame.evaluate(() => {
                        const v = document.querySelector('video');
                        return v ? v.src : null;
                    });
                    if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !src.startsWith('blob:')) {
                        global.videoCapturado = src;
                        return true;
                    }

                    // 2. Inyección de JS (Mute + Play + Click Body)
                    await frame.evaluate(() => {
                        document.querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(() => {}); });
                        const body = document.body;
                        if (body) {
                            const event = new MouseEvent('click', {
                                view: window, bubbles: true, cancelable: true,
                                clientX: window.innerWidth / 2, clientY: window.innerHeight / 2
                            });
                            body.dispatchEvent(event);
                        }
                    });

                    // 3. Clicks en selectores
                    for (const selector of playSelectors) {
                        try {
                            const el = await frame.$(selector);
                            if (el) {
                                await el.click();
                                await new Promise(r => setTimeout(r, 500));
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            }

            if (global.videoCapturado) break;

            // LÓGICA DE ESPERA DEL BENCHMARK: Rápida al inicio, lenta después
            let waitTime = k < 3 ? baseWait : Math.min(8000, Math.round(baseWait * Math.pow(1.2 + (cpuScore * 0.05), k - 2)));
            console.log(`⏳ Toque #${k} - Espera: ${waitTime}ms...`);
            await new Promise(r => setTimeout(r, waitTime));
            k++;
        } catch (e) {}
    }
    return !!global.videoCapturado;
}

// ============================================================================
// 3. ORQUESTADOR PRINCIPAL (LÓGICA ORIGINAL)
// ============================================================================
async function main() {
    const args = process.argv.slice(2);
    const ARG_DOMINIO = args.find(arg => arg.startsWith('--dominio='))?.split('=')[1];
    const ARG_KEYWORD = args.find(arg => arg.startsWith('--keyword='))?.split('=')[1];
    const ARG_HORA = args.find(arg => arg.startsWith('--hora='))?.split('=')[1] || null;

    if (!ARG_DOMINIO || !ARG_KEYWORD) {
        console.error("❌ Argumentos faltantes.");
        process.exit(1);
    }

    const startCPU = Date.now();
    for (let i = 0; i < 5000000; i++) { Math.sqrt(i); }
    const cpuTime = Date.now() - startCPU;
    const cpuScore = Math.max(1.0, cpuTime / 15);

    console.log("======================================================");
    console.log(`🤖 BOT INTERACTIVO BENCHMARK-ED | ${ARG_KEYWORD} en ${ARG_DOMINIO}`);
    console.log("======================================================");

    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: ["--start-maximized", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        turnstile: true,
        connectOption: { defaultViewport: null }
    });

    blindarNavegador(browser, page);
    page.setDefaultNavigationTimeout(90000);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const url = req.url().toLowerCase();
        const type = req.resourceType();
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.ts') || url.includes('manifest')) return req.continue();
        if (url.includes('cloudflare') || url.includes('challenges')) return req.continue();
        if (['image', 'font'].includes(type)) return req.abort();
        if (['1xbet', 'popads', 'doubleclick', 'google-analytics'].some(k => url.includes(k))) return req.abort();
        req.continue();
    });

    page.on('response', (response) => {
        try {
            const url = response.url().toLowerCase();
            if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
                global.videoCapturado = response.url();
                console.log(`✨ Stream interceptado: ${url}`);
            }
        } catch (e) {}
    });

    try {
        const receta = cargarRecetaPorDominio(ARG_DOMINIO);
        if (!receta) throw new Error(`No se encontró receta para ${ARG_DOMINIO}`);

        // --- PASO 1: BÚSQUEDA (SISTEMA ORIGINAL) ---
        let searchUrl = null;
        if (ARG_DOMINIO.includes('jkanime')) {
            searchUrl = `https://${ARG_DOMINIO}/buscar/${encodeURIComponent(ARG_KEYWORD)}`;
        } else if (ARG_DOMINIO.includes('cuevana')) {
            searchUrl = `https://${ARG_DOMINIO}/explorar?s=${encodeURIComponent(ARG_KEYWORD)}`;
        }

        if (searchUrl) {
            await navegarYAbortar(page, searchUrl, 'a', true);
        } else {
            const initSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
            await navegarYAbortar(page, `https://${receta.dominio}`, initSelector, false);
            await esperarBypass(page);
            const sSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
            await page.waitForSelector(sSelector, { timeout: 15000 });
            await page.$eval(sSelector, (el, val) => {
                el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
            }, ARG_KEYWORD);
            const subSelector = receta.submitSelector || 'button[type="submit"], input[type="submit"], .search-submit';
            try { await page.click(subSelector); } catch (e) { await page.$eval(sSelector, (el) => el.closest('form')?.submit()); }
        }
        await esperarBypass(page);

        console.log("⏳ Esperando resultados...");
        let enlaces = [];
        for (let i = 0; i < 5; i++) {
            enlaces = await page.evaluate((kw) => {
                const normalizar = (texto) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
                const kwNormalizado = normalizar(kw);
                return Array.from(document.querySelectorAll('a'))
                    .map(a => ({ href: a.href, text: a.innerText.trim() }))
                    .filter(e => normalizar(e.text).includes(kwNormalizado) && e.href.length > 10);
            }, ARG_KEYWORD);
            if (enlaces.length > 0) break;
            await new Promise(r => setTimeout(r, 2000));
        }
        if (enlaces.length === 0) throw new Error("No se encontraron resultados.");

        const seleccionIdx = parseInt(await esperarRespuesta('SELECT_SHOW', "Selecciona el show", { resultados: enlaces })) - 1;
        const show = enlaces[seleccionIdx] || enlaces[0];
        const urlBaseFinal = show.href;

        // --- PASO 2: FICHA DEL SHOW (ORIGINAL) ---
        await navegarYAbortar(page, urlBaseFinal, 'body', true);
        await esperarBypass(page);

        const tipo = await esperarRespuesta('SELECT_TYPE', "¿Serie o Película?", { titulo: show.text });
        const clasificacionFinal = (tipo === 'P') ? 'PELICULA_OVA' : 'SERIE';
        let targetUrl = urlBaseFinal;
        let capituloElegido = 1;
        if (clasificacionFinal === 'SERIE') {
            const totalEpisodios = await page.evaluate(() => {
                const text = document.body.innerText;
                const m = text.match(/Episodios:\s*(\d+)/i);
                return m ? parseInt(m[1], 10) : null;
            });
            const ep = await esperarRespuesta('SELECT_EPISODE', `Capítulo (1 al ${totalEpisodios || '?'})`, { total: totalEpisodios });
            capituloElegido = parseInt(ep, 10) || 1;
            targetUrl = generarUrlEpisodio(urlBaseFinal, capituloElegido, receta);
        }

        // --- PASO 3: CAPTURA FINAL (LÓGICA BENCHMARK) ---
        console.log(`➡️  Navegando al video final: ${targetUrl}`);
        const selectorVideo = '.video-play, #play-button, video, .vjs-big-play-button';
        await navegarYAbortar(page, targetUrl, selectorVideo, true);
        await esperarBypass(page);

        const diag = await page.evaluate(() => ({
            hasPlay: document.querySelector('.video-play') !== null,
            servers: Array.from(document.querySelectorAll('li[role="presentation"], .server-item')).map(el => el.innerText.trim())
        }));

        if (diag.hasPlay) await clickInteligente(page, '.video-play');
        if (diag.servers.length > 0) {
            await page.evaluate(() => { document.querySelector('li[role="presentation"], .server-item')?.click(); });
            await new Promise(r => setTimeout(r, 1500));
        }

        await esperarIFramesExternos(page);
        const rttHost = await medirLatenciaHost(page);
        
        // EXTRACCIÓN AGRESIVA (Copia exacta del benchmark que funcionó)
        await activarVideoSandbox(page, rttHost, cpuScore);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace capturado: ${global.videoCapturado}`);
            const insert = db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio, hora_programada, reproducido) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
            insert.run(ARG_KEYWORD, clasificacionFinal, capituloElegido, global.videoCapturado, urlBaseFinal, ARG_DOMINIO, ARG_HORA);
            await enviarEstado('IDLE', { message: 'Contenido guardado con éxito!' });
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