const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS
// ============================================================================
const db = new Database('playlist.db');
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS contenidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT,
        clasificacion TEXT,
        episodio INTEGER,
        url_final TEXT,
        url_base TEXT,
        dominio TEXT,
        hora_programada TEXT,
        reproducido INTEGER DEFAULT 0,
        fecha_captura DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Migraciones
const columns = db.prepare("PRAGMA table_info(contenidos)").all();
const colNames = columns.map(c => c.name);
if (!colNames.includes('url_base')) db.exec("ALTER TABLE contenidos ADD COLUMN url_base TEXT");
if (!colNames.includes('dominio')) db.exec("ALTER TABLE contenidos ADD COLUMN dominio TEXT");
if (!colNames.includes('hora_programada')) db.exec("ALTER TABLE contenidos ADD COLUMN hora_programada TEXT");
if (!colNames.includes('reproducido')) db.exec("ALTER TABLE contenidos ADD COLUMN reproducido INTEGER DEFAULT 0");
if (!colNames.includes('duracion')) db.exec("ALTER TABLE contenidos ADD COLUMN duracion INTEGER DEFAULT 0");

// ============================================================================
// 2. CONFIGURACIÓN GENERAL Y ARGUMENTOS
// ============================================================================
const MODO_INVISIBLE = true; 
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;

const args = process.argv.slice(2);
const IS_AUTO = args.includes('--auto');
const TARGET_ID = args.find(arg => arg.startsWith('--id='))?.split('=')[1] || null;
const ARG_HORA = args.find(arg => arg.startsWith('--hora='))?.split('=')[1] || null;

// Argumentos para el Panel Web
const ARG_DOMINIO = args.find(arg => arg.startsWith('--dominio='))?.split('=')[1] || null;
const ARG_KEYWORD = args.find(arg => arg.startsWith('--keyword='))?.split('=')[1] || null;
const ARG_CLAS = args.find(arg => arg.startsWith('--clas='))?.split('=')[1] || null;
const ARG_EP = args.find(arg => arg.startsWith('--ep='))?.split('=')[1] || null;

// ============================================================================
// 3. FUNCIONES de SOPORTE
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

async function esperarBypass(page, maxIntentos = 30) {
    console.log("🛡️ Verificando escudos (Cloudflare/Turnstile)...");
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            let esDesafio = titulo.toLowerCase().includes('just a moment') ||
                            url.includes('challenges.cloudflare.com') ||
                            titulo.toLowerCase().includes('verificando');
            if (!esDesafio && url !== 'about:blank' && url.trim().length > 10) {
                console.log("✅ Bypass completado.");
                return true;
            }
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {}
    }
    return false;
}

function generarUrlEpisodio(showUrl, capitulo, receta) {
    const urlLimpia = showUrl.replace(/\/$/, "");
    if (receta.episodeUrlPattern) {
        return receta.episodeUrlPattern.replace('{showUrl}', urlLimpia).replace('{number}', capitulo);
    }
    return `${urlLimpia}/${capitulo}/`;
}

