const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;

// ============================================================================
// SELECTORES Y GENERADORES DE URL POR DOMINIO
// ============================================================================
function obtenerSelectorBuscador(dominio) {
    if (dominio.includes('jkanime')) return '#buscanime';
    if (dominio.includes('animeflv')) return 'input[name="q"]';
    if (dominio.includes('cuevana')) return '#keysss';
    return 'input[type="search"], input[name="q"]'; // Fallback universal
}

function generarUrlEpisodio(showUrl, capitulo, dominio) {
    const urlObj = new URL(showUrl);
    const slug = urlObj.pathname.split('/').filter(p => p.length > 0).pop();
    const origin = urlObj.origin;

    if (dominio.includes('animeflv')) {
        // De: animeflv.net/anime/bleach-tv -> ver/bleach-tv-1
        return `${origin}/ver/${slug}-${capitulo}`;
    }
    
    if (dominio.includes('jkanime')) {
        // De: jkanime.net/one-piece/ -> jkanime.net/one-piece/5/
        const base = showUrl.endsWith('/') ? showUrl : showUrl + '/';
        return `${base}${capitulo}/`;
    }

    if (dominio.includes('cuevana')) {
        const base = showUrl.endsWith('/') ? showUrl : showUrl + '/';
        return `${base}${capitulo}/`;
    }

    return showUrl;
}

// ============================================================================
// BUSCADOR DE COINCIDENCIAS EN LOS RESULTADOS DE BÚSQUEDA
// ============================================================================
async function buscarMejorCoincidencia(page, keyword, dominio) {
    console.log(`🔎 Buscando coincidencia para: '${keyword}' en los resultados...`);
    
    const enlaces = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
            href: a.href,
            text: a.innerText.trim()
        }));
    });

    const keywordLimpia = keyword.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); 
    const slugKeyword = keywordLimpia.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    let mejorCoincidencia = null;

    for (const enlace of enlaces) {
        const url = enlace.href.toLowerCase();
        const texto = enlace.text.toLowerCase();

        // Evitamos enlaces irrelevantes
        if (url.includes('/buscar') || url.includes('/explorar') || url.includes('/browse') || url.includes('/genero') || url.includes('/series')) {
            continue;
        }
        if (!url.includes(dominio)) continue;

        const matchSlug = url.includes(slugKeyword);
        const matchTexto = texto.includes(keywordLimpia);

        if (matchSlug || matchTexto) {
            const esPatronAnimeflv = url.includes('/anime/');
            const esPatronCuevana = url.includes('/pelicula/') || url.includes('/serie/');
            const esPatronJkanime = !url.includes('/ver/') && url.split('/').filter(p => p.length > 0).length === 3; // jkanime.net/slug/

            if (esPatronAnimeflv || esPatronCuevana || esPatronJkanime) {
                mejorCoincidencia = enlace.href;
                break; 
            }
            if (!mejorCoincidencia) {
                mejorCoincidencia = enlace.href;
            }
        }
    }
    return mejorCoincidencia;
}

