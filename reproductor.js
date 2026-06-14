const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS Y ESTADO
// ============================================================================
const db = new Database('data/playlist.db');
db.pragma('journal_mode = WAL');

// Archivo puente para comunicarse con el manager.py y el index.html
const STATE_FILE = path.join(__dirname, 'configs', 'bot_state.json');

// En Docker, esto DEBE ser false para que la librería use Xvfb y pase Cloudflare
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
// 2. SISTEMA DE PERFILADO Y CONTROL DE PESTAÑAS (TAB PINNING)
// ============================================================================

/**
 * Profiler de Rendimiento: Calcula la tolerancia de tiempo basado en CPU y Red
 */
async function calcularCVD(page, dominio) {
    console.log("⏱️  Iniciando Profiling de Rendimiento Dinámico...");
    
    // 1. Test de CPU Local (Node.js)
    const startCPU = Date.now();
    let num = 0;
    for (let i = 0; i < 5000000; i++) {
        num += Math.sqrt(i);
    }
    const cpuTime = Date.now() - startCPU; 
    
    // 2. Test de Latencia de Red (RTT al destino)
    let rtt = 150; 
    try {
        const startNet = Date.now();
        await page.goto(`https://${dominio}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        rtt = Date.now() - startNet;
    } catch(e) {}

    const baseCPU = 15;  
    const baseRTT = 80;  

    const cpuScore = Math.max(1.0, cpuTime / baseCPU);
    const rttScore = Math.max(1.0, rtt / baseRTT);

    let cvd = (cpuScore * 0.4) + (rttScore * 0.6);
    cvd = Math.max(1.0, Math.min(4.5, cvd)); // Capped en 4.5x máximo

    console.log(`📊 REPORTE DE PROFILING EN PRODUCCIÓN:`);
    console.log(`   - CPU Local Score: ${cpuScore.toFixed(2)}x (Bucle en ${cpuTime}ms)`);
    console.log(`   - Red RTT Score:   ${rttScore.toFixed(2)}x (${rtt}ms)`);
    console.log(`   - Coeficiente de Velocidad Dinámico (CVD): ${cvd.toFixed(2)}x`);
    
    return cvd;
}

/**
 * Blindaje activo: Detecta y destruye pestañas de anuncios popups
 */
function blindarNavegador(browser, mainPage) {
    global.currentMainPage = mainPage;

    mainPage.evaluateOnNewDocument(() => {
        window.open = () => {
            console.log("🚫 [Blindaje] Intento de ventana emergente bloqueado.");
            return null;
        };
    });

    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const page = await target.page();
            if (page && page !== global.currentMainPage) {
                const url = page.url();
                console.log(`🚫 [Blindaje] Cerrando pestaña intrusa: ${url.substring(0, 45)}...`);
                await page.close().catch(() => {});
            }
        }
    });
}

// ============================================================================
// 3. FUNCIONES DE CAPTCHA Y NAVEGACIÓN REPOSITORIO
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

/**
 * Bypass de Cloudflare escalado dinámicamente según CVD
 */
async function esperarBypass(page, cvd = 1.0) {  
    await new Promise(r => setTimeout(r, 1500));  
    const maxIntentos = Math.round(20 * cvd);
      
    for (let i = 1; i <= maxIntentos; i++) {  
        try {  
            const url = page.url();  
  
            if (url === 'about:blank' || url.trim().length < 10) {  
                await new Promise(r => setTimeout(r, 1000));  
                continue;  
            }  
  
            const titulo = await page.title().catch(() => '');  
            let esDesafio = titulo.toLowerCase().includes('just a moment') || url.includes('challenges.cloudflare.com');  
              
            if (!esDesafio) {  
                const contenido = await page.content();  
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) esDesafio = true;  
            }  
  
            if (esDesafio) {  
                console.log(`⏳ [${i}/${maxIntentos}] Cloudflare activo. Esperando renderizado...`);  
                await new Promise(r => setTimeout(r, 3000));  
            } else {  
                console.log("✅ Bypass completado.");
                return true;  
            }  
        } catch (e) {  
            await new Promise(r => setTimeout(r, 1000));  
        }  
    }  
    return false;  
}

/**
 * Navegación reactiva (Event-Driven) que detiene descargas innecesarias
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
            console.log("🛑 [ASAP] Carga abortada tras detección de selector crítico.");  
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
// 4. EXTRACCIÓN NINJA ADAPTATIVA (Sandbox Adaptativo)
// ============================================================================
async function activarVideoSandbox(page, cvd = 1.0) {  
    console.log("\n🎬 Analizando reproducción adaptativa...");  
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.video-play'];  
    const startTime = Date.now();  
      
    // En lugar de una espera progresiva rígida, el intervalo de clic se escala con el CVD
    let baseWait = Math.round(1500 * cvd);  
      
    while (Date.now() - startTime < 60000) {  
        if (global.videoCapturado) return true;  
  
        try {  
            // Clics lógicos en el centro del DOM para romper overlays publicitarios
            await page.evaluate(() => {  
                const x = window.innerWidth / 2;  
                const y = window.innerHeight / 2;  
                document.elementFromPoint(x, y)?.click();  
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
                        const vid = document.querySelector('video');
                        return vid ? vid.src : null;
                    });
                    if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !src.startsWith('blob:')) {
                        global.videoCapturado = src;
                        return true;
                    }

                    for (const selector of playSelectors) {  
                        const el = await frame.$(selector);  
                        if (el) {  
                            await frame.evaluate((sel) => {  
                                document.querySelector(sel)?.click();  
                            }, selector);  
                        }  
                    }  
                } catch (e) {}  
            }  
  
            if (estadoBuffer.ready || global.videoCapturado) {  
                console.log("⚡ ¡Buffer o Stream detectado! Finalizando de inmediato...");  
                break; 
            } else {  
                console.log(`⏳ Buffer vacío. Espera dinámica de reintento: ${baseWait / 1000}s...`);  
                await new Promise(r => setTimeout(r, baseWait));  
                baseWait = Math.min(baseWait + 1000, 8000);  
            }  
  
        } catch (e) {}  
    }  
    return !!global.videoCapturado;  
}

// ============================================================================
// 5. ORQUESTADOR PRINCIPAL
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

    // Conexión con argumentos optimizados
    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: [
            "--start-maximized", 
            "--no-sandbox", 
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",         // Requerido en Docker para evitar fallas de memoria
            "--disable-accelerated-2d-canvas", // Evita renderizado 2D pesado
            "--disable-gpu"                    // Desactiva la GPU para liberar el Celeron
        ],
        turnstile: true,
        connectOption: { defaultViewport: null }
    });

    // Activar Blindaje de Navegador para neutralizar Popups agresivos
    blindarNavegador(browser, page);

    // CONFIGURACIÓN CRÍTICA PARA DOCKER Y SITIOS LENTOS
    page.setDefaultNavigationTimeout(90000); 

    // INTERCEPCIÓN INTELIGENTE DE RED (Ahorra un ~90% de ancho de banda y renderizado)
    await page.setRequestInterception(true);
    let peticionesBloqueadas = 0;
    page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url().toLowerCase();
        
        // 1. Regla de Oro: Pasar Cloudflare y Turnstile siempre
        if (
            url.includes('cloudflare') || 
            url.includes('challenges') || 
            url.includes('captcha') || 
            url.includes('turnstile')
        ) {
            return req.continue();
        }

        // 2. Bloquear elementos pesados e inútiles para la extracción
        if (['image', 'font', 'media'].includes(type)) {
            peticionesBloqueadas++;
            return req.abort();
        }

        // 3. Bloquear trackers y publicidad que devoran ciclos de CPU del procesador
        const esAnuncioOTracker = [
            '1xbet', 'popads', 'doubleclick', 'google-analytics', 'googletagmanager', 'gtag',
            'onclickads', 'facebook', 'exoclick', 'juicyads', 
            'a-ads', 'coinad', 'histats', 'adskeeper', 'mgid',
            'analytics', 'telemetry', 'tracker', 'anisabi.com'
        ].some(keyword => url.includes(keyword));

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

        // CALCULO DEL CVD: Medición en caliente de CPU y Red
        const cvd = await calcularCVD(page, receta.dominio);

        // --- PASO 1: BÚSQUEDA ---
        let searchUrl = null;
        if (ARG_DOMINIO.includes('jkanime')) {
            searchUrl = `https://${ARG_DOMINIO}/buscar/${encodeURIComponent(ARG_KEYWORD)}`;
        } else if (ARG_DOMINIO.includes('cuevana')) {
            searchUrl = `https://${ARG_DOMINIO}/explorar?s=${encodeURIComponent(ARG_KEYWORD)}`;
        }

        if (searchUrl) {
            console.log(`📡 Navegando directamente a la búsqueda: ${searchUrl}`);
            await navegarYAbortar(page, searchUrl, 'a', false);
        } else {
            // Fallback genérico para otros sitios si no hay URL estructurada
            const initSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
            await navegarYAbortar(page, `https://${receta.dominio}`, initSelector, false);
            await esperarBypass(page, cvd);

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
        await esperarBypass(page, cvd);

        // Extraer resultados del DOM reactivamente (Event-Driven)
        console.log("⏳ Buscando resultados en el DOM...");
        const maxWaitTime = Math.round(15000 * cvd);
        
        const enlaces = await page.waitForFunction((kw) => {
            const normalizar = (texto) => {
                return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            };
            const kwNormalizado = normalizar(kw);
            const targets = Array.from(document.querySelectorAll('a'))
                .map(a => ({ href: a.href, text: a.innerText.trim() }))
                .filter(e => normalizar(e.text).includes(kwNormalizado) && e.href.length > 10);
            
            return targets.length > 0 ? targets : null;
        }, { timeout: maxWaitTime, polling: 300 }, ARG_KEYWORD)
        .then(async (handle) => await handle.jsonValue())
        .catch(() => []);
        
        if (enlaces.length === 0) throw new Error("No se encontraron resultados en la página.");

        // Interacción Panel: Seleccionar Show
        const seleccionIdx = parseInt(await esperarRespuesta('SELECT_SHOW', "Selecciona el show", { resultados: enlaces })) - 1;
        const show = enlaces[seleccionIdx] || enlaces[0];
        const urlBaseFinal = show.href;

        // --- PASO 2: FICHA DEL SHOW (PÁGINA CRÍTICA) ---
        await navegarYAbortar(page, urlBaseFinal, 'body', true);
        await esperarBypass(page, cvd);

        // Interacción Panel: Seleccionar Tipo
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

        // --- PASO 3: CAPTURA FINAL (PÁGINA CRÍTICA) ---
        console.log(`➡️ Navegando al video final: ${targetUrl}`);
        const selectorVideo = '.video-play, #play-button, video, .vjs-big-play-button';
        await navegarYAbortar(page, targetUrl, selectorVideo, true);
        await esperarBypass(page, cvd);

        // Intentar click inicial en botones visibles
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

        // Ejecutar el Sandbox agresivo adaptativo
        await activarVideoSandbox(page, cvd);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace capturado: ${global.videoCapturado}`);
            console.log(`🧹 Rendimiento: Se bloquearon ${peticionesBloqueadas} recursos basura en esta corrida.`);
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