// ============================================================================
// 4. EL NÚCLEO: ACTIVACIÓN AGRESIVA DEL VIDEO
// ============================================================================
async function activarVideoSandbox(page) {
    console.log("\n🎬 Iniciando secuencia de activación de reproductor...");
    
    const playSelectors = [
        '.vjs-big-play-button', '.play-button', '.btn-play', 
        '[class*="play"]', '[id*="play"]', 'video', 
        '.vjs-play-control', '.play-overlay', '.video-play'
    ];

    const startTime = Date.now();
    while (Date.now() - startTime < 30000) { 
        if (global.videoCapturado) return true;

        const frames = page.frames();
        for (const frame of frames) {
            try {
                // A. Intento por selectores conocidos en cada frame
                for (const selector of playSelectors) {
                    const el = await frame.$(selector);
                    if (el) {
                        console.log(`🎯 Botón detectado: ${selector} en frame ${frame.url().substring(0,30)}...`);
                        await frame.evaluate((sel) => { 
                            const btn = document.querySelector(sel);
                            if(btn) btn.click(); 
                        }, selector);
                        await new Promise(r => setTimeout(r, 3000));
                        if (global.videoCapturado) return true;
                    }
                }

                // B. Click Central si es el frame del reproductor
                if (frame.url().includes('player') || frame.url().includes('mudos')) {
                    await frame.evaluate(() => {
                        const x = window.innerWidth / 2;
                        const y = window.innerHeight / 2;
                        const elem = document.elementFromPoint(x, y);
                        if (elem) elem.click();
                    });
                    await new Promise(r => setTimeout(r, 3000));
                    if (global.videoCapturado) return true;
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
    console.log(IS_AUTO ? "🤖 MODO AUTOMÁTICO" : "🤖 REPRODUCTOR ADAPTATIVO");
    console.log("======================================================");

    let receta, keyword, clasificacionFinal, capituloElegido, targetId = null, urlBaseFinal = null, horaFinal = ARG_HORA;

    // Lógica de selección de datos (Panel Web vs Terminal vs Auto)
    if (IS_AUTO) {
        if (!TARGET_ID) { console.error("❌ --auto requiere --id=X"); process.exit(1); }
        targetId = parseInt(TARGET_ID, 10);
        const data = db.prepare('SELECT * FROM contenidos WHERE id = ?').get(targetId);
        if (!data) { console.error(`❌ ID ${targetId} no encontrado.`); process.exit(1); }
        keyword = data.titulo;
        clasificacionFinal = data.clasificacion;
        capituloElegido = data.episodio;
        urlBaseFinal = data.url_base;
        receta = cargarRecetaPorDominio(data.dominio);
    } else if (ARG_DOMINIO && ARG_KEYWORD) {
        console.log(`🌐 Modo Panel Web: ${ARG_KEYWORD} en ${ARG_DOMINIO}`);
        receta = cargarRecetaPorDominio(ARG_DOMINIO);
        keyword = ARG_KEYWORD;
        clasificacionFinal = ARG_CLAS || "SERIE";
        capituloElegido = parseInt(ARG_EP, 10) || 1;
    } else {
        // Modo Manual Terminal
        const configsDir = path.join(__dirname, 'configs');
        const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
        archivos.forEach((f, i) => console.log(`  ${i+1}. ${f}`));
        const sel = parseInt(await pregunta("\n👉 Selecciona receta: "), 10) - 1;
        receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[sel] || archivos[0]), 'utf8'));
        keyword = (await pregunta(`\n📺 ¿Qué quieres buscar?: `)).trim();
        if (!keyword) return;
    }

    if (!receta) { console.error("❌ No se encontró receta válida."); process.exit(1); }

    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
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
            targetUrl = generarUrlEpisodio(urlBaseFinal, capituloElegido, receta);
        } else {
            // Navegación y Búsqueda
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

            const enlaces = await page.evaluate((kw) => {
                return Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText.trim() }))
                    .filter(e => e.text.toLowerCase().includes(kw.toLowerCase()));
            }, keyword);
            
            if (enlaces.length === 0) throw new Error("No se encontró el contenido.");

            let show = enlaces[0];
            if (!IS_AUTO && !ARG_DOMINIO) {
                console.log(`\n📺 RESULTADOS:`);
                enlaces.forEach((r, idx) => console.log(`  ${idx + 1}. ${r.text}`));
                const seleccion = parseInt(await pregunta(`\n👉 Selecciona el show (1-${enlaces.length}): `), 10) - 1;
                show = enlaces[seleccion] || enlaces[0];
            }
            urlBaseFinal = show.href;

            if (!IS_AUTO && !ARG_DOMINIO) {
                const resClas = (await pregunta(`\n👉 (S)erie o (P)elícula? [Def: S]: `)).trim().toUpperCase();
                clasificacionFinal = (resClas === 'P') ? 'PELICULA_OVA' : 'SERIE';
                const resHora = await pregunta(`\n👉 Hora programada (HH:MM) o vacío: `);
                horaFinal = resHora.trim() || null;
            } else if (ARG_DOMINIO) {
                // Si viene del panel, ya tenemos clasificacionFinal y capituloElegido
            } else {
                clasificacionFinal = "SERIE";
            }

            await page.goto(urlBaseFinal, { waitUntil: 'domcontentloaded' });
            await esperarBypass(page);

            if (clasificacionFinal === 'SERIE') {
                if (!IS_AUTO && !ARG_DOMINIO) {
                    capituloElegido = parseInt(await pregunta(`👉 Capítulo: `), 10) || 1;
                } else if (ARG_DOMINIO) {
                    capituloElegido = parseInt(ARG_EP, 10) || 1;
                } else {
                    capituloElegido = 1;
                }
                targetUrl = generarUrlEpisodio(urlBaseFinal, capituloElegido, receta);
            } else {
                targetUrl = urlBaseFinal;
            }
        }

        console.log(`➡️ Navegando al destino: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // --- ACTIVACIÓN FINAL ---
        console.log("🖱️ Despertando el reproductor...");
        await page.click('body').catch(() => {}); 
        await new Promise(r => setTimeout(r, 2000));
        
        await activarVideoSandbox(page);

        if (global.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace capturado: ${global.videoCapturado}`);
            if (IS_AUTO && targetId) {
                db.prepare('UPDATE contenidos SET url_final = ?, fecha_captura = CURRENT_TIMESTAMP WHERE id = ?')
                  .run(global.videoCapturado, targetId);
            } else {
                db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio, hora_programada, reproducido) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
                  .run(keyword, clasificacionFinal, capituloElegido, global.videoCapturado, urlBaseFinal, receta.dominio, horaFinal);
                console.log(`💾 Guardado en DB.`);
            }
        } else {
            console.log("\n❌ No se pudo capturar el stream.");
        }

    } catch (e) {
        console.error(`❌ Error general: ${e.message}`);
    } finally {
        await browser.close();
        if (rl) rl.close();
    }
}

main();