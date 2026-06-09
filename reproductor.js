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
// 2. CONFIGURACIÓN GENERAL Y ARGUMENTOS
// ============================================================================
const MODO_INVISIBLE = false; 
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;

// Manejo de argumentos de línea de comandos (CLI)
const args = process.argv.slice(2);
const IS_AUTO = args.includes('--auto');
const TARGET_ID = args.find(arg => arg.startsWith('--id='))?.split('=')[1] || 
                  (args[args.indexOf('--id') + 1] || null);

// ============================================================================
// 3. FUNCIONES DE BYPASS Y AYUDANTES (Sin cambios, se mantienen igual)
// ============================================================================
async function esperarBypass(page, maxIntentos = 30) {
    console.log("🛡️ Verificando estado del bypass...");
    await new Promise(r => setTimeout(r, 4000));
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            let esDesafio = titulo.toLowerCase().includes('just a moment') || 
                            url.includes('challenges.cloudflare.com') || 
                            titulo.toLowerCase().includes('verificando que eres humano');
            if (!esDesafio) {
                const contenido = await page.content();
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) {
                    esDesafio = true;
                }
            }
            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Resolviendo escudo de Cloudflare...`);
                await new Promise(r => setTimeout(r, 4000));
            } else if (url !== 'about:blank' && !url.startsWith('about:') && url.trim().length > 10) {
                console.log("✅ Bypass completado con éxito.");
                await new Promise(r => setTimeout(r, 2000));
                return true;
            }
        } catch (e) { console.log("⚠️ Error bypass:", e); }
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
        try { await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector); } catch (e) {}
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
// 5. LÓGICA DE NAVEGACIÓN (Modularizada para modo Auto)
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

async function buscarShow(page, keyword, dominio) {
    const enlaces = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
            href: a.href,
            text: a.innerText.trim()
        })).filter(a => a.text.length > 2);
    });
    const keywordLimpia = keyword.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); 
    const resultados = enlaces.filter(e => e.text.toLowerCase().includes(keywordLimpia) || e.href.toLowerCase().includes(keywordLimpia));
    
    if (resultados.length === 0) return null;
    if (IS_AUTO) return resultados[0]; // En auto, toma el primer resultado

    console.log(`\n📺 RESULTADOS:`);
    resultados.forEach((r, idx) => console.log(`  ${idx + 1}. ${r.text}`));
    const seleccion = parseInt(await pregunta("\n👉 Selecciona el show: "), 10) - 1;
    return resultados[seleccion] || resultados[0];
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
    console.log(IS_AUTO ? "🤖 MODO AUTOMÁTICO ACTIVO (Refresco de URL)" : "🤖 REPRODUCTOR ADAPTATIVO (Modo Manual)");
    console.log("======================================================");

    let receta, keyword, clasificacionFinal, capituloElegido, targetId = null;

    if (IS_AUTO) {
        if (!TARGET_ID) {
            console.error("❌ Error: El modo --auto requiere un ID (Ejemplo: --id 15)");
            process.exit(1);
        }
        targetId = parseInt(TARGET_ID, 10);
        const data = db.prepare('SELECT * FROM contenidos WHERE id = ?').get(targetId);
        if (!data) {
            console.error(`❌ Error: No se encontró el contenido con ID ${targetId} en la DB.`);
            process.exit(1);
        }
        keyword = data.titulo;
        clasificacionFinal = data.clasificacion;
        capituloElegido = data.episodio;
        receta = cargarRecetaAutomatica();
        console.log(`🔄 Refrescando: ${keyword} | Ep: ${capituloElegido}`);
    } else {
        receta = cargarRecetaAutomatica() || await elegirRecetaInteractiva();
        keyword = (await pregunta(`\n📺 ¿Qué quieres buscar?: `)).trim();
        if (!keyword) return;
    }

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
        const bypassOk = await esperarBypass(page);
        if (!bypassOk) throw new Error("No se pudo resolver el captcha de Cloudflare.");

        const sSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
        await page.waitForSelector(sSelector, { timeout: 15000 });
        
        await page.$eval(sSelector, (el, val) => { 
            el.value = val; 
            el.dispatchEvent(new Event('input', { bubbles: true })); 
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, keyword);

        const subSelector = receta.submitSelector || 'button[type="submit"], input[type="submit"], .search-submit';
        try { await page.click(subSelector); } catch (e) {
            await page.$eval(sSelector, (el) => el.closest('form')?.submit());
        }

        await esperarBypass(page);

        const showSeleccionado = await buscarShow(page, keyword, receta.dominio);
        if (!showSeleccionado) throw new Error("No se encontró el show.");

        if (!IS_AUTO) {
            const defaultClas = receta.metadata?.clasificacion ? receta.metadata.clasificacion[0] : 'P';
            const respuestaClas = (await pregunta(`\n👉 (S)erie o (P)elícula? [Def: ${defaultClas}]: `)).trim().toUpperCase();
            clasificacionFinal = (respuestaClas === 'P') ? 'PELICULA_OVA' : 'SERIE';
        }

        await page.goto(showSeleccionado.href, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        let targetUrl = showSeleccionado.href;
        if (clasificacionFinal === 'SERIE') {
            if (!IS_AUTO) {
                const total = await obtenerTotalCapitulos(page);
                const cap = await pregunta(`👉 Capítulo (1 al ${total}): `);
                capituloElegido = parseInt(cap, 10);
            }
            targetUrl = generarUrlEpisodio(showSeleccionado.href, capituloElegido, receta);
        }

        console.log(`➡️ Navegando al contenido final...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // Auto-curación
        const diagnostico = await page.evaluate(() => {
            return { 
                hasVideoPlay: document.querySelector('.video-play') !== null, 
                servers: Array.from(document.querySelectorAll('li[role="presentation"], .server-item')).map(el => el.innerText.trim()) 
            };
        });

        if (diagnostico.hasVideoPlay) await clickInteligente(page, '.video-play');
        if (diagnostico.servers.length > 0) {
            await page.evaluate(() => {
                document.querySelector('li[role="presentation"], .server-item')?.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        }

        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace: ${global.videoCapturado}`);
            
            if (IS_AUTO && targetId) {
                // 🚀 ACTUALIZACIÓN: En lugar de INSERT, hacemos UPDATE
                const update = db.prepare('UPDATE contenidos SET url_final = ?, fecha_captura = CURRENT_TIMESTAMP WHERE id = ?');
                update.run(global.videoCapturado, targetId);
                console.log(`💾 URL actualizada exitosamente para ID ${targetId}`);
            } else {
                const insert = db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final) VALUES (?, ?, ?, ?)');
                insert.run(showSeleccionado.text, clasificacionFinal, capituloElegido, global.videoCapturado);
                console.log("💾 Nuevo registro guardado en playlist.db");
            }
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