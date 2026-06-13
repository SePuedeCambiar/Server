const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;
global.currentMainPage = null; 
const Decisiones = { showUrl: '', tipo: '', cap: '1' };

// ============================================================================
// METRIC TRACKER CON MONITOREO DE RAM Y AUDITORÍA DE RED V6
// ============================================================================
class MetricTracker {
    constructor(modo) {
        this.modo = modo;
        this.bypassTime = 0; this.searchTime = 0; this.fichaTime = 0;
        this.episodeTime = 0; this.extractionTime = 0; this.totalTime = 0;
        this.exito = false;
        
        // Métricas de RAM
        this.startMem = process.memoryUsage().rss; 
        this.maxMem = this.startMem; 
        this.startTime = Date.now(); this.lapTime = Date.now();

        // Auditoría de Red
        this.redCategorias = {
            document: { peticiones: 0, bytes: 0 },   
            script: { peticiones: 0, bytes: 0 },     
            stylesheet: { peticiones: 0, bytes: 0 }, 
            image: { peticiones: 0, bytes: 0 },      
            font: { peticiones: 0, bytes: 0 },       
            fetch: { peticiones: 0, bytes: 0 },      
            media: { peticiones: 0, bytes: 0 },      
            other: { peticiones: 0, bytes: 0 }       
        };
        this.totalPeticiones = 0;
        this.peticionesBloqueadas = 0;
        this.peticionesPesadas = []; 
    }
    
    lap(fase) {
        const now = Date.now();
        const diff = (now - this.lapTime) / 1000;
        this[fase] = diff;
        this.lapTime = now;
        this.actualizarMemoria();
        console.log(`⏱️  [${this.modo}] ${fase}: ${diff.toFixed(2)}s | RAM: ${this.obtenerRamEnMB()} MB`);
    }

    actualizarMemoria() {
        const currentMem = process.memoryUsage().rss;
        if (currentMem > this.maxMem) this.maxMem = currentMem;
    }

