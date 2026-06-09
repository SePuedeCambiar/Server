const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS Y MIGRACIÓN
// ============================================================================
const db = new Database('playlist.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS contenidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT,
        clasificacion TEXT,
        episodio INTEGER,
        url_final TEXT,
        url_base TEXT,
        dominio TEXT,
        fecha_captura DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

const columns = db.prepare("PRAGMA table_info(contenidos)").all();
const colNames = columns.map(c => c.name);
if (!colNames.includes('url_base')) db.exec("ALTER TABLE contenidos ADD COLUMN url_base TEXT");
if (!colNames.includes('dominio')) db.exec("ALTER TABLE contenidos ADD COLUMN dominio TEXT");

// ============================================================================
// 2. CONFIGURACIÓN GENERAL Y ARGUMENTOS
// ============================================================================
const MODO_INVISIBLE = false; 
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;

const args = process.argv.slice(2);
const IS_AUTO = args.includes('--auto');
const TARGET_ID = args.find(arg => arg.startsWith('--id='))?.split('=')[1] || 
                  (args[args.indexOf('--id') + 1] || null);

// ============================================================================
// 3. GESTIÓN DE RECETAS DINÁMICA
// ============================================================================
function cargarRecetaPorDominio(dominioBuscado) {
    const configsDir = path.join(__dirname, 'configs');
    if (!fs.existsSync(configsDir)) return null;

    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    
    for (const archivo of archivos) {
        const ruta = path.join(configsDir, archivo);
        const receta = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        if (receta.dominio === dominioBuscado) {
            return receta;
        }
    }
    return null;
}

async function elegirRecetaInteractiva() {
    const configsDir = path.join(__dirname, 'configs');
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    console.log(`\n📂 RECETAS DISPONIBLES:`);
    archivos.forEach((file, idx) => console.log(`  ${idx + 1}. ${file}`));
    const seleccion = parseInt(await pregunta("\n👉 Selecciona una receta: "), 10) - 1;
    const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[seleccion] || archivos[0]), 'utf8'));
    return receta;
}

// ============================================================================
// 4. FUNCIONES DE SOPORTE (BYPASS Y NAVEGACIÓN)
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
                if (contenido.includes('cf-challenge') || contenido.includes('turnstile')) esDesafio = true;
            }
            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Resolviendo escudo...`);
                await new Promise(r => setTimeout(r, 4000));
            } else if (url !== 'about:blank' && !url.startsWith('about:') && url.trim().length > 10) {
                console.log("✅ Bypass completado.");
                return true;
            }
        } catch (e) {}
    }
    return false;
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

async function activarVideoSandbox(page) {
    console.log("\n🎬 Buscando reproductor...");
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
// 5. ORQUESTADOR FINAL
// ============================================================================
async function main() {
    console.log("======================================================");
    console.log(IS_AUTO ? "🤖 MODO AUTOMÁTICO (Carga Directa)" : "🤖 REPRODUCTOR ADAPTATIVO (Modo Manual)");
    console.log("======================================================");

    let receta, keyword, clasificacionFinal, capituloElegido, targetId = null, urlBaseFinal = null;

    if (IS_AUTO) {
        if (!TARGET_ID) {
            console.error("❌ Error: --auto requiere --id=X");
            process.exit(1);
        }
        targetId = parseInt(TARGET_ID, 10);
        const data = db.prepare('SELECT * FROM contenidos WHERE id = ?').get(targetId);
        if (!data) {
            console.error(`❌ Error: ID ${targetId} no encontrado.`);
            process.exit(1);
        }
        
        keyword = data.titulo;
        clasificacionFinal = data.clasificacion;
        capituloElegido = data.episodio;
        urlBaseFinal = data.url_base;
        
        receta = cargarRecetaPorDominio(data.dominio);
        if (!receta) {
            console.error(`❌ Error: No se encontró receta para el dominio ${data.dominio}`);
            process.exit(1);
        }
        console.log(`🔄 Refrescando: ${keyword} | Ep: ${capituloElegido} | Dom: ${receta.dominio}`);
    } else {
        receta = await elegirRecetaInteractiva();
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
        let targetUrl = "";

        if (IS_AUTO && urlBaseFinal) {
            console.log(`⚡ Usando URL Base guardada: ${urlBaseFinal}`);
            targetUrl = generarUrlEpisodio(urlBaseFinal, capituloElegido, receta);
        } else {
            await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });
            await esperarBypass(page);

            const sSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
            await page.waitForSelector(sSelector, { timeout: 15000 });
            await page.$eval(sSelector, (el, val) => { 
                el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); 
            }, keyword);

            const subSelector = receta.submitSelector || 'button[type="submit"], input[type="submit"], .search-submit';
            try { await page.click(subSelector); } catch (e) { await page.$eval(sSelector, (el) => el.closest('form')?.submit()); }
            await esperarBypass(page);

            const enlaces = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText.trim() }))
                    .filter(a => a.text.length > 2);
            });
            const resultados = enlaces.filter(e => e.text.toLowerCase().includes(keyword.toLowerCase()));
            if (resultados.length === 0) throw new Error("No se encontró el show.");
            
            if (IS_AUTO) {
                const show = resultados[0];
                urlBaseFinal = show.href;
            } else {
                // 🚀 RESTAURADO: Listado visual de resultados
                console.log(`\n📺 RESULTADOS ENCONTRADOS:`);
                resultados.forEach((r, idx) => {
                    console.log(`  ${idx + 1}. ${r.text}`);
                });
                const seleccion = parseInt(await pregunta(`\n👉 Selecciona el show (1-${resultados.length}): `)) - 1;
                const show = resultados[seleccion] || resultados[0];
                urlBaseFinal = show.href;
            }

            if (!IS_AUTO) {
                const defaultClas = receta.metadata?.clasificacion ? receta.metadata.clasificacion[0] : 'P';
                const resClas = (await pregunta(`\n👉 (S)erie o (P)elícula? [Def: ${defaultClas}]: `)).trim().toUpperCase();
                clasificacionFinal = (resClas === 'P') ? 'PELICULA_OVA' : 'SERIE';
            }

            await page.goto(urlBaseFinal, { waitUntil: 'domcontentloaded' });
            await esperarBypass(page);

            if (clasificacionFinal === 'SERIE') {
                if (!IS_AUTO) {
                    const total = await page.evaluate(() => {
                        const text = document.body.innerText;
                        const m = text.match(/Episodios:\s*(\d+)/i); return m ? parseInt(m[1], 10) : 1;
                    });
                    capituloElegido = parseInt(await pregunta(`👉 Capítulo (1 al ${total}): `), 10);
                }
                targetUrl = generarUrlEpisodio(urlBaseFinal, capituloElegido, receta);
            } else {
                targetUrl = urlBaseFinal;
            }
        }

        console.log(`➡️ Navegando al contenido final...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

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

        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace: ${global.videoCapturado}`);
            if (IS_AUTO && targetId) {
                const update = db.prepare('UPDATE contenidos SET url_final = ?, fecha_captura = CURRENT_TIMESTAMP WHERE id = ?');
                update.run(global.videoCapturado, targetId);
                console.log(`💾 URL actualizada para ID ${targetId}`);
            } else {
                const insert = db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio) VALUES (?, ?, ?, ?, ?, ?)');
                insert.run(keyword, clasificacionFinal, capituloElegido, global.videoCapturado, urlBaseFinal, receta.dominio);
                console.log("💾 Registro guardado en playlist.db");
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