const { connect } = require('puppeteer-real-browser');  
const fs = require('fs');  
const path = require('path');  
const readline = require('readline');  
  
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });  
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));  
  
global.videoCapturado = null;  
global.frameOrigenCaptura = null; // Guardará el iframe de origen
global.currentMainPage = null;  

// ============================================================================  
// PROFILER DINÁMICO: HARDWARE Y RED
// ============================================================================  
async function ejecutarProfiling(page, dominio) {
    console.log("⏱  Iniciando Profiling de Latencia y Hardware...");
    const startCPU = Date.now();
    for (let i = 0; i < 5000000; i++) { Math.sqrt(i); }
    const cpuTime = Date.now() - startCPU; 
    
    let rtt = 150; 
    try {
        const startNet = Date.now();
        await page.goto(`https://${dominio}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        rtt = Date.now() - startNet;
    } catch(e) {}

    const cpuScore = Math.max(1.0, cpuTime / 15);
    const networkScore = Math.max(1.0, rtt / 80);

    return {
        cpuTime, cpuScore, rtt, networkScore,
        cvd: { cpu: cpuScore, net: networkScore }
    };
}

// ============================================================================  
// HEURÍSTICA DE TAMAÑO FÍSICO INMUNE A CORS (A NIVEL DE PUPPETEER)
// ============================================================================  
async function obtenerIframeVideoRealPuppeteer(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const urlStr = frame.url();
            if (!urlStr || urlStr.includes('about:blank') || urlStr.includes('cuevana') || urlStr.includes('jkanime')) {
                continue; 
            }
            
            const frameElement = await frame.frameElement();
            if (frameElement) {
                const rect = await frameElement.boundingBox();
                if (rect) {
                    if (rect.width > 250 && rect.height > 120) {
                        return urlStr;
                    }
                } else {
                    return urlStr;
                }
            }
        } catch (e) {}
    }
    return null;
}

// ============================================================================  
// ESPERA DETERMINISTA Y PING AL CDN (Protocol-Level)
// ============================================================================  
async function esperarYMedirCDN(page) {
    console.log("⏳ Esperando inyección del reproductor de video real...");
    const start = Date.now();
    let videoSrc = null;

    while (Date.now() - start < 8000) {
        videoSrc = await obtenerIframeVideoRealPuppeteer(page);
        if (videoSrc) {
            console.log(`🎯 ¡Reproductor GIGANTE detectado tras ${Date.now() - start}ms! -> ${videoSrc}`);
            break;
        }
        await new Promise(r => setTimeout(r, 400));
    }

    if (!videoSrc) {
        console.log("⚠️ No se detectó un reproductor válido por tamaño. Usando fallback de 800ms.");
        return 800;
    }

    const targetHost = new URL(videoSrc).hostname;
    console.log(`⚡ CDN Real Aislado: [${targetHost}]. Midiendo latencia directa...`);
    
    const rttHost = await page.evaluate(async (host) => {
        const start = Date.now();
        try {
            await fetch(`https://${host}/favicon.ico`, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            return Date.now() - start;
        } catch (e) { return 800; }
    }, targetHost);

    console.log(`📡 Latencia directa con el servidor de video [${targetHost}]: ${rttHost}ms`);
    return rttHost;
}

