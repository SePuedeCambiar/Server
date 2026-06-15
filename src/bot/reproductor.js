const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS Y ESTADO (RUTAS DINÁMICAS ABSOLUTAS)
// ============================================================================
// Subimos dos niveles para llegar al root: src/bot -> src -> root
const ROOT_DIR = path.resolve(__dirname, '..', '..');

const DB_PATH = path.join(ROOT_DIR, 'data', 'playlist.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const STATE_FILE = path.join(ROOT_DIR, 'configs', 'bot_state.json');
const MODO_INVISIBLE = false;

global.videoCapturado = null;
global.currentMainPage = null;

/**
 * Escribe el estado actual del bot en el archivo JSON para que el Panel Web lo lea
 */
async function enviarEstado(estado, datos = {}) {
    const payload = {
        estado,
        ...datos,
        timestamp: new Date().toISOString()
    };
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error("Error escribiendo estado:", e);
    }
}

/**
 * Detiene el bot y espera a que el usuario responda a través del Panel Web
 */
async function esperarRespuesta(estado, preguntaTexto, datosExtra = {}) {
    console.log(`⏳ [Web-Bridge] Esperando respuesta para: ${preguntaTexto}`);
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
// 2. FUNCIONES DE SOPORTE, NAVEGACIÓN Y ABORTO (ASAP)
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

// ============================================================================
// SISTEMA DE CONTROL DE PESTAÑAS (ANTI POPUPS DE PUBLICIDAD)
// ============================================================================
function blindarNavegador(browser, mainPage) {
    global.currentMainPage = mainPage;

    mainPage.evaluateOnNewDocument(() => {
        window.open = () => {
            console.log("🚫 [Blindaje] Ventana emergente bloqueada.");
            return null;
        };
    });

    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const page = await target.page();
            if (page && page !== global.currentMainPage) {
                await page.close().catch(() => {});
            }
        }
    });
}

