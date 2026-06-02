const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS
// ============================================================================
const db = new Database('playlist.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS contenidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT,
        clasificacion TEXT,
        episodio INTEGER,
        url_final TEXT,
        fecha_captura DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// ============================================================================
// 2. CONFIGURACIÓN GENERAL
// ============================================================================
// CAMBIO CRÍTICO: Forzamos false para evitar detecciones de Cloudflare
const MODO_INVISIBLE = false; 
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;

// ============================================================================
// 3. FUNCIONES DE BYPASS (MÉTODO REFORZADO)
// ============================================================================
async function esperarBypass(page, maxIntentos = 30) {
    console.log("🛡️ Verificando estado del bypass...");
    await new Promise(r => setTimeout(r, 4000));

    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            
            // Detectar si estamos en la página de desafío
            let esDesafio = titulo.toLowerCase().includes('just a moment') || 
                            url.includes('challenges.cloudflare.com') || 
                            titulo.toLowerCase().includes('verificando que eres humano');
            
            if (!esDesafio) {
                // Verificación extra: ¿El HTML contiene rastros de Cloudflare?
                const contenido = await page.content();
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) {
                    esDesafio = true;
                }
            }

            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Resolviendo escudo de Cloudflare...`);
                await new Promise(r => setTimeout(r, 4000));
            } else if (url !== 'about:blank' && !url.startsWith('about:') && url.trim().length > 10) {
                // Solo retornamos true si la página parece haber cargado contenido real
                console.log("✅ Bypass completado con éxito.");
                await new Promise(r => setTimeout(r, 2000));
                return true;
            }
        } catch (e) {
            console.log("⚠️ Error durante la verificación del bypass, reintentando...");
        }
    }
    return false;
}

async function clickInteligente(page, selector) {
    try {
        await page.waitForSelector(selector, { timeout: 8000 });
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
        }, selector);
        await page.click(selector);
    } catch (error) {
        try {
            await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
        } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 1500));
}

// ============================================================================
// 4. GESTIÓN DE RECETAS
// ============================================================================
function cargarRecetaAutomatica() {
    const configsDir = path.join(__dirname, 'configs');
    if (!fs.existsSync(configsDir)) return null;
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    if (archivos.length === 0) return null;
    if (archivos.length === 1) {
        return JSON.parse(fs.readFileSync(path.join(configsDir, archivos[0]), 'utf8'));
    }
    return null;
}

async function elegirRecetaInteractiva() {
    const configsDir = path.join(__dirname, 'configs');
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    console.log(`\n📂 RECETAS DISPONIBLES:`);
    archivos.forEach((file, idx) => console.log(`  ${idx + 1}. ${file}`));
    const seleccion = parseInt(await pregunta("\n👉 Selecciona una receta: "), 10) - 1;
    return JSON.parse(fs.readFileSync(path.join(configsDir, archivos[seleccion] || archivos[0]), 'utf8'));
}

// ============================================================================
// 5. LÓGICA GENÉRICA
// ============================================================================
async function obtenerTotalCapitulos(page) {
    return await page.evaluate(() => {
        const text = document.body.innerText;
        const regexes = [/Episodios:\s*(\d+)/i, /Capítulos:\s*(\d+)/i, /Episodes:\s*(\d+)/i, /(\d+)\s*Episodios/i];
        for (const regex of regexes) {
            const match = text.match(regex);
            if (match && match[1]) return parseInt(match[1], 10);
        }
        return 1;
    });
}

async function elegirCoincidenciaInteractiva(page, keyword, dominio) {
    const enlaces = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
            href: a.href,
            text: a.innerText.trim()
        })).filter(a => a.text.length > 2);
    });
    const keywordLimpia = keyword.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); 
    const resultados = enlaces.filter(e => e.text.toLowerCase().includes(keywordLimpia) || e.href.toLowerCase().includes(keywordLimpia));
    if (resultados.length === 0) return null;
    console.log(`\n📺 RESULTADOS:`);
    resultados.forEach((r, idx) => console.log(`  ${idx + 1}. ${r.text}`));
    const seleccion = parseInt(await pregunta("\n👉 Selecciona el show: "), 10) - 1;
    return resultados[seleccion] || resultados[0];
}

function obtenerSelectorBuscador(receta) {
    return receta.searchSelector || 'input[type="search"], input[name="q"], #search';
}

function obtenerSelectorSubmit(receta) {
    return receta.submitSelector || 'button[type="submit"], input[type="submit"], .search-submit';
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
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video'];
    const startTime = Date.now();
    while (Date.now() - startTime < 30000) { 
        if (global.videoCapturado) return true;
        const frames = page.frames();
        for (const frame of frames) {
            try {
                for (const selector of playSelectors) {
                    const el = await frame.$(selector);
                    if (el) {
                        await frame.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
                        await new Promise(r => setTimeout(r, 2000));
                        if (global.videoCapturado) return true;
                    }
                }
            } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

// ============================================================================
// 6. ORQUESTADOR FINAL
// ============================================================================
async function main() {
    console.log("======================================================");
    console.log("🤖 REPRODUCTOR ADAPTATIVO v7.3 (Bypass Reforzado)");
    console.log("======================================================");

    let receta = cargarRecetaAutomatica() || await elegirRecetaInteractiva();
    const keyword = (await pregunta(`\n📺 ¿Qué quieres buscar?: `)).trim();
    if (!keyword) return;

    // CONEXIÓN EXACTA AL MÉTODO ORIGINAL
    const { browser, page } = await connect({
        headless: MODO_INVISIBLE, 
        args: ["--start-maximized"],
        turnstile: true, 
        connectOption: { defaultViewport: null }
    });

    await page.evaluateOnNewDocument(() => { window.open = () => null; });

    page.on('response', (response) => {
        try {
            const url = response.url().toLowerCase();
            if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
                global.videoCapturado = response.url();
            }
        } catch (e) {}
    });

    try {
        await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });
        
        // ESPERA EL BYPASS
        const bypassOk = await esperarBypass(page);
        if (!bypassOk) throw new Error("No se pudo resolver el captcha de Cloudflare.");

        const sSelector = obtenerSelectorBuscador(receta);
        
        // VERIFICACIÓN DE CARGA: Esperamos a que el buscador sea visible antes de escribir
        console.log(`🔍 Esperando buscador ${sSelector}...`);
        await page.waitForSelector(sSelector, { timeout: 15000 });
        
        await page.$eval(sSelector, (el, val) => { 
            el.value = val; 
            el.dispatchEvent(new Event('input', { bubbles: true })); 
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, keyword);

        const subSelector = obtenerSelectorSubmit(receta);
        try { await page.click(subSelector); } catch (e) {
            await page.$eval(sSelector, (el) => el.closest('form')?.submit());
        }

        await esperarBypass(page);

        const showSeleccionado = await elegirCoincidenciaInteractiva(page, keyword, receta.dominio);
        if (!showSeleccionado) throw new Error("No se encontró el show. Es posible que el bypass fallara.");

        const defaultClas = receta.metadata?.clasificacion ? receta.metadata.clasificacion[0] : 'P';
        const respuestaClas = (await pregunta(`\n👉 (S)erie o (P)elícula? [Def: ${defaultClas}]: `)).trim().toUpperCase();
        let clasificacionFinal = (respuestaClas === 'P') ? 'PELICULA_OVA' : 'SERIE';

        await page.goto(showSeleccionado.href, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        let targetUrl = showSeleccionado.href;
        let capituloElegido = null;

        if (clasificacionFinal === 'SERIE') {
            const total = await obtenerTotalCapitulos(page);
            const cap = await pregunta(`👉 Capítulo (1 al ${total}): `);
            capituloElegido = parseInt(cap, 10);
            targetUrl = generarUrlEpisodio(showSeleccionado.href, capituloElegido, receta);
        }

        console.log(`➡️ Navegando al contenido final...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // AUTO-CURACIÓN
        console.log("\n🧪 Ejecutando auto-curación de reproductor...");
        const diagnostico = await page.evaluate(() => {
            return { 
                hasVideoPlay: document.querySelector('.video-play') !== null, 
                servers: Array.from(document.querySelectorAll('li[role="presentation"], .server-item')).map(el => el.innerText.trim()) 
            };
        });

        if (diagnostico.hasVideoPlay) {
            console.log("⚡ Forzando clic en botón de reproducción...");
            await clickInteligente(page, '.video-play');
        }

        if (diagnostico.servers.length > 0) {
            console.log("⚡ Forzando selección de primer servidor...");
            await page.evaluate(() => {
                const primerSrv = document.querySelector('li[role="presentation"], .server-item');
                if (primerSrv) primerSrv.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        }

        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace: ${global.videoCapturado}`);
            const insert = db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final) VALUES (?, ?, ?, ?)');
            insert.run(showSeleccionado.text, clasificacionFinal, capituloElegido, global.videoCapturado);
            console.log("💾 Datos guardados en playlist.db");
        } else {
            console.log("\n❌ No se capturó el stream.");
        }

    } catch (e) { 
        console.error(`❌ Error general: ${e.message}`); 
    } finally {
        await browser.close();
        rl.close();
    }
}

main();