// ============================================================================  
// EXTRACCIÓN SANDBOX (MÉTODO NINJA DE TU REPRODUCTOR.JS ORIGINAL)
// ============================================================================  
async function activarVideoSandbox(page, rttHost = null, profiling = null) {
    const modoStr = rttHost ? 'OPTIMIZADO' : 'VAINILLA';
    console.log(`\n🎬 Iniciando Extracción Sandbox [${modoStr}]...`);
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', '.jw-icon-display', '.plyr__control--overlaid'];
    const startTime = Date.now();
    
    const cpuScore = profiling ? profiling.cvd.cpu : 1.0;
    let baseWait = rttHost ? Math.max(500, rttHost) : 2000;
    
    let k = 0; 
    
    while (Date.now() - startTime < 60000) { 
        if (global.videoCapturado) return true;
        try {
            // Truco de click físico en el centro (De tu archivo original)
            const { width, height } = await page.evaluate(() => ({ 
                width: window.innerWidth, 
                height: window.innerHeight 
            }));
            await page.mouse.click(width / 2, height / 2);

            const frames = page.frames();
            for (const frame of frames) {
                try {
                    if (frame.url().includes('about:blank')) continue;
                    
                    // Truco 1 (Original): Robar src directo de la etiqueta video
                    const src = await frame.evaluate(() => {
                        const vid = document.querySelector('video');
                        return vid ? vid.src : null;
                    });
                    if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !src.startsWith('blob:')) {
                        global.videoCapturado = src;
                        global.frameOrigenCaptura = frame.url(); // Guardamos el frame que lo inyectó
                        return true;
                    }
                    
                    // Truco 2 (Original): Mute + Play forzado
                    await frame.evaluate(() => {
                        const videos = document.querySelectorAll('video');
                        videos.forEach(v => {
                            v.muted = true; 
                            v.play().catch(() => {});
                        });
                    });

                    // Clic en botones de play
                    for (const selector of playSelectors) {
                        const el = await frame.$(selector);
                        if (el) await frame.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
                    }
                } catch (e) {}
            }

            if (global.videoCapturado) {
                break;
            } else {
                let waitTime;
                if (!rttHost) {
                    waitTime = 2000; 
                } else if (k < 3) {
                    waitTime = baseWait; 
                } else {
                    const factor = 1.2 + (cpuScore * 0.05);
                    waitTime = Math.round(baseWait * Math.pow(factor, k - 2));
                    waitTime = Math.min(8000, waitTime);
                }

                console.log(`⏳ [${modoStr}] Toque #${k} - Espera de ${waitTime}ms...`);
                await new Promise(r => setTimeout(r, waitTime));
                k++;
            }
        } catch (e) {}
    }
    return !!global.videoCapturado;
}

// ============================================================================  
// METRICS TRACKER REFORMADO
// ============================================================================  
class MetricTracker {  
    constructor(modo) {  
        this.modo = modo; 
        this.videoCapturado = null; 
        this.frameOrigen = null;
        this.bypassTime = 0; this.searchTime = 0; this.fichaTime = 0;  
        this.episodeTime = 0; this.extractionTime = 0; this.totalTime = 0; this.exito = false;  
        this.startMem = process.memoryUsage().rss; this.maxMem = this.startMem;  
        this.startTime = Date.now(); this.lapTime = Date.now();  
        this.redCategorias = { document: { peticiones: 0, bytes: 0 }, script: { peticiones: 0, bytes: 0 }, stylesheet: { peticiones: 0, bytes: 0 }, image: { peticiones: 0, bytes: 0 }, font: { peticiones: 0, bytes: 0 }, fetch: { peticiones: 0, bytes: 0 }, media: { peticiones: 0, bytes: 0 }, other: { peticiones: 0, bytes: 0 } };  
        this.totalPeticiones = 0; this.peticionesBloqueadas = 0; this.peticionesPesadas = [];  
    }  
    lap(fase) {  
        const now = Date.now(); const diff = (now - this.lapTime) / 1000;  
        this[fase] = diff; this.lapTime = now; this.actualizarMemoria();  
        console.log(`⏱️  [${this.modo}] ${fase}: ${diff.toFixed(2)}s | RAM: ${this.obtenerRamEnMB()} MB`);  
    }  
    actualizarMemoria() { const currentMem = process.memoryUsage().rss; if (currentMem > this.maxMem) this.maxMem = currentMem; }  
    obtenerRamEnMB() { return (process.memoryUsage().rss / 1024 / 1024).toFixed(1); }  
    registrarRespuesta(type, size, url) {  
        this.totalPeticiones++; const cat = this.redCategorias[type] ? type : 'other';  
        this.redCategorias[cat].peticiones++; this.redCategorias[cat].bytes += size;  
    }  
    registrarBloqueo() { this.peticionesBloqueadas++; }  
    finalizar(exito) {  
        this.totalTime = (Date.now() - this.startTime) / 1000; this.exito = exito; this.actualizarMemoria();  
        this.ramMaximaMB = (this.maxMem / 1024 / 1024).toFixed(1); this.ramDeltaMB = ((this.maxMem - this.startMem) / 1024 / 1024).toFixed(1);  
    }  
}  
  