// ============================================================================
// ESPERA DETERMINISTA DE IFRAMES EXTERNOS (LIBRE DE RESTRICCIONES CORS)
// ============================================================================
async function esperarIFramesExternos(page) {
    console.log("⏳ Esperando que el reproductor inyecte el iframe de video externo...");
    const start = Date.now();
    while (Date.now() - start < 8000) {
        const frames = page.frames();
        const tieneHostExterno = frames.some(f => {
            try {
                const urlStr = f.url();
                return urlStr && !urlStr.includes('about:blank') && !urlStr.includes('cuevana') && !urlStr.includes('jkanime');
            } catch(e) { return false; }
        });

        if (tieneHostExterno) {
            console.log(`🎯 ¡Iframe del servidor de video detectado tras ${Date.now() - start}ms!`);
            return true;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    console.log("⚠️ No se detectaron iframes externos a tiempo. Continuando con análisis...");
    return false;
}

// ============================================================================
// DETECTOR Y SONDEADOR DE LATENCIA DEL CDN DE VIDEO REAL (PROTOCOL-LEVEL)
// ============================================================================
async function medirLatenciaHost(page) {
    const frames = page.frames();
    let targetHost = null;

    for (const frame of frames) {
        try {
            const urlStr = frame.url();
            if (urlStr && !urlStr.includes('about:blank') && !urlStr.includes('cuevana') && !urlStr.includes('jkanime')) {
                const frameElement = await frame.frameElement();
                if (frameElement) {
                    const rect = await frameElement.boundingBox();
                    if (rect && rect.width > 250 && rect.height > 120) {
                        targetHost = new URL(urlStr).hostname;
                        break;
                    }
                }
            }
        } catch (e) {}
    }

    if (!targetHost) {
        console.log("⚠️ No se detectó un host externo explícito por tamaño. Usando fallback de 800ms.");
        return 800;
    }

    console.log(`⚡ Servidor de video activo: [${targetHost}]. Midiendo latencia directa...`);
    const rttHost = await page.evaluate(async (host) => {
        const start = Date.now();
        try {
            await fetch(`https://${host}/favicon.ico`, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            return Date.now() - start;
        } catch (e) {
            try {
                await fetch(`https://${host}`, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
                return Date.now() - start;
            } catch (err) {
                return 1000;
            }
        }
    }, targetHost);

    console.log(`📡 Latencia directa con el servidor de video [${targetHost}]: ${rttHost}ms`);
    return rttHost;
}

/**
 * Bypass de Cloudflare
 */
async function esperarBypass(page, maxIntentos = 30) {
    console.log("🛡️ Verificando estado del bypass...");
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const url = page.url();
            if (url === 'about:blank' || url.trim().length < 10) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const titulo = await page.title().catch(() => '');
            let esDesafio = titulo.toLowerCase().includes('just a moment') ||
                            url.includes('challenges.cloudflare.com') ||
                            titulo.toLowerCase().includes('verificando que eres humano');
            if (!esDesafio) {
                const contenido = await page.content();
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) esDesafio = true;
            }
            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Resolviendo escudo...`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                console.log("✅ Bypass completado.");
                return true;
            }
        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
    return false;
}

/**
 * Función asíncrona inteligente para realizar la carga ASAP y abortar red basura
 */
async function navegarYAbortar(page, url, selector, esPaginaCritica = false) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (esPaginaCritica) {
            await page.waitForSelector(selector, { timeout: 12000 });
            return;
        }

        const currentUrl = page.url();
        const titulo = await page.title().catch(() => '');
        const esCF = titulo.toLowerCase().includes('just a moment') || currentUrl.includes('challenges.cloudflare.com');
        if (!esCF) {
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.evaluate(() => window.stop()).catch(() => {});
            console.log("🛑 [ASAP] Carga de página abortada para ahorrar recursos.");
        }
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
// EXTRACCIÓN SANDBOX CON FORMULA DE CUELLO DE BOTELLA FÍSICO
// ============================================================================
async function activarVideoSandbox(page, rttHost, cpuScore) {
    console.log("\n🎬 Iniciando Extracción Sandbox...");
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.video-play', '.jw-icon-display', '.plyr__control--overlaid'];
    const startTime = Date.now();
    const factorExponencial = 1.15 + (cpuScore * 0.05); 
    const baseDelay = rttHost ? Math.max(2500, Math.min(8000, 2500 + (rttHost * cpuScore))) : 2000;
    let k = 0;
    while (Date.now() - startTime < 60000) {
        if (global.videoCapturado) return true;
        try {
            await page.evaluate(() => {
                document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.click();
            });

            const estadoBuffer = await page.evaluate(() => {
                const v = document.querySelector('video');
                return v ? { ready: v.readyState >= 1, playing: !v.paused } : { ready: false, playing: false };
            });

            const frames = page.frames();
            for (const frame of frames) {
                try {
                    if (frame.url().includes('about:blank')) continue;
                    const src = await frame.evaluate(() => {
                        const vid = document.querySelector('video'); return vid ? vid.src : null;
                    });
                    if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !src.startsWith('blob:')) {
                        global.videoCapturado = src;
                        return true;
                    }
                    for (const selector of playSelectors) {
                        const el = await frame.$(selector);
                        if (el) await frame.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
                    }
                } catch (e) {}
            }

            if (estadoBuffer.ready || global.videoCapturado) {
                console.log("⚡ ¡Video o buffer detectado! Extracción completada.");
                break;
            } else {
                let waitTime = rttHost ? Math.round(baseDelay * Math.pow(factorExponencial, k)) : 2000;
                waitTime = Math.min(10000, waitTime);

                console.log(`⏳ Ciclo #${k} - Espera: ${waitTime}ms (factor: ${factorExponencial.toFixed(2)})`);
                await new Promise(r => setTimeout(r, waitTime));
                k++;
            }
        } catch (e) {}
    }
    return !!global.videoCapturado;
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

    const startCPU = Date.now();
    for (let i = 0; i < 5000000; i++) { Math.sqrt(i); }
    const cpuTime = Date.now() - startCPU;
    const cpuScore = Math.max(1.0, cpuTime / 15);

    console.log("======================================================");
    console.log(`🤖 BOT INTERACTIVO | Buscando: ${ARG_KEYWORD} en ${ARG_DOMINIO}`);
    console.log(`🖥️  Hardware Profile Score: CPU ${cpuScore.toFixed(2)}x (${cpuTime}ms)`);
    console.log("======================================================");

    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: [
            "--start-maximized",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",         
            "--disable-accelerated-2d-canvas",
            "--disable-gpu"                    
        ],
        turnstile: true,
        connectOption: { defaultViewport: null }
    });

    blindarNavegador(browser, page);
    page.setDefaultNavigationTimeout(90000);

    await page.setRequestInterception(true);
    let peticionesBloqueadas = 0;
    page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url().toLowerCase();
        if (url.includes('cloudflare') || url.includes('challenges') || url.includes('captcha') || url.includes('turnstile')) {
            return req.continue();
        }
        if (['image', 'font', 'media'].includes(type)) {
            peticionesBloqueadas++;
            return req.abort();
        }
        const esAnuncioOTracker = ['1xbet', 'popads', 'doubleclick', 'google-analytics', 'googletagmanager', 'gtag', 'onclickads', 'facebook', 'exoclick', 'juicyads', 'a-ads', 'coinad', 'histats', 'adskeeper', 'mgid', 'analytics', 'telemetry', 'tracker', 'anisabi.com'].some(keyword => url.includes(keyword));

        if (esAnuncioOTracker && ['script', 'xhr', 'fetch', 'other'].includes(type)) {
            peticionesBloqueadas++;
            return req.abort();
        }
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

        // --- PASO 1: BÚSQUEDA ---
        let searchUrl = null;
        if (ARG_DOMINIO.includes('jkanime')) {
            searchUrl = `https://${ARG_DOMINIO}/buscar/${encodeURIComponent(ARG_KEYWORD)}`;
        } else if (ARG_DOMINIO.includes('cuevana')) {
            searchUrl = `https://${ARG_DOMINIO}/explorar?s=${encodeURIComponent(ARG_KEYWORD)}`;
        }

        if (searchUrl) {
            console.log(`📡 Navegando directamente a la búsqueda: ${searchUrl}`);
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
            try {
                await page.click(subSelector);
            } catch (e) {
                await page.$eval(sSelector, (el) => el.closest('form')?.submit());
            }  
        }
        await esperarBypass(page);

        console.log("⏳ Esperando que se rendericen los resultados en el DOM...");
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
        if (enlaces.length === 0) throw new Error("No se encontraron resultados en la página.");

        const seleccionIdx = parseInt(await esperarRespuesta('SELECT_SHOW', "Selecciona el show", { resultados: enlaces })) - 1;
        const show = enlaces[seleccionIdx] || enlaces[0];
        const urlBaseFinal = show.href;

        // --- PASO 2: FICHA DEL SHOW ---
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

        // --- PASO 3: CAPTURA FINAL ---
        console.log(`➡️  Navegando al video final: ${targetUrl}`);
        const selectorVideo = '.video-play, #play-button, video, .vjs-big-play-button';
        await navegarYAbortar(page, targetUrl, selectorVideo, true);
        await esperarBypass(page);

        const diag = await page.evaluate(() => ({
            hasPlay: document.querySelector('.video-play') !== null,
            servers: Array.from(document.querySelectorAll('li[role="presentation"], .server-item')).map(el => el.innerText.trim())
        }));

        if (diag.hasPlay) {
            console.log("👆 Haciendo click inicial para forzar inyección...");
            await clickInteligente(page, '.video-play');
        }
        if (diag.servers.length > 0) {
            console.log("👆 Seleccionando servidor primario...");
            await page.evaluate(() => {
                document.querySelector('li[role="presentation"], .server-item')?.click();
            });
            await new Promise(r => setTimeout(r, 1500));
        }

        await esperarIFramesExternos(page);
        const rttHost = await medirLatenciaHost(page);

        await activarVideoSandbox(page, rttHost, cpuScore);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace capturado: ${global.videoCapturado}`);
            const insert = db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio, hora_programada, reproducido) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
            insert.run(ARG_KEYWORD, clasificacionFinal, capituloElegido, global.videoCapturado, urlBaseFinal, ARG_DOMINIO, ARG_HORA);
            await enviarEstado('IDLE', { message: '¡Contenido guardado con éxito!' });
        } else {
            throw new Error("No se pudo capturar la URL del stream después de intentar el modo agresivo.");
        }

    } catch (e) {
        console.error(`❌ ERROR CRÍTICO: ${e.message}`);
        await enviarEstado('ERROR', { message: e.message });
    } finally {
        await browser.close();
    }
}

main();