// ============================================================================
// ACTIVACIÓN DEL REPRODUCTOR
// ============================================================================
async function activarVideoSandbox(page) {
    console.log("\n🎬 Buscando reproductor de video en los frames...");
    try {
        const playSelectors = [
            '.vjs-big-play-button', 
            '.play-button', 
            '.btn-play', 
            '[class*="play"]', 
            '#play-button', 
            'video', 
            '.jw-display-icon-container'
        ];
        
        const startTime = Date.now();
        while (Date.now() - startTime < 20000) { 
            if (global.videoCapturado) return true;

            const frames = page.frames();
            for (const frame of frames) {
                try {
                    if (frame.url().includes('about:blank')) continue;

                    for (const selector of playSelectors) {
                        const el = await frame.$(selector);
                        if (el) {
                            await frame.evaluate((sel) => {
                                const btn = document.querySelector(sel);
                                if (btn) btn.click();
                                const vid = document.querySelector('video');
                                if (vid) vid.play().catch(() => {});
                            }, selector);
                            await new Promise(r => setTimeout(r, 2000));
                            if (global.videoCapturado) return true;
                        }
                    }
                } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e) {
        console.error(`❌ Error en player: ${e.message}`);
    }
    return false;
}

async function main() {
    console.log("======================================================");
    console.log("🤖 REPRODUCTOR UNIVERSAL HÍBRIDO v6.0");
    console.log("======================================================");

    const dominio = (await pregunta("🔗 ¿De qué dominio quieres reproducir la receta? (ej: jkanime.net): ")).trim();
    const recetaPath = path.join(__dirname, 'configs', `${dominio}_receta.json`);

    let finalPath = fs.existsSync(recetaPath) ? recetaPath : null;
    let receta = { dominio: dominio, metadata: { clasificacion: "SERIE" } };

    if (finalPath) {
        receta = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
    }

    let clasificacion = receta.metadata?.clasificacion || 'SERIE';
    console.log(`📂 Receta cargada | Dominio: ${receta.dominio} | Clasificación: ${clasificacion}`);

    // --- 1. PEDIR DATOS DE BÚSQUEDA ---
    const keyword = (await pregunta(`📺 ¿Qué quieres buscar?: `)).trim();
    if (!keyword) {
        console.log("❌ Debes ingresar un término de búsqueda.");
        rl.close();
        return;
    }

    let capituloElegido = null;
    if (clasificacion === 'SERIE') {
        const seleccionCap = await pregunta("👉 ¿Qué número de capítulo deseas extraer?: ");
        capituloElegido = parseInt(seleccionCap, 10);
        if (isNaN(capituloElegido) || capituloElegido < 1) {
            console.log("❌ Capítulo inválido.");
            rl.close();
            return;
        }
    }

    // 2. INICIAR NAVEGADOR EN SEGUNDO PLANO
    console.log("\n🚀 Iniciando navegador indetectable en segundo plano...");
    const { browser, page } = await connect({
        headless: "auto", 
        args: ["--start-maximized"],
        turnstile: true, 
        connectOption: { defaultViewport: null }
    });

    await page.evaluateOnNewDocument(() => { window.open = () => null; });

    // POPUP BLOCKER
    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const newPage = await target.page();
            if (newPage && newPage !== page) {
                try {
                    await new Promise(r => setTimeout(r, 500)); 
                    await newPage.close(); 
                } catch (e) {}
            }
        }
    });

    // SNIFFER DE RED PASIVO
    page.on('response', (response) => {
        try {
            const url = response.url().toLowerCase();
            if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('/get_video')) {
                if (!url.includes('1xbet') && !url.includes('doubleclick')) {
                    console.log(`\n🎯 ¡URL DE VIDEO CAPTURADA!: ${response.url()}`);
                    global.videoCapturado = response.url();
                }
            }
        } catch (e) {}
    });

    try {
        const urlInicio = `https://${receta.dominio}`;
        console.log(`\n🚀 Conectando a: ${urlInicio}`);
        await page.goto(urlInicio, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // --- 3. EJECUTAR BÚSQUEDA ---
        const searchSelector = obtenerSelectorBuscador(receta.dominio);
        console.log(`🔍 Escribiendo '${keyword}' en '${searchSelector}'...`);
        
        await page.waitForSelector(searchSelector, { timeout: 10000 });
        await page.$eval(searchSelector, (el, val) => {
            el.value = val;
            const form = el.closest('form');
            if (form) form.submit();
        }, keyword);

        console.log("⏳ Esperando transición a los resultados...");
        await new Promise(r => setTimeout(r, 5000));
        await esperarBypass(page);

        // --- 4. SELECCIONAR LA MEJOR COINCIDENCIA ---
        const showUrl = await buscarMejorCoincidencia(page, keyword, receta.dominio);
        if (!showUrl) {
            throw new Error(`No se encontró ninguna coincidencia para '${keyword}' en los resultados de búsqueda.`);
        }
        console.log(`✅ Coincidencia encontrada: ${showUrl}`);

        // --- 5. IR AL CAPÍTULO DIRECTO ---
        let targetUrl = showUrl;
        if (clasificacion === 'SERIE') {
            targetUrl = generarUrlEpisodio(showUrl, capituloElegido, receta.dominio);
        }
        
        console.log(`➡️ Navegando al contenido final: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // --- 6. DISPARAR EL REPRODUCTOR ---
        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            console.log("\n======================================================");
            console.log("🎉 ¡EXTRACCIÓN EXITOSA!");
            console.log(`🔗 Enlace obtenido: ${global.videoCapturado}`);
            console.log("======================================================");
        } else {
            console.log("\n❌ El proceso terminó sin capturar el stream de video.");
        }

    } catch (e) {
        console.error(`❌ Error general: ${e.message}`);
    } finally {
        await new Promise(r => setTimeout(r, 4000));
        console.log(`🧹 Cerrando procesos...`);
        await browser.close().catch(() => {});
        rl.close();
    }
}

main();