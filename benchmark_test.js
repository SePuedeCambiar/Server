const { connect } = require('puppeteer-real-browser');  
const fs = require('fs');  
const path = require('path');  
const readline = require('readline');  
  
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });  
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));  
  
global.videoCapturado = null;  
global.currentMainPage = null;  
  
// ============================================================================  
// PROFILER DE RENDIMIENTO: CÁLCULO DE COEFICIENTE DINÁMICO (CVD)  
// ============================================================================  
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
        // Cargamos una pequeña imagen o robots.txt para medir RTT puro
        await page.goto(`https://${dominio}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        rtt = Date.now() - startNet;
    } catch(e) {}

    // Valores de referencia en hardware de alto rendimiento
    const baseCPU = 15;  // PC potente tarda ~15ms en el bucle
    const baseRTT = 80;  // Latencia base de red rápida en ms

    const cpuScore = Math.max(1.0, cpuTime / baseCPU);
    const rttScore = Math.max(1.0, rtt / baseRTT);

    // Damos un 40% de peso a la capacidad del CPU y 60% a la latencia de red
    let cvd = (cpuScore * 0.4) + (rttScore * 0.6);
    
    // Limitamos el multiplicador para evitar congelamientos (Min: 1.0, Max: 4.5)
    cvd = Math.max(1.0, Math.min(4.5, cvd));

    console.log(`📊 REPORTE DE PROFILING:`);
    console.log(`   - CPU Local Score: ${cpuScore.toFixed(2)}x (Bucle en ${cpuTime}ms)`);
    console.log(`   - Red RTT Score:   ${rttScore.toFixed(2)}x (${rtt}ms)`);
    console.log(`   - Coeficiente de Velocidad Dinámico (CVD): ${cvd.toFixed(2)}x`);
    
    return cvd;
}

// ============================================================================  
// METRIC TRACKER CON MONITOREO DE RAM  
// ============================================================================  
class MetricTracker {  
    constructor(modo) {  
        this.modo = modo;  
        this.bypassTime = 0; this.searchTime = 0; this.fichaTime = 0;  
        this.episodeTime = 0; this.extractionTime = 0; this.totalTime = 0;  
        this.exito = false;  
          
        this.startMem = process.memoryUsage().rss;  
        this.maxMem = this.startMem;  
        this.startTime = Date.now(); this.lapTime = Date.now();  
  
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
async function esperarBypass(page, cvd = 1.0) {  
    await new Promise(r => setTimeout(r, 1500));  
    const maxIntentos = Math.round(20 * cvd); // Más intentos si la PC es lenta
      
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
                return true;  
            }  
        } catch (e) {  
            await new Promise(r => setTimeout(r, 1000));  
        }  
    }  
    return false;  
}  
  
// ============================================================================  
// NAVEGACIÓN EVENT-DRIVEN (ASAP V7)  
// ============================================================================  
async function navegarYAbortar(page, url, selector, modo, esPaginaCritica = false) {  
    if (modo === 'OPTIMIZADO') {  
        try {  
            // Solo esperamos domcontentloaded para máxima rapidez  
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
    } else {  
        await page.goto(url, { waitUntil: 'networkidle2' });  
    }  
}  
  
// ============================================================================  
// EXTRACCIÓN NINJA ADAPTATIVA (SIN LIMITES RIGIDOS)  
// ============================================================================  
async function activarVideoSandbox(page, cvd = 1.0) {  
    console.log("\n🎬 Analizando reproducción adaptativa...");  
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.video-play'];  
    const startTime = Date.now();  
      
    // En lugar de una espera progresiva, el intervalo de clic se escala con el CVD
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
                break; // Detener bucle para avanzar ASAP  
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
// MOTOR DE EJECUCIÓN DEL BENCHMARK  
// ============================================================================  
async function ejecutarCorrida(modo, receta, keyword, decisiones, cvd = 1.0) {  
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
  
    // INTERCEPTOR CON REGISTRO DE BLOQUEOS  
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
        await esperarBypass(page, cvd);  
        tracker.lap("bypassTime");  
  
        // --- 2. BÚSQUEDA ---  
        let searchUrl = null;  
        if (receta.dominio.includes('jkanime')) searchUrl = `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}`;  
        else if (receta.dominio.includes('cuevana')) searchUrl = `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}`;  
  
        if (searchUrl) {  
            await navegarYAbortar(page, searchUrl, 'a', modo, false);  
        } else {  
            const sSelector = receta.searchSelector || 'input[name="q"]';  
            await page.waitForSelector(sSelector);  
            await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);  
            await page.keyboard.press('Enter');  
        }  
        await esperarBypass(page, cvd);  
        tracker.lap("searchTime");  
  
        // --- 3. FICHA ---  
        const showUrl = decisiones.showUrl;  
        await navegarYAbortar(page, showUrl, 'body', modo, true);  
        await esperarBypass(page, cvd);  
        tracker.lap("fichaTime");  
  
        // --- 4. EPISODIO ---  
        let targetUrl = showUrl;  
        if (decisiones.tipo === 's') {  
            targetUrl = receta.episodeUrlPattern  
                ? receta.episodeUrlPattern.replace('{showUrl}', showUrl.replace(/\/$/, "")).replace('{number}', decisiones.cap)  
                : `${showUrl.replace(/\/$/, "")}/${decisiones.cap}/`;  
        }  
  
        const selectorVideo = '.video-play, #play-button, video, .vjs-big-play-button';  
        await navegarYAbortar(page, targetUrl, selectorVideo, modo, true);  
        await esperarBypass(page, cvd);  
        tracker.lap("episodeTime");  
  
        // --- 5. EXTRACCIÓN ---  
        const exito = await activarVideoSandbox(page, cvd);  
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
    console.log("🧪 BENCHMARK ULTRA-CELERON: PROFILING Y MEDICIÓN EVENT-DRIVEN");  
    console.log("======================================================");  
  
    const configsDir = path.join(__dirname, 'configs');  
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));  
    archivos.forEach((f, i) => console.log(`${i + 1}. ${f.replace('_receta.json', '')}`));  
      
    const selReceta = parseInt(await pregunta("\n👉 Selecciona receta: ")) - 1;  
    const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[selReceta]), 'utf8'));  
    const keyword = await pregunta(`📺 Keyword para ${receta.dominio}: `);  
  
    console.log("\n🛠  Iniciando navegador y ejecutando profiling...");  
    const { browser, page } = await connect({ headless: false, args: ["--start-maximized"], turnstile: true });  
      
    blindarNavegador(browser, page);  
  
    try {  
        // Calculamos el Coeficiente de Velocidad Dinámico
        const cvd = await calcularCVD(page, receta.dominio);

        await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });  
        await esperarBypass(page, cvd);  
          
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
        await esperarBypass(page, cvd);  
  
        console.log("⏳ Buscando resultados en el DOM (Event-Driven)...");  
        // Esperamos a que existan enlaces válidos utilizando una función reactiva del DOM
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
        }, { timeout: maxWaitTime, polling: 300 }, keyword)
        .then(async (handle) => await handle.jsonValue())
        .catch(() => []);
  
        if (enlaces.length === 0) {  
            throw new Error("No se encontraron resultados en el DOM tras el tiempo de tolerancia.");  
        }  
  
        console.log("\n======================================================");  
        enlaces.slice(0, 15).forEach((e, i) => console.log(`${i+1}. ${e.text}`));  
        console.log("======================================================");  
          
        const selShow = parseInt(await pregunta("\n👉 Selecciona el show: ")) - 1;  
        const showUrl = enlaces[selShow]?.href || enlaces[0].href;  
        const tipo = await pregunta("❓ ¿Es (S)erie o (P)elícula?: ");  
        let cap = "1";  
        if (tipo.toLowerCase() === 's') cap = await pregunta("🔢 Cap: ");  
          
        const decisiones = { showUrl, tipo: tipo.toLowerCase(), cap };  
        await browser.close();  
  
        // --- INICIO DEL BENCHMARK ---  
        const mVainilla = await ejecutarCorrida('VAINILLA', receta, keyword, decisiones, cvd);  
        const mOptimizado = await ejecutarCorrida('OPTIMIZADO', receta, keyword, decisiones, cvd);  
  
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