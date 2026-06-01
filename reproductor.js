const { connect } = require('puppeteer-real-browser'); // Usamos el motor indetectable directamente
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// ============================================================================
// CONFIGURACIÓN DE PRODUCCIÓN
// ============================================================================
const MODO_INVISIBLE = false; // <-- Cambia a 'true' para que el robot reproduzca en segundo plano

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pregunta = (texto) => new Promise((resolve) => rl.question(texto, resolve));

const AD_BLOCK_LIST = [
    'adsterra', 'popads', 'onclickads', 'mgid', 'exoclick', 'doubleclick', 
    'google-analytics', 'popunder', 'adservice', 'disqus', 'facebook', 
    'twitter', 'recaptcha', 'cloudflareinsights', 'beacon', 'coinhive', 
    'adskeeper', 'propellerads', 'juicyads', 'exdynsrv', 'optad360', 
    'yieldlove', 'adform', 'taboola', 'smartadserver', '1xbet', 'bet365', 'xbeat'
];

global.popupDetectado = false;

// ============================================================================
// AUXILIARES
// ============================================================================
function extraerSlug(url) {
    try {
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('/').filter(p => p.length > 0);
        return parts[parts.length - 1];
    } catch (e) { return ''; }
}

async function esperarBypass(page, maxIntentos = 15) {
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const titulo = await page.title().catch(() => '');
            const url = page.url();
            const esDesafio = titulo.toLowerCase().includes('just a moment') || url.includes('challenges.cloudflare.com');
            if (esDesafio) {
                console.log(`⏳ [${i}/${maxIntentos}] Esperando resolución de Turnstile...`);
                await new Promise(r => setTimeout(r, 3000));
            } else if (url !== 'about:blank' && !url.startsWith('about:') && url.trim().length > 10) {
                return true;
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return false;
}

// Clic inteligente con algoritmo de reintento si un anuncio secuestra la acción
async function clickInteligente(page, selector) {
    await page.waitForSelector(selector, { timeout: 15000 });
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
    }, selector);

    global.popupDetectado = false; // Reset

    try {
        await page.click(selector);
    } catch (error) {
        await page.$eval(selector, el => el.click());
    }

    await new Promise(r => setTimeout(r, 1500));

    if (global.popupDetectado) {
        console.log(`   🛡️  [Anti-Secuestro] El clic abrió publicidad. Re-intentando clic limpio...`);
        global.popupDetectado = false; // Reset
        try {
            await page.click(selector);
        } catch (e) {
            await page.$eval(selector, el => el.click());
        }
    }
}

// Heurística de detección de capítulos máximos en el DOM
async function determinarMaximoEpisodios(page) {
    return await page.evaluate(() => {
        const uep = document.querySelector('#uep');
        if (uep) {
            const match = uep.innerText.match(/(\d+)/);
            if (match) return parseInt(match[1], 10);
        }
        const select = document.querySelector('select[class*="pagination"], select[id*="pagination"]');
        if (select && select.options.length > 0) {
            const ultimaOpcion = select.options[select.options.length - 1].text;
            const match = ultimaOpcion.match(/(\d+)/g);
            if (match) return parseInt(match[match.length - 1], 10);
        }
        const textoPagina = document.body.innerText;
        const matchTexto = textoPagina.match(/Episodios:\s*(\d+)/i);
        if (matchTexto) return parseInt(matchTexto[1], 10);
        return null;
    });
}

// Generar URL del capítulo elegido según la estructura del sitio
function generarUrlEpisodio(urlFicha, capitulo, dominio) {
    const urlObj = new URL(urlFicha);
    const slug = extraerSlug(urlFicha);
    const base = urlObj.origin + urlObj.pathname;
    const baseConBarra = base.endsWith('/') ? base : base + '/';

    if (dominio.includes('animeflv')) {
        return `${urlObj.origin}/ver/${slug}-${capitulo}`;
    }
    return `${baseConBarra}${capitulo}/`;
}