    obtenerRamEnMB() {
        return (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    }

    registrarRespuesta(type, size, url) {
        this.totalPeticiones++;
        const cat = this.redCategorias[type] ? type : 'other';
        this.redCategorias[cat].peticiones++;
        this.redCategorias[cat].bytes += size;

        if (size > 100 * 1024) {
            this.peticionesPesadas.push({
                url: url.substring(0, 60) + "...",
                tipo: type,
                peso: (size / 1024).toFixed(1) + " KB"
            });
        }
    }

    registrarBloqueo() {
        this.peticionesBloqueadas++;
    }

    finalizar(exito) {
        this.totalTime = (Date.now() - this.startTime) / 1000;
        this.exito = exito;
        this.actualizarMemoria();
        this.ramMaximaMB = (this.maxMem / 1024 / 1024).toFixed(1);
        this.ramDeltaMB = ((this.maxMem - this.startMem) / 1024 / 1024).toFixed(1);
    }
}

// ============================================================================
// SISTEMA DE CONTROL DE PESTAÑAS (TAB PINNING)
// ============================================================================
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
// INSPECTOR DE ESTADO DE CAPTCHA Y DOM
// ============================================================================
async function esperarBypass(page) {
    await new Promise(r => setTimeout(r, 1500));
    
    for (let i = 1; i <= 20; i++) {
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
                console.log(`⏳ [${i}/20] Cloudflare activo. Esperando renderizado...`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                return true; 
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return false;
}

// ============================================================================
// FUNCIÓN NINJA: NAVEGACIÓN Y ABORTO SEGURO (ASAP V6)
// ============================================================================
async function navegarYAbortar(page, url, selector, modo, esPaginaCritica = false) {
    if (modo === 'OPTIMIZADO') {
        try {
            // Navegamos esperando domcontentloaded
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            
            // 1. Si es página crítica (Ficha o Episodio), necesitamos que Javascript se ejecute por completo.
            // NO abortamos la carga con window.stop(), pero el bloqueo de recursos sigue protegiendo la CPU.
            if (esPaginaCritica) {
                await page.waitForSelector(selector, { timeout: 12000 });
                return;
            }

            // 2. Si es una página no crítica (búsqueda), comprobamos si hay Cloudflare activo
            const currentUrl = page.url();
            const titulo = await page.title().catch(() => '');
            const esCF = titulo.toLowerCase().includes('just a moment') || currentUrl.includes('challenges.cloudflare.com');
            
            // 3. Solo abortamos la carga de búsqueda si NO estamos ante un desafío de Cloudflare
            if (!esCF) {
                await page.waitForSelector(selector, { timeout: 10000 });
                await page.evaluate(() => window.stop()).catch(() => {});
                console.log("🛑 [ASAP] Carga de página no crítica abortada para ahorrar recursos.");
            }
        } catch (e) {
            // Continuar en caso de timeouts lentos
        }
    } else {
        await page.goto(url, { waitUntil: 'networkidle2' });
    }
}

// ============================================================================
// EXTRACCIÓN DINÁMICA DE STREAMING
// ============================================================================
async function activarVideoSandbox(page) {
    console.log("\n🎬 Analizando reproducción adaptativa...");
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.video-play'];
    const startTime = Date.now();
    
    let currentWait = 2000;
    
    while (Date.now() - startTime < 60000) {
        if (global.videoCapturado) return true;

        try {
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

            if (estadoBuffer.ready) {
                console.log(`⚡ ¡Buffer del reproductor detectado! Sincronizando...`);
                await new Promise(r => setTimeout(r, 1500));
            } else {
                console.log(`⏳ Buffer vacío. Reintentando en ${currentWait / 1000}s...`);
                await new Promise(r => setTimeout(r, currentWait));
                currentWait = Math.min(currentWait + 1500, 8000);
            }

        } catch (e) {}
    }
    return !!global.videoCapturado;
}

// ============================================================================
// MOTOR DE EJECUCIÓN DEL BENCHMARK
// ============================================================================
async function ejecutarCorrida(modo, receta, keyword, decisiones) {
    console.log(`\n🚀 Iniciando corrida en modo [${modo}]...`);
    global.videoCapturado = null;
    const tracker = new MetricTracker(modo);

    const { browser, page } = await connect({
        headless: false, 
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

    // INTERCEPTOR CON REGISTRO DE BLOQUEOS (V3 de Precisión)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url().toLowerCase();
        
        if (modo === 'OPTIMIZADO') {
            if (
                url.includes('cloudflare') || 
                url.includes('challenges') || 
                url.includes('captcha') || 
                url.includes('turnstile')
            ) {
                return req.continue();
            }

            if (['image', 'font', 'media'].includes(type)) {
                tracker.registrarBloqueo();
                return req.abort();
            }

            const esAnuncioOTracker = [
                '1xbet', 'popads', 'doubleclick', 'google-analytics', 'googletagmanager', 'gtag',
                'onclickads', 'facebook', 'exoclick', 'juicyads', 
                'a-ads', 'coinad', 'histats', 'adskeeper', 'mgid',
                'analytics', 'telemetry', 'tracker', 'anisabi.com'
            ].some(keyword => url.includes(keyword));

            if (esAnuncioOTracker && ['script', 'xhr', 'fetch', 'other'].includes(type)) {
                tracker.registrarBloqueo();
                return req.abort();
            }
        }

        req.continue();
    });

    page.on('response', (res) => {
        const url = res.url().toLowerCase();
        const type = res.request().resourceType();
        
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
            global.videoCapturado = res.url();
        }

        try {
            const headers = res.headers();
            const size = parseInt(headers['content-length'] || 0, 10);
            tracker.registrarRespuesta(type, size, res.url());
        } catch (e) {}
    });

    try {
        // --- 1. BYPASS (Home) ---
        if (modo === 'OPTIMIZADO') {
            await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        } else {
            await page.goto(`https://${receta.dominio}`, { waitUntil: 'networkidle2' });
        }
        await esperarBypass(page);
        tracker.lap("bypassTime");

        // --- 2. BÚSQUEDA ---
        let searchUrl = null;
        if (receta.dominio.includes('jkanime')) searchUrl = `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}`;
        else if (receta.dominio.includes('cuevana')) searchUrl = `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}`;

        if (searchUrl) {
            // La búsqueda NO es página crítica (esPaginaCritica = false)
            await navegarYAbortar(page, searchUrl, 'a', modo, false);
        } else {
            const sSelector = receta.searchSelector || 'input[name="q"]';
            await page.waitForSelector(sSelector);
            await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);
            await page.keyboard.press('Enter');
        }
        await esperarBypass(page);
        tracker.lap("searchTime");

        // --- 3. FICHA ---
        const showUrl = decisiones.showUrl;
        // La ficha SÍ es crítica porque contiene la lista de episodios renderizada por JS (esPaginaCritica = true)
        await navegarYAbortar(page, showUrl, 'body', modo, true);
        await esperarBypass(page);
        tracker.lap("fichaTime");

        // --- 4. EPISODIO ---
        let targetUrl = showUrl;
        if (decisiones.tipo === 's') {
            targetUrl = receta.episodeUrlPattern 
                ? receta.episodeUrlPattern.replace('{showUrl}', showUrl.replace(/\/$/, "")).replace('{number}', decisiones.cap)
                : `${showUrl.replace(/\/$/, "")}/${decisiones.cap}/`;
        }

        const selectorVideo = '.video-play, #play-button, video, .vjs-big-play-button';
        // El episodio SÍ es página crítica porque necesita montar el reproductor (esPaginaCritica = true)
        await navegarYAbortar(page, targetUrl, selectorVideo, modo, true);
        await esperarBypass(page);
        tracker.lap("episodeTime");

        // --- 5. EXTRACCIÓN ---
        const exito = await activarVideoSandbox(page);
        tracker.lap("extractionTime");
        tracker.finalizar(exito);

    } catch (e) {
        tracker.finalizar(false);
        console.error(`❌ Error en modo ${modo}: ${e.message}`);
    } finally {
        await browser.close();
    }
    return tracker;
}

// ============================================================================
// CONFIGURACIÓN INICIAL DEL TEST
// ============================================================================
async function main() {
    console.log("======================================================");
    console.log("🧪 BENCHMARK ULTRA-CELERON: MEDICIÓN DE RAM Y TIEMPOS");
    console.log("======================================================");

    const configsDir = path.join(__dirname, 'configs');
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    archivos.forEach((f, i) => console.log(`${i + 1}. ${f.replace('_receta.json', '')}`));
    
    const selReceta = parseInt(await pregunta("\n👉 Selecciona receta: ")) - 1;
    const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[selReceta]), 'utf8'));
    const keyword = await pregunta(`📺 Keyword para ${receta.dominio}: `);

    console.log("\n🛠  Conectando para configurar parámetros del test...");
    const { browser, page } = await connect({ headless: false, args: ["--start-maximized"], turnstile: true });
    
    blindarNavegador(browser, page);

    try {
        await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);
        
        let searchUrl = receta.dominio.includes('jkanime') ? `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}` : 
                        (receta.dominio.includes('cuevana') ? `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}` : null);
        
        if (searchUrl) {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        } else {
            const sSelector = receta.searchSelector || 'input[name="q"]';
            await page.waitForSelector(sSelector);
            await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);
            await page.keyboard.press('Enter');
        }
        await esperarBypass(page);

        console.log("⏳ Esperando renderizado de resultados...");
        let enlaces = [];
        for (let i = 0; i < 5; i++) {
            enlaces = await page.evaluate((kw) => {
                return Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText.trim() }))
                    .filter(e => e.text.toLowerCase().includes(kw.toLowerCase()) && e.href.length > 10);
            }, keyword.toLowerCase());
            if (enlaces.length > 0) break;
            await new Promise(r => setTimeout(r, 2000));
        }

        if (enlaces.length === 0) {
            throw new Error("No se encontraron resultados en el DOM.");
        }

        console.log("\n======================================================");
        enlaces.slice(0, 15).forEach((e, i) => console.log(`${i+1}. ${e.text}`));
        console.log("======================================================");
        
        const selShow = parseInt(await pregunta("\n👉 Selecciona el show: ")) - 1;
        const showUrl = enlaces[selShow]?.href || enlaces[0].href;
        const tipo = await pregunta(`❓ ¿Es (S)erie o (P)elícula?: `);
        let cap = "1";
        if (tipo.toLowerCase() === 's') cap = await pregunta(`🔢 Cap: `);
        
        const decisiones = { showUrl, tipo: tipo.toLowerCase(), cap };
        await browser.close();

        // --- INICIO DEL BENCHMARK ---
        const mVainilla = await ejecutarCorrida('VAINILLA', receta, keyword, decisiones);
        const mOptimizado = await ejecutarCorrida('OPTIMIZADO', receta, keyword, decisiones);

        console.log("\n======================================================");
        console.log("📊 REPORTE DE TIEMPOS Y RECURSOS");
        console.log("======================================================");
        console.table([
            { Fase: "Bypass (s)", Vainilla: mVainilla.bypassTime.toFixed(2), Optimizado: mOptimizado.bypassTime.toFixed(2) },
            { Fase: "Búsqueda (s)", Vainilla: mVainilla.searchTime.toFixed(2), Optimizado: mOptimizado.searchTime.toFixed(2) },
            { Fase: "Ficha (s)", Vainilla: mVainilla.fichaTime.toFixed(2), Optimizado: mOptimizado.fichaTime.toFixed(2) },
            { Fase: "Episodio (s)", Vainilla: mVainilla.episodeTime.toFixed(2), Optimizado: mOptimizado.episodeTime.toFixed(2) },
            { Fase: "Extracción (s)", Vainilla: mVainilla.extractionTime.toFixed(2), Optimizado: mOptimizado.extractionTime.toFixed(2) },
            { Fase: "TIEMPO TOTAL (s)", Vainilla: mVainilla.totalTime.toFixed(2), Optimizado: mOptimizado.totalTime.toFixed(2) },
            { Fase: "PICO RAM NODE (MB)", Vainilla: mVainilla.ramMaximaMB + " MB", Optimizado: mOptimizado.ramMaximaMB + " MB" },
            { Fase: "DELTA RAM (MB)", Vainilla: mVainilla.ramDeltaMB + " MB", Optimizado: mOptimizado.ramDeltaMB + " MB" },
            { Fase: "Éxito", Vainilla: mVainilla.exito ? "SÍ ✅" : "NO ❌", Optimizado: mOptimizado.exito ? "SÍ ✅" : "NO ❌" }
        ]);

        // --- REPORTE DETALLADO DE AUDITORÍA DE RED ---
        console.log("\n======================================================");
        console.log("📊 AUDITORÍA DE RED: TIPO DE RECURSOS DESCARGADOS");
        console.log("======================================================");
        
        const formatearKB = (bytes) => (bytes / 1024).toFixed(1) + " KB";
        
        console.table([
            { 
                Recurso: "HTML Base (Documentos)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.document.peticiones} | ${formatearKB(mVainilla.redCategorias.document.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.document.peticiones} | ${formatearKB(mOptimizado.redCategorias.document.bytes)}` 
            },
            { 
                Recurso: "JavaScript (Scripts)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.script.peticiones} | ${formatearKB(mVainilla.redCategorias.script.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.script.peticiones} | ${formatearKB(mOptimizado.redCategorias.script.bytes)}` 
            },
            { 
                Recurso: "CSS (Stylesheets)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.stylesheet.peticiones} | ${formatearKB(mVainilla.redCategorias.stylesheet.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.stylesheet.peticiones} | ${formatearKB(mOptimizado.redCategorias.stylesheet.bytes)}` 
            },
            { 
                Recurso: "Imágenes (Images)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.image.peticiones} | ${formatearKB(mVainilla.redCategorias.image.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.image.peticiones} | ${formatearKB(mOptimizado.redCategorias.image.bytes)}` 
            },
            { 
                Recurso: "Fuentes Web (Fonts)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.font.peticiones} | ${formatearKB(mVainilla.redCategorias.font.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.font.peticiones} | ${formatearKB(mOptimizado.redCategorias.font.bytes)}` 
            },
            { 
                Recurso: "APIs (Fetch / XHR)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.fetch.peticiones} | ${formatearKB(mVainilla.redCategorias.fetch.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.fetch.peticiones} | ${formatearKB(mOptimizado.redCategorias.fetch.bytes)}` 
            },
            { 
                Recurso: "Media (Audio de fondo)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.media.peticiones} | ${formatearKB(mVainilla.redCategorias.media.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.media.peticiones} | ${formatearKB(mOptimizado.redCategorias.media.bytes)}` 
            },
            { 
                Recurso: "Otros (Trackers, Ads)", 
                "Vainilla (Cant | Peso)": `${mVainilla.redCategorias.other.peticiones} | ${formatearKB(mVainilla.redCategorias.other.bytes)}`, 
                "Optimizado (Cant | Peso)": `${mOptimizado.redCategorias.other.peticiones} | ${formatearKB(mOptimizado.redCategorias.other.bytes)}` 
            },
            { 
                Recurso: "❌ TOTAL PETICIONES BLOQUEADAS", 
                "Vainilla (Cant | Peso)": "0", 
                "Optimizado (Cant | Peso)": `${mOptimizado.peticionesBloqueadas}` 
            }
        ]);

        // --- REPORTE DE ARCHIVOS PESADOS (Culpables del consumo) ---
        if (mOptimizado.peticionesPesadas.length > 0 || mVainilla.peticionesPesadas.length > 0) {
            console.log("\n⚠️ RECURSOS PESADOS DETECTADOS (>100 KB):");
            console.log("Vainilla (Top pesados):");
            console.table(mVainilla.peticionesPesadas.slice(0, 5));
            
            console.log("Optimizado (Top pesados):");
            console.table(mOptimizado.peticionesPesadas.slice(0, 5));
        }

    } catch (error) {
        console.error(`❌ Ocurrió un fallo en el Setup: ${error.message}`);
        await browser.close().catch(() => {});
    }

    rl.close();
}

main();