const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;
global.frameOrigenCaptura = null; 
global.currentMainPage = null;

// ============================================================================
// PROFILER Y RED (Mantenido)
// ============================================================================
async function ejecutarProfiling(page, dominio) {
    console.log("⏱  Iniciando Profiling...");
    const startCPU = Date.now();
    for (let i = 0; i < 5000000; i++) { Math.sqrt(i); }
    const cpuTime = Date.now() - startCPU; 
    return { cpuTime, cpuScore: Math.max(1.0, cpuTime / 15), cvd: { cpu: Math.max(1.0, cpuTime / 15), net: 1.0 } };
}

async function obtenerIframeVideoRealPuppeteer(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const urlStr = frame.url();
            if (!urlStr || urlStr.includes('about:blank') || urlStr.includes('cuevana') || urlStr.includes('jkanime')) continue;
            const frameElement = await frame.frameElement();
            if (frameElement) {
                const rect = await frameElement.boundingBox();
                if (rect && rect.width > 250 && rect.height > 120) return urlStr;
            }
        } catch (e) {}
    }
    return null;
}

async function esperarYMedirCDN(page) {
    console.log("⏳ Esperando inyección del reproductor real...");
    const start = Date.now();
    while (Date.now() - start < 10000) {
        const videoSrc = await obtenerIframeVideoRealPuppeteer(page);
        if (videoSrc) {
            console.log(`🎯 Reproductor detectado: ${videoSrc}`);
            break;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return 800; 
}

// ============================================================================
// EXTRACCIÓN SANDBOX: MODO INYECCIÓN PROFUNDA
// ============================================================================
async function activarVideoSandbox(page, rttHost = null, profiling = null) {
    console.log(`\n🎬 Iniciando Extracción Profunda...`);
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video', '.jw-icon-display'];
    const startTime = Date.now();
    const cpuScore = profiling ? profiling.cvd.cpu : 1.0;
    let baseWait = rttHost ? Math.max(500, rttHost) : 2000;
    let k = 0; 
    
    while (Date.now() - startTime < 60000) { 
        if (global.videoCapturado) return true;
        try {
            const frames = page.frames();
            
            for (const frame of frames) {
                try {
                    // 1. Ignorar frames vacíos
                    if (frame.url().includes('about:blank')) continue;

                    // 2. INTENTO A: Robar src directo del elemento <video>
                    const src = await frame.evaluate(() => {
                        const v = document.querySelector('video');
                        return v ? v.src : null;
                    });
                    if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !src.startsWith('blob:')) {
                        global.videoCapturado = src;
                        global.frameOrigenCaptura = frame.url();
                        return true;
                    }

                    // 3. INTENTO B: Inyección de JS para forzar el Play desde ADENTRO del frame
                    await frame.evaluate(() => {
                        // Forzar mute y play en todos los videos del frame
                        document.querySelectorAll('video').forEach(v => {
                            v.muted = true;
                            v.play().catch(() => {});
                        });
                        // Simular click en el centro del BODY del frame para romper overlays
                        const body = document.body;
                        if (body) {
                            const event = new MouseEvent('click', {
                                view: window, bubbles: true, cancelable: true,
                                clientX: window.innerWidth / 2, clientY: window.innerHeight / 2
                            });
                            body.dispatchEvent(event);
                        }
                    });

                    // 4. INTENTO C: Clics en selectores de Play específicos dentro del frame
                    for (const selector of playSelectors) {
                        try {
                            const el = await frame.$(selector);
                            if (el) {
                                await el.click();
                                // Esperamos un poco después de cada click para ver si el stream se dispara
                                await new Promise(r => setTimeout(r, 500));
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            }

            if (global.videoCapturado) break;
            
            let waitTime = k < 3 ? baseWait : Math.min(8000, Math.round(baseWait * Math.pow(1.2 + (cpuScore * 0.05), k - 2)));
            console.log(`⏳ Toque #${k} - Espera: ${waitTime}ms...`);
            await new Promise(r => setTimeout(r, waitTime));
            k++;
        } catch (e) {
            console.error(`Error en ciclo de extracción: ${e.message}`);
        }
    }
    return !!global.videoCapturado;
}

// ============================================================================
// METRICS TRACKER (Mantenido)
// ============================================================================
class MetricTracker {
    constructor(modo) {
        this.modo = modo; this.videoCapturado = null; this.exito = false;
        this.startTime = Date.now(); this.lapTime = Date.now();
        this.fases = {};
    }
    lap(fase) {
        const now = Date.now();
        this.fases[fase] = (now - this.lapTime) / 1000;
        this.lapTime = now;
        console.log(`⏱️  [${this.modo}] ${fase}: ${this.fases[fase].toFixed(2)}s`);
    }
    finalizar(exito) {
        this.exito = exito;
        this.totalTime = (Date.now() - this.startTime) / 1000;
    }
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

async function esperarBypass(page, profiling) {
    for (let i = 1; i <= 30; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            if (!titulo.toLowerCase().includes('just a moment') && !page.url().includes('challenges.cloudflare.com')) return true;
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {}
    }
    return false;
}

async function navegarYAbortar(page, url, selector, modo, esPaginaCritica = false) {
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        if (esPaginaCritica) { await page.waitForSelector(selector, { timeout: 15000 }); return; }
        await page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});
        await page.evaluate(() => window.stop()).catch(() => {});
    } catch (e) {}
}

// ============================================================================
// EJECUTOR DE CORRIDAS
// ============================================================================
async function ejecutarCorrida(modo, receta, keyword, decisiones, profiling) {
    console.log(`\n🚀 Modo [${modo}]...`);
    global.videoCapturado = null;
    const tracker = new MetricTracker(modo);

    const { browser, page } = await connect({
        headless: false,
        args: ["--start-maximized", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        turnstile: true, connectOption: { defaultViewport: null }
    });

    blindarNavegador(browser, page);
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const url = req.url().toLowerCase();
        const type = req.resourceType();
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.ts') || url.includes('manifest')) return req.continue();
        if (modo === 'OPTIMIZADO') {
            if (url.includes('cloudflare') || url.includes('challenges')) return req.continue();
            if (['image', 'font'].includes(type)) return req.abort();
            if (['1xbet', 'popads', 'doubleclick', 'google-analytics'].some(k => url.includes(k))) return req.abort();
        }
        req.continue();
    });

    page.on('response', (res) => {
        const url = res.url().toLowerCase();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
            global.videoCapturado = res.url();
        }
    });

    try {
        await page.goto(`https://${receta.dominio}`, { waitUntil: 'networkidle2' }).catch(() => {});
        await esperarBypass(page, profiling); tracker.lap("bypass");

        let searchUrl = receta.dominio.includes('jkanime') ? `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}` :
                        (receta.dominio.includes('cuevana') ? `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}` : null);

        if (searchUrl) await navegarYAbortar(page, searchUrl, 'a', modo, false);
        else {
            const sSelector = receta.searchSelector || 'input[name="q"]';
            await page.waitForSelector(sSelector);
            await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);
            await page.keyboard.press('Enter');
        }
        await esperarBypass(page, profiling); tracker.lap("search");

        await navegarYAbortar(page, decisiones.showUrl, 'body', modo, true);
        await esperarBypass(page, profiling); tracker.lap("ficha");

        let targetUrl = decisiones.showUrl;
        if (decisiones.tipo === 's') {
            targetUrl = receta.episodeUrlPattern ? receta.episodeUrlPattern.replace('{showUrl}', decisiones.showUrl.replace(/\/$/, "")).replace('{number}', decisiones.cap) : `${decisiones.showUrl.replace(/\/$/, "")}/${decisiones.cap}/`;
        }
        await navegarYAbortar(page, targetUrl, '.video-play, #play-button, video', modo, true);
        await esperarBypass(page, profiling); tracker.lap("episode");

        let rttHost = null;
        if (modo === 'OPTIMIZADO') {
            rttHost = await esperarYMedirCDN(page);
        }

        const exito = await activarVideoSandbox(page, rttHost, profiling);
        tracker.lap("extraction"); tracker.finalizar(exito);
    } catch (e) {
        tracker.finalizar(false); console.error(`❌ Error: ${e.message}`);
    } finally { await browser.close(); }
    return tracker;
}

