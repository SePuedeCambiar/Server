const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ============================================================================
// CONFIGURACIÓN DE PRODUCCIÓN
// ============================================================================
const MODO_INVISIBLE = "auto"; 

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

global.videoCapturado = null;
global.popupDetectado = false;

// ============================================================================
// FUNCIONES DE BYPASS Y ESTABILIDAD MEJORADAS
// ============================================================================
async function esperarBypass(page, maxIntentos = 20) {
    await new Promise(r => setTimeout(r, 3000));

    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            
            let esDesafio = titulo.toLowerCase().includes('just a moment') || url.includes('challenges.cloudflare.com');
            
            if (!esDesafio) {
                esDesafio = await page.evaluate(() => {
                    const html = document.documentElement.innerHTML.toLowerCase();
                    return html.includes('cf-challenge') || 
                           html.includes('challenges.cloudflare.com') || 
                           document.querySelector('#cf-turnstile-iframe') !== null ||
                           document.querySelector('iframe[src*="challenges.cloudflare.com"]') !== null;
                }).catch(() => false);
            }

            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Resolviendo escudo de Cloudflare...`);
                await new Promise(r => setTimeout(r, 3500));
            } else if (url !== 'about:blank' && !url.startsWith('about:') && url.trim().length > 10) {
                await new Promise(r => setTimeout(r, 2000));
                return true;
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
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

        global.popupDetectado = false;
        await page.click(selector);
    } catch (error) {
        try {
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.click();
            }, selector);
        } catch (e) {
            throw new Error(`Selector inalcanzable: ${selector}`);
        }
    }
    await new Promise(r => setTimeout(r, 1500));
}

// ============================================================================
// ESCÁNER Y SELECCIÓN DE RECETAS EN EL DISCO
// ============================================================================
function cargarRecetaAutomatica() {
    const configsDir = path.join(__dirname, 'configs');
    if (!fs.existsSync(configsDir)) {
        fs.mkdirSync(configsDir, { recursive: true });
        return null;
    }

    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));

    if (archivos.length === 0) {
        return null;
    }

    if (archivos.length === 1) {
        const recetaPath = path.join(configsDir, archivos[0]);
        console.log(`\n📂 Usando única receta encontrada: ${archivos[0]}`);
        return JSON.parse(fs.readFileSync(recetaPath, 'utf8'));
    }

    return null;
}

async function elegirRecetaInteractiva() {
    const configsDir = path.join(__dirname, 'configs');
    const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));

    console.log(`\n======================================================`);
    console.log(`📂 RECETAS DISPONIBLES EN EL DISCO`);
    console.log(`======================================================`);
    archivos.forEach((file, idx) => {
        console.log(`  ${idx + 1}. ${file.replace('_receta.json', '')}`);
    });
    console.log(`======================================================`);

    const seleccion = parseInt(await pregunta("\n👉 Selecciona una receta: "), 10) - 1;
    if (seleccion >= 0 && seleccion < archivos.length) {
        const recetaPath = path.join(configsDir, archivos[seleccion]);
        return JSON.parse(fs.readFileSync(recetaPath, 'utf8'));
    }

    console.log("❌ Selección inválida. Usando la primera receta por defecto.");
    return JSON.parse(fs.readFileSync(path.join(configsDir, archivos[0]), 'utf8'));
}

// ============================================================================
// DETECTOR DINÁMICO DE CAPÍTULOS
// ============================================================================
async function obtenerTotalCapitulos(page, dominio) {
    return await page.evaluate((dom) => {
        const text = document.body.innerText;
        let total = 1;

        const regexes = [
            /Episodios:\s*(\d+)/i,
            /Capítulos:\s*(\d+)/i,
            /Episodes:\s*(\d+)/i,
            /(\d+)\s*Episodios/i
        ];
        for (const regex of regexes) {
            const match = text.match(regex);
            if (match && match[1]) {
                total = parseInt(match[1], 10);
                break;
            }
        }

        const uep = document.querySelector('#uep');
        if (uep) {
            const match = uep.innerText.match(/(\d+)/);
            if (match) total = parseInt(match[1], 10);
        }

        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
            const match = script.innerText.match(/episodes\s*=\s*\[\[(\d+)/);
            if (match && match[1]) {
                total = Math.max(total, parseInt(match[1], 10));
            }
        }

        const paginationSelect = document.querySelector('select[class*="pagination"], select[id*="pagination"]');
        if (paginationSelect && paginationSelect.options.length > 0) {
            const ultimaOpcion = paginationSelect.options[paginationSelect.options.length - 1].text;
            const match = ultimaOpcion.match(/(\d+)/);
            if (match) total = Math.max(total, parseInt(match[1], 10));
        }

        return total;
    }, dominio);
}

// ============================================================================
// SELECCIÓN INTERACTIVA DE SHOWS EN LOS RESULTADOS DE BÚSQUEDA
// ============================================================================
async function elegirCoincidenciaInteractiva(page, keyword, dominio) {
    console.log(`\n🔎 Buscando resultados para: '${keyword}'...`);
    
    const enlaces = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
            href: a.href,
            text: a.innerText.trim()
        })).filter(a => a.text.length > 2);
    });

    const keywordLimpia = keyword.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); 
    const resultadosMap = new Map();

    for (const enlace of enlaces) {
        const url = enlace.href.toLowerCase();
        const texto = enlace.text.toLowerCase();

        if (url.includes('/buscar') || url.includes('/explorar') || url.includes('/browse') || url.includes('/genero') || url.includes('/series')) {
            continue;
        }
        if (!url.includes(dominio)) continue;

        const matchTexto = texto.includes(keywordLimpia) || url.includes(keywordLimpia.replace(/[^a-z0-9]/g, '-'));

        if (matchTexto) {
            resultadosMap.set(enlace.href, enlace.text);
        }
    }

    const resultados = Array.from(resultadosMap.entries()).map(([href, text]) => ({ href, text }));

    if (resultados.length === 0) {
        return null;
    }

    console.log(`\n======================================================`);
    console.log(`📺 SHOWS ENCONTRADOS EN ${dominio.toUpperCase()}`);
    console.log(`======================================================`);
    resultados.forEach((r, idx) => {
        console.log(`  ${idx + 1}. ${r.text}`);
    });
    console.log(`======================================================`);

    const seleccion = parseInt(await pregunta("\n👉 Selecciona el show correcto: "), 10) - 1;
    if (seleccion >= 0 && seleccion < resultados.length) {
        return resultados[seleccion].href;
    }
    
    return resultados[0].href;
}

// ============================================================================
// CONSTRUCCIÓN DINÁMICA DE URL DE EPISODIOS
// ============================================================================
function obtenerSelectorBuscadorDinamico(receta, dominio) {
    const pasoType = receta.pasos ? receta.pasos.find(p => p.tipo === 'TYPE') : null;
    if (pasoType && pasoType.selector) {
        return pasoType.selector;
    }
    if (dominio.includes('jkanime')) return '#buscanime';
    if (dominio.includes('animeflv')) return 'input[name="q"]';
    if (dominio.includes('cuevana')) return '#keysss';
    return 'input[type="search"], input[name="q"]';
}

function generarUrlEpisodioDinamica(showUrl, capitulo, receta) {
    const urls = receta.historialNavegacion.map(h => h.url);
    const urlEpisodioGrabado = urls.find(url => url.match(/[-/](\d+)\/?$/));
    if (!urlEpisodioGrabado) return showUrl; 

    const matchEp = urlEpisodioGrabado.match(/[-/](\d+)\/?$/);
    const nroGrabado = matchEp[1]; 

    const urlFichaGrabada = urls.find(url => {
        return !url.match(/[-/](\d+)\/?$/) && 
               url.split('/').filter(p => p.length > 0).length >= 3 && 
               !url.includes('/buscar') && !url.includes('/explorar') && !url.includes('/browse');
    });
    if (!urlFichaGrabada) return showUrl;

    const slugGrabado = urlFichaGrabada.split('/').filter(p => p.length > 0).pop();
    const slugActual = showUrl.split('/').filter(p => p.length > 0).pop();

    let urlFinal = urlEpisodioGrabado
        .replace(slugGrabado, slugActual)
        .replace(new RegExp(`([-|/])${nroGrabado}(/)?$`), `$1${capitulo}$2`);

    return urlFinal;
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
        while (Date.now() - startTime < 30000) { 
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

// ============================================================================
// ORQUESTADOR CON AUTO-DIAGNÓSTICO
// ============================================================================
async function main() {
    console.log("======================================================");
    console.log("🤖 REPRODUCTOR ADAPTATIVO CON DIAGNÓSTICO v6.6");
    console.log("======================================================");

    // --- 1. LECTURA ADAPTATIVA DE RECETAS EN DISCO ---
    let receta = cargarRecetaAutomatica();
    if (!receta) {
        const configsDir = path.join(__dirname, 'configs');
        const archivos = fs.readdirSync(configsDir).filter(f => f.endsWith('_receta.json'));
        if (archivos.length === 0) {
            console.error("❌ No se encontraron recetas en la carpeta configs/. Graba una primero.");
            rl.close();
            return;
        }
        receta = await elegirRecetaInteractiva();
    }

    let clasificacion = receta.metadata?.clasificacion || 'SERIE';
    console.log(`📂 Receta activa | Dominio: ${receta.dominio}`);

    // --- 2. PEDIR DATOS DE BÚSQUEDA INICIALES ---
    const keyword = (await pregunta(`\n📺 ¿Qué quieres buscar?: `)).trim();
    if (!keyword) {
        console.log("❌ Debes ingresar un término de búsqueda.");
        rl.close();
        return;
    }

    // 3. INICIAR NAVEGADOR EN SEGUNDO PLANO
    console.log("\n🚀 Iniciando navegador indetectable en segundo plano...");
    const { browser, page } = await connect({
        headless: MODO_INVISIBLE, 
        args: ["--start-maximized"],
        turnstile: true, 
        connectOption: { defaultViewport: null }
    });

    await page.evaluateOnNewDocument(() => { window.open = () => null; });

    // POPUP BLOCKER CON RETRASO
    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const newPage = await target.page();
            if (newPage && newPage !== page) {
                try {
                    await new Promise(r => setTimeout(r, 600)); 
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

        // --- 4. EJECUTAR BÚSQUEDA DINÁMICA CON DISPARO NATIVO ---
        const searchSelector = obtenerSelectorBuscadorDinamico(receta, receta.dominio);
        console.log(`🔍 Escribiendo '${keyword}' en '${searchSelector}'...`);
        
        await page.waitForSelector(searchSelector, { timeout: 10000 });
        await page.$eval(searchSelector, (el, val) => {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, keyword);

        const submitSelector = searchSelector === '#keysss' ? '#search-submit' : (searchSelector === '#buscanime' ? '#btn_qsubmit' : 'button[type="submit"]');
        try {
            await page.click(submitSelector);
        } catch (e) {
            await page.$eval(searchSelector, (el) => {
                const form = el.closest('form');
                if (form) {
                    if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit();
                    } else {
                        form.submit();
                    }
                }
            });
        }

        console.log("⏳ Esperando transición a los resultados...");
        await esperarBypass(page);

        // --- 5. SELECCIÓN INTERACTIVA DE SHOWS ---
        const showUrl = await elegirCoincidenciaInteractiva(page, keyword, receta.dominio);
        if (!showUrl) {
            throw new Error(`No se encontró ninguna coincidencia para '${keyword}' en los resultados de búsqueda.`);
        }
        console.log(`✅ Coincidencia elegida: ${showUrl}`);

        // --- 6. PREGUNTA CLAVE DE CLASIFICACIÓN ---
        const defaultClas = receta.metadata?.clasificacion === 'PELICULA_OVA' ? 'P' : 'S';
        const respuestaClas = (await pregunta(`\n👉 ¿El contenido es una (S)erie o una (P)elícula/OVA? [Por defecto: ${defaultClas}]: `)).trim().toUpperCase();
        
        let clasificacionFinal = receta.metadata?.clasificacion || 'SERIE';
        if (respuestaClas === 'P') clasificacionFinal = 'PELICULA_OVA';
        if (respuestaClas === 'S') clasificacionFinal = 'SERIE';

        // --- 7. NAVEGAR A LA FICHA DEL SHOW ---
        console.log(`➡️ Entrando a la ficha del show: ${showUrl}`);
        await page.goto(showUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // --- 8. ESCANEO DINÁMICO DE CAPÍTULOS (SÓLO SI ES SERIE) ---
        let targetUrl = showUrl;
        if (clasificacionFinal === 'SERIE') {
            console.log("⏳ Analizando la ficha del show para contar los capítulos...");
            const totalCapitulos = await obtenerTotalCapitulos(page, receta.dominio);
            console.log(`\n======================================================`);
            console.log(`📺 CAPÍTULOS DETECTADOS EN LA WEB: ${totalCapitulos}`);
            console.log(`======================================================`);

            let capituloElegido = null;
            while (true) {
                const seleccionCap = await pregunta(`👉 Ingresa el capítulo que deseas reproducir (1 al ${totalCapitulos}): `);
                capituloElegido = parseInt(seleccionCap, 10);
                if (!isNaN(capituloElegido) && capituloElegido >= 1 && capituloElegido <= totalCapitulos) {
                    break;
                }
                console.log(`❌ Entrada inválida. Debe ser un número entre 1 y ${totalCapitulos}.`);
            }

            // Construir URL final del capítulo de forma dinámica
            targetUrl = generarUrlEpisodioDinamica(showUrl, capituloElegido, receta);
        }

        // --- 9. IR AL CAPÍTULO FINAL Y REPRODUCIR ---
        console.log(`➡️ Navegando al contenido final: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await esperarBypass(page);

        // ============================================================================
        // 🧪 MÓDULO DE AUTO-DIAGNÓSTICO EN VIVO (MÉDICO DE DOM)
        // ============================================================================
        console.log("\n🧪 EJECUTANDO AUTO-DIAGNÓSTICO EN LA PÁGINA FINAL...");
        const diagnostico = await page.evaluate(() => {
            const hasVideoPlay = document.querySelector('.video-play') !== null;
            const hasTabsVideo = document.querySelector('.tabs-video') !== null;
            const servers = Array.from(document.querySelectorAll('li[role="presentation"], .server-item')).map(el => el.innerText.trim());
            const totalIframes = document.querySelectorAll('iframe').length;
            const iframesUrls = Array.from(document.querySelectorAll('iframe')).map(f => f.src);
            return { hasVideoPlay, hasTabsVideo, servers, totalIframes, iframesUrls };
        });

        console.log(`   └─ ¿Existe botón de Play estático (.video-play)?: ${diagnostico.hasVideoPlay ? 'SÍ' : 'NO'}`);
        console.log(`   └─ ¿Existe contenedor de servidores (.tabs-video)?: ${diagnostico.hasTabsVideo ? 'SÍ' : 'NO'}`);
        console.log(`   └─ Servidores detectados en la lista: ${JSON.stringify(diagnostico.servers)}`);
        console.log(`   └─ Reproductores (iframes) cargados inicialmente: ${diagnostico.totalIframes}`);
        if (diagnostico.totalIframes > 0) {
            console.log(`   └─ URLs de iframes: ${JSON.stringify(diagnostico.iframesUrls)}`);
        }

        // ============================================================================
        // 🔄 MÓDULO DE AUTOCURACIÓN ACTIVA (FUERZA BRUTA INTELIGENTE)
        // ============================================================================
        // Si no se ejecutan pasos de la receta o fallan, forzamos los clics necesarios
        if (diagnostico.hasVideoPlay) {
            console.log("\n⚡ [Autocuración] Forzando clic en el botón de reproducción (.video-play)...");
            await clickInteligente(page, '.video-play');
            await new Promise(r => setTimeout(r, 4000));
        }

        if (diagnostico.servers.length > 0) {
            console.log("\n⚡ [Autocuración] Forzando clic en el primer servidor de la lista (.tab-video-item)...");
            await page.evaluate(() => {
                const primerServidor = document.querySelector('li[role="presentation"], .server-item');
                if (primerServidor) primerServidor.click();
            });
            await new Promise(r => setTimeout(r, 5000));
        }

        // Volvemos a verificar el estado de los iframes tras la autocuración
        const nuevoTotalIframes = await page.evaluate(() => document.querySelectorAll('iframe').length);
        console.log(`   └─ Reproductores (iframes) tras autocuración: ${nuevoTotalIframes}`);

        // --- 11. DISPARAR EL REPRODUCTOR ---
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
        console.log(`\n🧹 Cerrando procesos...`);
        await browser.close().catch(() => {});
        rl.close();
    }
}

main();