function blindarNavegador(browser, mainPage) {  
    global.currentMainPage = mainPage;  
    mainPage.evaluateOnNewDocument(() => { window.open = () => null; });  
    browser.on('targetcreated', async (target) => {  
        if (target.type() === 'page') {  
            const page = await target.page();  
            if (page && page !== global.currentMainPage) { await page.close().catch(() => {}); }  
        }  
    });  
}  
  
async function esperarBypass(page, profiling) {  
    const maxIntentos = Math.round(20 * profiling.cvd.net);  
    for (let i = 1; i <= maxIntentos; i++) {  
        try {  
            const url = page.url();  
            if (url === 'about:blank' || url.trim().length < 10) { await new Promise(r => setTimeout(r, 1000)); continue; }  
            const titulo = await page.title().catch(() => '');  
            let esDesafio = titulo.toLowerCase().includes('just a moment') || url.includes('challenges.cloudflare.com');  
            if (!esDesafio) {  
                const contenido = await page.content();  
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) esDesafio = true;  
            }  
            if (esDesafio) {  
                console.log(`⏳ [${i}/${maxIntentos}] Cloudflare activo...`);  
                await new Promise(r => setTimeout(r, 3000));  
            } else { return true; }  
        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }  
    }  
    return false;  
}  
  
async function navegarYAbortar(page, url, selector, modo, esPaginaCritica = false) {  
    if (modo === 'OPTIMIZADO') {  
        try {  
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });  
            if (esPagicaCritica) { await page.waitForSelector(selector, { timeout: 12000 }); return; }  
            const currentUrl = page.url(); const titulo = await page.title().catch(() => '');  
            if (!(titulo.toLowerCase().includes('just a moment') || currentUrl.includes('challenges.cloudflare.com'))) {  
                await page.waitForSelector(selector, { timeout: 10000 });  
                await page.evaluate(() => window.stop()).catch(() => {});  
            }  
        } catch (e) {}  
    } else { await page.goto(url, { waitUntil: 'networkidle2' }); }  
}  

async function clickInteligente(page, selector) {  
    try { await page.waitForSelector(selector, { timeout: 8000 }); await page.click(selector); } 
    catch (e) { try { await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector); } catch (e) {} }  
    await new Promise(r => setTimeout(r, 1500));  
}
  