async function main() {
    console.log("======================================================");
    console.log("🧪 BENCHMARK: TEST DE LATENCIA Y CAPTURA");
    console.log("======================================================");

    const configsDir = path.join(__dirname, '..', 'configs');
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    archivos.forEach((f, i) => console.log(`${i + 1}. ${f.replace('_receta.json', '')}`));
    
    const selReceta = parseInt(await pregunta("\n👉 Selecciona receta: ")) - 1;
    const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[selReceta]), 'utf8'));
    const keyword = await pregunta(`📺 Keyword: `);

    const { browser, page } = await connect({ headless: false, args: ["--start-maximized"], turnstile: true });
    const profiling = await ejecutarProfiling(page, receta.dominio);
    
    await page.goto(`https://${receta.dominio}`, { waitUntil: 'networkidle2' }).catch(() => {});
    await esperarBypass(page, profiling);

    let searchUrl = receta.dominio.includes('jkanime') ? `https://${receta.dominio}/buscar/${encodeURIComponent(keyword)}` :
                    (receta.dominio.includes('cuevana') ? `https://${receta.dominio}/explorar?s=${encodeURIComponent(keyword)}` : null);
    if (searchUrl) {
        await page.goto(searchUrl, { waitUntil: 'networkidle2' }).catch(() => {});
    } else {
        const sSelector = receta.searchSelector || 'input[name="q"]';
        await page.waitForSelector(sSelector);
        await page.$eval(sSelector, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); }, keyword);
        await page.keyboard.press('Enter');
    }
    await esperarBypass(page, profiling);

    console.log("⏳ Esperando resultados con Bucle de Reintentos...");
    let enlaces = [];
    for (let i = 0; i < 5; i++) {
        enlaces = await page.evaluate((kw) => {
            const normalizar = (texto) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const kwNormalizado = normalizar(kw);
            return Array.from(document.querySelectorAll('a'))
                .map(a => ({ href: a.href, text: a.innerText.trim() }))
                .filter(e => normalizar(e.text).includes(kwNormalizado) && e.href.length > 10);
        }, keyword);
        if (enlaces.length > 0) break;
        await new Promise(r => setTimeout(r, 2000));
    }

    if (!enlaces || enlaces.length === 0) {
        console.log("❌ No se encontraron resultados.");
        await browser.close();
        process.exit();
    }

    console.log("\n======================================================");
    enlaces.slice(0, 15).forEach((e, i) => console.log(`${i+1}. ${e.text}`));
    console.log("======================================================");

    const selShow = parseInt(await pregunta("\n👉 Selecciona el show: ")) - 1;
    const showUrl = enlaces[selShow]?.href || enlaces[0].href;
    const tipo = await pregunta("❓ (S)erie o (P)elícula?: ");
    let cap = "1"; if (tipo.toLowerCase() === 's') cap = await pregunta("🔢 Cap: ");

    const decisiones = { showUrl, tipo: tipo.toLowerCase(), cap };
    await browser.close();

    const mOptimizado = await ejecutarCorrida('OPTIMIZADO', receta, keyword, decisiones, profiling);
    console.log(`\n🏁 RESULTADO FINAL: ${mOptimizado.exito ? "SÍ ✅" : "NO ❌"}`);
    if (global.videoCapturado) console.log(`🔗 URL CAPTURADA: ${global.videoCapturado}`);
}

main();