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
// 2. FUNCIONES DE SOPORTE, NAVEGACIÓN Y ABORTO (ASAP)
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
 * Bypass de Cloudflare optimizado sin tiempos muertos innecesarios
 */
async function esperarBypass(page, maxIntentos = 30) {
    console.log("🛡️ Verificando estado del bypass...");
    await new Promise(r => setTimeout(r, 1500)); // Bajamos de 4s a 1.5s para ahorrar tiempo muerto
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const url = page.url();
            
            // Si la URL está vacía por retraso de red, esperamos un segundo
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
        } catch (e) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return false;
}

/**
 * Función asíncrona inteligente para realizar la carga ASAP y abortar red basura
 */
async function navegarYAbortar(page, url, selector, esPaginaCritica = false) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        // Fichas y Episodios necesitan que corra Javascript nativo (no las abortamos con window.stop)
        if (esPaginaCritica) {
            await page.waitForSelector(selector, { timeout: 12000 });
            return;
        }

        // Búsquedas normales las abortamos inmediatamente si no hay un captcha en pantalla
        const currentUrl = page.url();
        const titulo = await page.title().catch(() => '');
        const esCF = titulo.toLowerCase().includes('just a moment') || currentUrl.includes('challenges.cloudflare.com');
        
        if (!esCF) {
            await page.waitForSelector(selector, { timeout: 10000 });
            await page.evaluate(() => window.stop()).catch(() => {});
            console.log("🛑 [ASAP] Carga de página abortada para ahorrar recursos.");
        }
    } catch (e) {
        // Continuar silenciosamente ante timeouts lentos
    }
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

/**
 * FUNCIÓN NINJA: Captura el stream rompiendo capas de anuncios y forzando el Play
 */
async function activarVideoSandbox(page) {
    console.log("\n🎬 Buscando reproductor y forzando ejecución ninja...");
    const startTime = Date.now();
    
    while (Date.now() - startTime < 45000) { 
        if (global.videoCapturado) return true;
        
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // Truco 1: Robar el src directo si ya existe
                const src = await frame.evaluate(() => {
                    const vid = document.querySelector('video');
                    return vid ? vid.src : null;
                });
                if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !src.startsWith('blob:')) {
                    global.videoCapturado = src;
                    return true;
                }

                // Truco 2: Mute + Play forzado (Evita el bloqueo de Autoplay de Chrome)
                await frame.evaluate(() => {
                    const videos = document.querySelectorAll('video');
                    videos.forEach(v => {
                        v.muted = true; 
                        v.play().catch(() => {});
                    });
                    
                    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', '.jw-icon-display', '.plyr__control--overlaid'];
                    playSelectors.forEach(sel => {
                        const btn = document.querySelector(sel);
                        if (btn) btn.click();
                    });
                });
            } catch (e) {}
        }
        
        // Truco 3: Click físico en el centro de la pantalla para romper overlays
        try {
            const { width, height } = await page.evaluate(() => ({ 
                width: window.innerWidth, 
                height: window.innerHeight 
            }));
            await page.mouse.click(width / 2, height / 2);
        } catch(e) {}

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

    // Conexión con argumentos gráficos y de memoria ultra-optimizados para Celeron
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

    // CONFIGURACIÓN CRÍTICA PARA DOCKER Y SITIOS LENTOS
    page.setDefaultNavigationTimeout(90000); 
    await page.evaluateOnNewDocument(() => { window.open = () => null; });

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

        // --- PASO 1: BÚSQUEDA ---
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
        // La ficha de la serie SÍ es crítica porque contiene la lista de episodios renderizada por JS
        await navegarYAbortar(page, urlBaseFinal, 'body', true);
        await esperarBypass(page);

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

        // --- PASO 3: CAPTURA FINAL ---
        console.log(`➡️ Navegando al video final: ${targetUrl}`);
        const selectorVideo = '.video-play, #play-button, video, .vjs-big-play-button';
        // El episodio SÍ es página crítica porque necesita montar el reproductor de video
        await navegarYAbortar(page, targetUrl, selectorVideo, true);
        await esperarBypass(page);

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

        // Ejecutar el Sandbox agresivo
        await activarVideoSandbox(page);

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