// ============================================================================  
// EJECUTOR DE CORRIDAS
// ============================================================================  
async function ejecutarCorrida(modo, receta, keyword, decisiones, profiling) {  
    console.log(`\n🚀 Iniciando corrida en modo [${modo}]...`);  
    global.videoCapturado = null;  
    global.frameOrigenCaptura = null;
    const tracker = new MetricTracker(modo);  
  
    const { browser, page } = await connect({  
        headless: false,  
        args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],  
        turnstile: true,  connectOption: { defaultViewport: null }  
    });  
  
    blindarNavegador(browser, page);  
    await page.setRequestInterception(true);  
    page.on('request', (req) => {  
        const type = req.resourceType(); const url = req.url().toLowerCase();  
        if (modo === 'OPTIMIZADO') {  
            if (url.includes('cloudflare') || url.includes('challenges') || url.includes('captcha') || url.includes('turnstile')) return req.continue();  
            if (['image', 'font', 'media'].includes(type)) { tracker.registrarBloqueo(); return req.abort(); }  
            if (['1xbet', 'popads', 'doubleclick', 'google-analytics', 'googletagmanager'].some(k => url.includes(k))) { tracker.registrarBloqueo(); return req.abort(); }  
        }  
        req.continue();  
    });  
  
    page.on('response', (res) => {  
        const url = res.url().toLowerCase();  
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
            global.videoCapturado = res.url();  
            tracker.videoCapturado = res.url(); 
            tracker.frameOrigen = global.frameOrigenCaptura;
        }
        try { tracker.registrarRespuesta(res.request().resourceType(), parseInt(res.headers()['content-length'] || 0, 10), res.url()); } catch (e) {}  
    });  
  
    try {  
        if (modo === 'OPTIMIZADO') await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' }).catch(() => {});  
        else await page.goto(`https://${receta.dominio}`, { waitUntil: 'networkidle2' });  
        await esperarBypass(page, profiling);  tracker.lap("bypassTime");  
  
        let searchUrl = receta.dominio.includes('jkanime') ? `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}` :  
                        (receta.dominio.includes('cuevana') ? `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}` : null);  
  
        if (searchUrl) await navegarYAbortar(page, searchUrl, 'a', modo, false);  
        else {  
            const sSelector = receta.searchSelector || 'input[name="q"]';  
            await page.waitForSelector(sSelector);  
            await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);  
            await page.keyboard.press('Enter');  
        }  
        await esperarBypass(page, profiling); tracker.lap("searchTime");  
  
        await navegarYAbortar(page, decisiones.showUrl, 'body', modo, true);  
        await esperarBypass(page, profiling); tracker.lap("fichaTime");  
  
        let targetUrl = decisiones.showUrl;  
        if (decisiones.tipo === 's') {  
            targetUrl = receta.episodeUrlPattern ? receta.episodeUrlPattern.replace('{showUrl}', decisiones.showUrl.replace(/\/$/, "")).replace('{number}', decisiones.cap) : `${decisiones.showUrl.replace(/\/$/, "")}/${decisiones.cap}/`;  
        }  
        await navegarYAbortar(page, targetUrl, '.video-play, #play-button, video', modo, true);  
        await esperarBypass(page, profiling); tracker.lap("episodeTime");  
  
        // CLICKS E INYECCIÓN DE REPRODUCTOR (De tu archivo original)
        let rttHost = null;
        if (modo === 'OPTIMIZADO') {
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
                await page.evaluate(() => { document.querySelector('li[role="presentation"], .server-item')?.click(); });
                await new Promise(r => setTimeout(r, 1500)); 
            }
            
            // Heurística de volumen físico (Protocolo Puppeteer - Libre de CORS)
            rttHost = await esperarYMedirCDN(page);
        } else {
            const hasPlay = await page.evaluate(() => document.querySelector('.video-play') !== null);
            if (hasPlay) await clickInteligente(page, '.video-play');
        }

        const exito = await activarVideoSandbox(page, rttHost, profiling);  
        tracker.lap("extractionTime");  tracker.finalizar(exito);  
    } catch (e) {  
        tracker.finalizar(false); console.error(`❌ Error en corrida: ${e.message}`);  
    } finally { await browser.close(); }  
    return tracker;  
}  
  
