const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

// ============================================================================
// 1. CONFIGURACIÓN DE BASE DE DATOS (MIGRACIONES DINÁMICAS)
// ============================================================================
const db = new Database('playlist.db');
db.pragma('journal_mode = WAL');

function initDatabase() {
    // Tabla base
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

    // Migraciones automáticas para evitar errores de "columna no encontrada"
    const columnasNecesarias = [
        { nombre: 'url_base', tipo: 'TEXT' },
        { nombre: 'dominio', tipo: 'TEXT' },
        { nombre: 'hora_programada', tipo: 'TEXT' },
        { nombre: 'reproducido', tipo: 'INTEGER DEFAULT 0' },
        { nombre: 'duracion', tipo: 'INTEGER DEFAULT 0' },
        { nombre: 'fecha_captura', tipo: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ];

    const columnasExistentes = db.prepare("PRAGMA table_info(contenidos)").all().map(c => c.name);
    columnasNecesarias.forEach(col => {
        if (!columnasExistentes.includes(col.nombre)) {
            db.exec(`ALTER TABLE contenidos ADD COLUMN ${col.nombre} ${col.tipo}`);
            console.log(`🔧 Migración: Columna '${col.nombre}' añadida.`);
        }
    });
}

// ============================================================================
// 2. UTILIDADES Y CONFIGURACIÓN GENERAL
// ============================================================================
const MODO_INVISIBLE = false; // Cambiar a true para modo headless total
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

// Estado global para capturar la URL del stream
let state = {
    videoCapturado: null,
    isAuto: false,
    targetId: null
};

const args = process.argv.slice(2);
const ARG_AUTO = args.includes('--auto');
const ARG_ID = args.find(arg => arg.startsWith('--id='))?.split('=')[1] || null;
const ARG_HORA = args.find(arg => arg.startsWith('--hora='))?.split('=')[1] || null;

// ============================================================================
// 3. LÓGICA DE NAVEGACIÓN Y BYPASS
// ============================================================================

function cargarRecetaPorDominio(dominio) {
    const configsDir = path.join(__dirname, 'configs');
    if (!fs.existsSync(configsDir)) return null;
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
    for (const archivo of archivos) {
        const receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivo), 'utf8'));
        if (receta.dominio === dominio) return receta;
    }
    return null;
}

async function esperarBypass(page, maxIntentos = 20) {
    console.log("🛡️ Verificando escudos (Cloudflare/Turnstile)...");
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            const esDesafio = titulo.toLowerCase().includes('just a moment') || 
                              url.includes('challenges.cloudflare.com') || 
                              titulo.toLowerCase().includes('verificando');
            
            if (!esDesafio && url !== 'about:blank' && url.length > 10) {
                console.log("✅ Bypass completado.");
                return true;
            }
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {}
    }
    return false;
}

async function clickInteligente(page, selector) {
    try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.click(selector);
    } catch (e) {
        await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector).catch(() => {});
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

// ============================================================================
// 4. PROCESOS DE CAPTURA
// ============================================================================