// ============================================================================
// REPRODUCTOR DE RECETAS INTELIGENTE
// ============================================================================
async function main() {
    console.log("======================================================");
    console.log("🤖 PROGRAMA 2: REPRODUCTOR INTELIGENTE UNIVERSAL");
    console.log("======================================================");

    const dominio = (await pregunta("🔗 ¿De qué dominio quieres reproducir la receta? (ej: cuevana.cz): ")).trim();
    
    // Resolvemos la ruta del JSON de forma robusta
    const recetaPath = path.join(__dirname, 'configs', `${dominio}_receta.json`);
    const recetaAlternativePath = path.join(__dirname, 'configs', 'configs', `${dominio}_receta.json`);
    
    let finalPath = fs.existsSync(recetaPath) ? recetaPath : recetaAlternativePath;

    if (!fs.existsSync(finalPath)) {
        console.error(`❌ Error: No se encontró la receta para ${dominio}.`);
        rl.close();
        return;
    }

    const receta = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
    
    // --- CLASIFICACIÓN POR DOBLE VERIFICACIÓN ---
    let clasificacion = 'PELICULA_OVA';
    const finalUrl = receta.finalUrl || '';

    const esPeliculaExplicita = finalUrl.includes('/pelicula/') || finalUrl.includes('/movie/');
    const esSerieExplicita = finalUrl.includes('/serie/') || finalUrl.includes('/anime/') || finalUrl.includes('/ver/') || finalUrl.includes('/episodio/') || finalUrl.includes('/ep/') || finalUrl.includes('/capitulo/');

    if (esPeliculaExplicita) {
        clasificacion = 'PELICULA_OVA'; 
    } else if (esSerieExplicita) {
        clasificacion = 'SERIE';
    } else {
        const matchNum = finalUrl.match(/[-/](\d+)\/?$/);
        if (matchNum && parseInt(matchNum[1], 10) > 0) {
            const slug = extraerSlug(finalUrl);
            const tieneFichaPrevia = receta.historialNavegacion.some(n => {
                const prevSlug = extraerSlug(n.url);
                const prevMatch = n.url.match(/[-/](\d+)\/?$/);
                return prevSlug === slug && !prevMatch;
            });
            clasificacion = tieneFichaPrevia ? 'SERIE' : 'PELICULA_OVA';
        }
    }

    console.log(`📂 Receta cargada | Clasificación Real: ${clasificacion} | Pasos: ${receta.pasos.length}`);

    // --- REGLA 1: PARAMETRIZACIÓN DE BÚSQUEDA ---
    const pasoType = receta.pasos.find(p => p.tipo === 'TYPE');
    if (pasoType) {
        const nuevaBusqueda = (await pregunta(`📺 ¿Qué deseas buscar? (Por defecto: '${pasoType.texto}'): `)).trim();
        if (nuevaBusqueda) {
            pasoType.texto = nuevaBusqueda; 
        }
    }

    // --- REGLA 2: PARAMETRIZACIÓN DE CAPÍTULO ---
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

    // 1. INICIAR NAVEGADOR INDETECTABLE (Igual al sandbox de prueba)
    console.log("\n🚀 Iniciando navegador indetectable con Solver de captchas...");
    const { browser, page } = await connect({
        headless: MODO_INVISIBLE,
        args: ["--start-maximized"],
        turnstile: true, 
        connectOption: { defaultViewport: null }
    });

    // Bloqueo de popups para evitar crasheos de rebrowser
    await page.evaluateOnNewDocument(() => {
        window.open = () => null;
    });

    let videoCapturado = null;

    // POPUP BLOCKER
    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const newPage = await target.page();
            if (newPage && newPage !== page) {
                try {
                    const url = newPage.url();
                    console.log(`   🛡️  [Popup Blocker] Cerrando pestaña publicitaria: ${url.substring(0, 45)}...`);
                    global.popupDetectado = true; 
                    await newPage.close(); 
                } catch (e) {}
            }
        }
    });

    // SNIFFER DE RED PASIVO (REGLA 3)
    page.on('response', (response) => {
        try {
            const url = response.url().toLowerCase();
            if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('/get_video') || url.includes('video.php')) {
                if (!url.includes('1xbet') && !url.includes('doubleclick')) {
                    console.log(`\n🎯 ¡VIDEO DETECTADO PASIVAMENTE!:`);
                    console.log(`🔗 ${response.url()}`);
                    videoCapturado = response.url();
                }
            }
        } catch (e) {}
    });

    try {
        const urlInicio = `https://${receta.dominio}`;
        console.log(`\n🚀 Navegando a la página de inicio: ${urlInicio}`);
        
        // CORRECCIÓN CLAVE: Usamos 'domcontentloaded' para evitar el timeout por culpa de la publicidad infinita
        await page.goto(urlInicio, { waitUntil: 'domcontentloaded' });

        console.log("🔐 Verificando bypass de Cloudflare...");
        await esperarBypass(page);

        // EJECUCIÓN DE PASOS
        for (let i = 0; i < receta.pasos.length; i++) {
            const paso = receta.pasos[i];

            // --- REGLA DE PAGINACIÓN DINÁMICA DE SERIES ---
            if (clasificacion === 'SERIE' && paso.url) {
                const regexNum = /(\d+)\/?$/;
                if (regexNum.test(paso.url)) {
                    paso.url = paso.url.replace(regexNum, `${capituloElegido}/`);
                    console.log(`   🛠️  [Paginación] Redireccionando paso al capítulo ${capituloElegido}: ${paso.url}`);
                }
            }

            try {
                if (paso.tipo === 'TYPE') {
                    console.log(`➡️  [Paso ${i + 1}/${receta.pasos.length}] Escribiendo: '${paso.texto}' en '${paso.selector}'`);
                    await page.waitForSelector(paso.selector, { timeout: 15000 });
                    await page.$eval(paso.selector, (el, val) => el.value = val, paso.texto);
                    await page.$eval('#search-form', form => form.submit());
                } else if (paso.url && paso.selector === 'a') {
                    console.log(`➡️  [Paso ${i + 1}/${receta.pasos.length}] Atajo: Navegando directamente a ${paso.url}`);
                    
                    // CORRECCIÓN CLAVE: Usamos 'domcontentloaded'
                    await page.goto(paso.url, { waitUntil: 'domcontentloaded' });
                } else {
                    console.log(`➡️  [Paso ${i + 1}/${receta.pasos.length}] Ejecutando: CLICK sobre '${paso.selector}'`);
                    
                    if (paso.url) {
                        // ALGORITMO DE VERIFICACIÓN DE NAVEGACIÓN
                        const urlInicial = page.url();
                        let exitoNav = false;
                        const maxIntentos = 3;

                        for (let intento = 1; intento <= maxIntentos; intento++) {
                            console.log(`   👉 Intentando clic de navegación (Intento ${intento}/${maxIntentos})...`);
                            await clickInteligente(page, paso.selector);
                            await new Promise(r => setTimeout(r, 1000));
                            
                            if (page.url() !== urlInicial) {
                                console.log(`   ✅ Navegación confirmada. URL cambió a: ${page.url()}`);
                                exitoNav = true;
                                break;
                            }
                            console.log(`   ⚠️ La URL no cambió. Reintentando...`);
                        }

                        if (!exitoNav) {
                            console.log(`   ⚡ [Bypass Clic] Extrayendo el enlace de destino real del elemento en pantalla...`);
                            const hrefReal = await page.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                const a = el ? el.closest('a') : null;
                                return a ? a.href : null;
                            }, paso.selector);

                            if (hrefReal) {
                                console.log(`   🔗 Enlace real detectado: ${hrefReal}. Forzando redirección directa...`);
                                
                                // CORRECCIÓN CLAVE: Usamos 'domcontentloaded'
                                await page.goto(hrefReal, { waitUntil: 'domcontentloaded' });
                            } else {
                                throw new Error("Fallo la navegación física y no se pudo resolver el enlace en el DOM");
                            }
                        }
                    } else {
                        await clickInteligente(page, paso.selector);
                    }
                }
            } catch (errorPaso) {
                console.log(`   ⚠️  [Paso Omitido] No se pudo ejecutar el paso ${i + 1} (${errorPaso.message.substring(0, 40)}...). Continuando...`);
            }

            // Pausa de estabilidad
            await new Promise(r => setTimeout(r, 2500));
        }

        console.log("\n⌛ Esperando a que el reproductor suelte el stream...");
        for (let s = 0; s < 15; s++) {
            if (videoCapturado) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        if (videoCapturado) {
            console.log("\n======================================================");
            console.log("🎉 ¡ÉXITO TOTAL! El robot resolvió el camino por sí solo.");
            console.log("======================================================");
        } else {
            console.log("\n❌ El proceso terminó pero no se logró capturar el stream de video.");
        }

    } catch (e) {
        console.error(`❌ Error durante la reproducción: ${e.message}`);
    } finally {
        await new Promise(r => setTimeout(r, 5000));
        console.log(`🧹 Cerrando navegador...`);
        await browser.close().catch(() => {});
        rl.close();
    }
}