async function main() {  
    console.log("======================================================");  
    console.log("🧪 BENCHMARK: TEST DE LATENCIA DE CDN DE VIDEO (RTT)");  
    console.log("======================================================");  
  
    const configsDir = path.join(__dirname, 'configs');  
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));  
    archivos.forEach((f, i) => console.log(`${i + 1}. ${f.replace('_receta.json', '')}`));  
      
    const selReceta = parseInt(await pregunta("\n👉 Selecciona receta: ")) - 1;  
    const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[selReceta]), 'utf8'));  
    const keyword = await pregunta(`📺 Keyword para ${receta.dominio}: `);  
  
    const { browser, page } = await connect({ headless: false, args: ["--start-maximized"], turnstile: true });  
    blindarNavegador(browser, page);  
  
    try {  
        const profiling = await ejecutarProfiling(page, receta.dominio);
        console.log(`📊 PROFILING INICIAL: CPU ${profiling.cpuTime}ms | RTT Cuevana ${profiling.rtt}ms`);

        await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });  
        await esperarBypass(page, profiling);  
          
        let searchUrl = receta.dominio.includes('jkanime') ? `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}` :  
                        (receta.dominio.includes('cuevana') ? `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}` : null);  
        if (searchUrl) await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });  
        else {  
            const sSelector = receta.searchSelector || 'input[name="q"]';  
            await page.waitForSelector(sSelector);  
            await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);  
            await page.keyboard.press('Enter');  
        }  
        await esperarBypass(page, profiling);  
  
        console.log("⏳ Esperando resultados...");  
        const maxWaitTime = Math.round(15000 * profiling.cvd.net);
        const enlaces = await page.waitForFunction((kw) => {
            const normalizar = (texto) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const kwNormalizado = normalizar(kw);
            const targets = Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText.trim() })).filter(e => normalizar(e.text).includes(kwNormalizado) && e.href.length > 10);
            return targets.length > 0 ? targets : null;
        }, { timeout: maxWaitTime, polling: 300 }, keyword).then(async (h) => await h.jsonValue()).catch(() => []);  
  
        if (!enlaces || enlaces.length === 0) throw new Error("No se encontraron resultados.");  
  
        console.log("\n======================================================");  
        enlaces.slice(0, 15).forEach((e, i) => console.log(`${i+1}. ${e.text}`));  
        console.log("======================================================");  
          
        const selShow = parseInt(await pregunta("\n👉 Selecciona el show: ")) - 1;  
        const showUrl = enlaces[selShow]?.href || enlaces[0].href;  
        const tipo = await pregunta("❓ ¿Es (S)erie o (P)elícula?: ");  
        let cap = "1"; if (tipo.toLowerCase() === 's') cap = await pregunta("🔢 Cap: ");  
          
        const decisiones = { showUrl, tipo: tipo.toLowerCase(), cap };  
        await browser.close();  
  
        const mVainilla = await ejecutarCorrida('VAINILLA', receta, keyword, decisiones, profiling);  
        const mOptimizado = await ejecutarCorrida('OPTIMIZADO', receta, keyword, decisiones, profiling);  
  
        console.log("\n======================================================");  
        console.log("📊 REPORTE DE TIEMPOS COMPARATIVOS");  
        console.log("======================================================");  
        console.table([  
            { Fase: "Bypass (s)", Vainilla: mVainilla.bypassTime.toFixed(2), Optimizado: mOptimizado.bypassTime.toFixed(2) },  
            { Fase: "Búsqueda (s)", Vainilla: mVainilla.searchTime.toFixed(2), Optimizado: mOptimizado.searchTime.toFixed(2) },  
            { Fase: "Ficha (s)", Vainilla: mVainilla.fichaTime.toFixed(2), Optimizado: mOptimizado.fichaTime.toFixed(2) },  
            { Fase: "Episodio (s)", Vainilla: mVainilla.episodeTime.toFixed(2), Optimizado: mOptimizado.episodeTime.toFixed(2) },  
            { Fase: "Extracción (s)", Vainilla: mVainilla.extractionTime.toFixed(2), Optimizado: mOptimizado.extractionTime.toFixed(2) },  
            { Fase: "TIEMPO TOTAL (s)", Vainilla: mVainilla.totalTime.toFixed(2), Optimizado: mOptimizado.totalTime.toFixed(2) },  
            { Fase: "Éxito", Vainilla: mVainilla.exito ? "SÍ ✅" : "NO ❌", Optimizado: mOptimizado.exito ? "SÍ ✅" : "NO ❌" }  
        ]);  

        // 🔗 SECCIÓN DE AUDITORÍA DE ENLACES CAPTURADOS
        console.log("\n======================================================");  
        console.log("🔗 ENLACES CAPTURADOS EN EL SANDBOX");  
        console.log("======================================================");  
        console.log(`🎥 VAINILLA:\n   URL:   ${mVainilla.videoCapturado || "No capturada ❌"}\n   Frame: ${mVainilla.frameOrigen || "Página Principal"}`);  
        console.log(`🎥 OPTIMIZADO:\n   URL:   ${mOptimizado.videoCapturado || "No capturada ❌"}\n   Frame: ${mOptimizado.frameOrigen || "Página Principal"}`);  
        console.log("======================================================");  

    } catch (error) {  
        console.error(`❌ Fallo en el test: ${error.message}`);  
        await browser.close().catch(() => {});  
    }  
    rl.close();  
}  
  
main();