async function activarVideoSandbox(page) {
    console.log("\n🎬 Buscando reproductor en la página...");
    const playSelectors = ['.vjs-big-play-button', '.play-button', '.btn-play', '[class*="play"]', 'video'];
    const startTime = Date.now();

    while (Date.now() - startTime < 20000) {
        if (state.videoCapturado) return true;
        const frames = page.frames();
        for (const frame of frames) {
            for (const selector of playSelectors) {
                try {
                    const el = await frame.$(selector);
                    if (el) {
                        await frame.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
                        await new Promise(r => setTimeout(r, 2000));
                        if (state.videoCapturado) return true;
                    }
                } catch (e) {}
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function ejecutarFlujoNavegacion(page, receta, keyword, isAuto, targetId, urlBase) {
    let targetUrl = "";
    let clasificacionFinal = "SERIE";
    let capituloElegido = 1;

    if (isAuto && urlBase) {
        const data = db.prepare('SELECT * FROM contenidos WHERE id = ?').get(targetId);
        capituloElegido = data.episodio;
        clasificacionFinal = data.clasificacion;
        targetUrl = generarUrlEpisodio(urlBase, capituloElegido, receta);
    } else {
        // --- FLUJO MANUAL ---
        await page.goto(`https://${receta.dominio}`, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        const sSelector = receta.searchSelector || 'input[type="search"], input[name="q"], #search';
        await page.waitForSelector(sSelector, { timeout: 10000 });
        await page.$eval(sSelector, (el, val) => {
            el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
        }, keyword);

        const subSelector = receta.submitSelector || 'button[type="submit"], input[type="submit"], .search-submit';
        try { await page.click(subSelector); } catch (e) { await page.$eval(sSelector, (el) => el.closest('form')?.submit()); }
        await esperarBypass(page);

        const resultados = await page.evaluate((kw) => {
            return Array.from(document.querySelectorAll('a'))
                .map(a => ({ href: a.href, text: a.innerText.trim() }))
                .filter(e => e.text.toLowerCase().includes(kw.toLowerCase()));
        }, keyword);

        if (resultados.length === 0) throw new Error("No se encontró el show.");

        console.log(`\n📺 RESULTADOS:`);
        resultados.forEach((r, idx) => console.log(`  ${idx + 1}. ${r.text}`));
        const sel = parseInt(await pregunta(`\n👉 Selecciona el show (1-${resultados.length}): `), 10) - 1;
        const show = resultados[sel] || resultados[0];
        urlBase = show.href;

        const resClas = (await pregunta(`\n👉 (S)erie o (P)elícula? [Def: S]: `)).trim().toUpperCase();
        clasificacionFinal = (resClas === 'P') ? 'PELICULA_OVA' : 'SERIE';

        await page.goto(urlBase, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        if (clasificacionFinal === 'SERIE') {
            capituloElegido = parseInt(await pregunta(`👉 Capítulo: `), 10) || 1;
            targetUrl = generarUrlEpisodio(urlBase, capituloElegido, receta);
        } else {
            targetUrl = urlBase;
        }
    }

    console.log(`➡️ Navegando al destino: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await esperarBypass(page);

    // Interactuar con el reproductor
    await clickInteligente(page, '.video-play');
    await activarVideoSandbox(page);

    return { urlBase, clasificacionFinal, capituloElegido };
}

// ============================================================================
// 5. ORQUESTADOR PRINCIPAL
// ============================================================================
async function main() {
    initDatabase();
    console.log("======================================================");
    console.log(ARG_AUTO ? "🤖 MODO AUTOMÁTICO" : "🤖 MODO MANUAL");
    console.log("======================================================");

    let receta, keyword, urlBaseFinal = null, horaFinal = ARG_HORA;

    if (ARG_AUTO) {
        if (!ARG_ID) { console.error("❌ --auto requiere --id=X"); process.exit(1); }
        const data = db.prepare('SELECT * FROM contenidos WHERE id = ?').get(ARG_ID);
        if (!data) { console.error("❌ ID no encontrado"); process.exit(1); }
        
        keyword = data.titulo;
        urlBaseFinal = data.url_base;
        receta = cargarRecetaPorDominio(data.dominio);
        state.isAuto = true;
        state.targetId = ARG_ID;
    } else {
        // Selección de receta manual
        const configsDir = path.join(__dirname, 'configs');
        const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
        archivos.forEach((f, i) => console.log(`  ${i+1}. ${f}`));
        const sel = parseInt(await pregunta("\n👉 Selecciona receta: "), 10) - 1;
        receta = JSON.parse(fs.readFileSync(path.join(configsDir, archivos[sel] || archivos[0]), 'utf8'));
        keyword = (await pregunta(`\n📺 ¿Qué buscas?: `)).trim();
        horaFinal = (await pregunta(`\n👉 Hora (HH:MM) o vacío: `)).trim() || null;
    }

    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: ["--start-maximized"],
        turnstile: true,
        connectOption: { defaultViewport: null }
    });

    // Escuchador de red para capturar el stream
    page.on('response', (response) => {
        const url = response.url().toLowerCase();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('1xbet')) {
            state.videoCapturado = response.url();
        }
    });

    try {
        const result = await ejecutarFlujoNavegacion(page, receta, keyword, state.isAuto, state.targetId, urlBaseFinal);

        if (state.videoCapturado) {
            console.log(`\n🎉 ¡ÉXITO! Enlace: ${state.videoCapturado}`);
            if (state.isAuto) {
                db.prepare('UPDATE contenidos SET url_final = ?, fecha_captura = CURRENT_TIMESTAMP WHERE id = ?')
                  .run(state.videoCapturado, state.targetId);
            } else {
                db.prepare('INSERT INTO contenidos (titulo, clasificacion, episodio, url_final, url_base, dominio, hora_programada, reproducido) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
                  .run(keyword, result.clasificacionFinal, result.capituloElegido, state.videoCapturado, result.urlBase, receta.dominio, horaFinal);
            }
        } else {
            console.log("\n❌ No se pudo capturar el stream.");
        }
    } catch (e) {
        console.error(`❌ Error: ${e.message}`);
    } finally {
        await browser.close();
        rl.close();
    }
}

main();