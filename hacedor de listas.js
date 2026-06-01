const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

puppeteer.use(StealthPlugin());

const CONFIG = {
    CONFIG_DIR: path.join(__dirname, 'configs'),
    OUTPUT_FILE: path.join(__dirname, 'enlaces_extraidos_general.txt'),
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    BLACKLIST_ADS: ['adsterra', 'popads', 'onclickads', 'mgid', 'exoclick', 'doubleclick', 'google-analytics', 'onclick', 'popunder']
};

// ============================================================================
// FUNCIONES AUXILIARES
// ============================================================================
function asegurarProtocolo(url) {
    let limpia = url.trim();
    if (!/^https?:\/\//i.test(limpia)) {
        limpia = 'https://' + limpia;
    }
    return limpia;
}

// ============================================================================
// CLASE 1: CARGADOR DE CONFIGURACIONES
// ============================================================================
class ConfigLoader {
    static loadConfigForUrl(url) {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace('www.', ''); 

        let configPath = path.join(CONFIG.CONFIG_DIR, `${hostname}.json`);

        if (!fs.existsSync(configPath)) {
            const alias = hostname.split('.')[0];
            configPath = path.join(CONFIG.CONFIG_DIR, `${alias}.json`);
        }

        if (fs.existsSync(configPath)) {
            console.log(`📂 Configuración encontrada: ${configPath}`);
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        
        throw new Error(`No se encontró un archivo de configuración para "${hostname}" en la carpeta configs/`);
    }
}

// ============================================================================
// CLASE 2: MOTOR DINÁMICO (Búsqueda y Episodios)
// ============================================================================
class DynamicHandler {
    constructor(config) {
        this.config = config;
    }

    async search(page, keyword) {
        console.log(`📡 Buscando en ${this.config.name}...`);
        const searchPath = this.config.searchPattern.replace('{query}', encodeURIComponent(keyword));
        const searchUrl = `${new URL(page.url()).origin}${searchPath}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    }

    async extractLinks(page) {
        return await page.evaluate((cfg) => {
            const items = Array.from(document.querySelectorAll(cfg.itemSelector));
            return items.map(item => {
                const linkEl = item.querySelector(cfg.linkSelector);
                const titleEl = item.querySelector(cfg.titleSelector);
                return linkEl ? { 
                    texto: titleEl?.innerText.trim() || 'Sin título', 
                    href: linkEl.href 
                } : null;
            }).filter(i => i !== null);
        }, this.config);
    }

    async extractEpisodes(page, showUrl) {
        if (!this.config.episodeStrategy) return [];

        const strategy = this.config.episodeStrategy;

        if (strategy.type === 'range') {
            const total = await page.evaluate((strat) => {
                const text = document.body.innerText;
                const regex = new RegExp(strat.regex, 'i');
                const match = text.match(regex);
                
                if (match && match[1]) return parseInt(match[1], 10);
                
                const matchNuevo = text.match(/-\s*(\d+)\s*Nuevo/i);
                if (matchNuevo && matchNuevo[1]) return parseInt(matchNuevo[1], 10);
                
                return 1;
            }, strategy);

            const list = [];
            for (let i = 1; i <= total; i++) {
                const epUrl = strategy.urlPattern
                    .replace('{showUrl}', showUrl)
                    .replace('{number}', i);
                list.push({ texto: `Capítulo ${i}`, href: epUrl });
            }
            return list;
        }

        if (strategy.type === 'scrape') {
            return await page.evaluate((strat) => {
                const elements = Array.from(document.querySelectorAll(strat.itemSelector));
                return elements.map(el => {
                    const title = el.innerText.trim() || 'Episodio';
                    const href = el.href;
                    return href ? { texto: title, href } : null;
                }).filter(i => i !== null);
            }, strategy);
        }

        return [];
    }

    async extractVideoServers(page) {
        return await page.evaluate((blacklist) => {
            const servers = [];
            
            // 1. Buscar Iframes de reproductores
            document.querySelectorAll('iframe').forEach(iframe => {
                const src = iframe.getAttribute('src');
                if (src && src.startsWith('http') && !src.includes('about:blank')) {
                    servers.push(src);
                }
            });

            // 2. Buscar atributos de datos comunes (data-video, data-src, etc.)
            const keyAttributes = ['data-video', 'data-src', 'data-url', 'data-embed', 'data-link'];
            document.querySelectorAll('*').forEach(el => {
                keyAttributes.forEach(attr => {
                    const val = el.getAttribute(attr);
                    if (val && val.startsWith('http')) {
                        servers.push(val);
                    }
                });
            });

            const filtered = servers.filter(url => {
                return !blacklist.some(bad => url.toLowerCase().includes(bad));
            });

            return Array.from(new Set(filtered));
        }, CONFIG.BLACKLIST_ADS);
    }
}

// ============================================================================
// CLASE 3: CAZADOR DE STREAMS (Sniffer de Red Interceptivo)
// ============================================================================
class StreamHunter {
    constructor(referer, rl) {
        this.referer = referer;
        this.rl = rl;
    }

    async hunt(browser, playerUrl) {
        const page = await browser.newPage();
        let videoEncontrado = null;

        try {
            await page.setUserAgent(CONFIG.USER_AGENT);
            
            // Inyectamos evasiones para que no sospechen que es Puppeteer
            await page.evaluateOnNewDocument(() => {
                window.alert = () => {};
                window.confirm = () => true;
                window.prompt = () => null;
                window.open = () => null;
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['es-419', 'es', 'en'] });
            });

            // Interceptamos peticiones de red
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const url = request.url().toLowerCase();
                const headers = Object.assign({}, request.headers());
                
                // Forzamos el Referer para evitar bloqueos del servidor de video
                headers['Referer'] = this.referer;

                // Bloqueamos dominios de publicidad para evitar lentitud
                if (CONFIG.BLACKLIST_ADS.some(ad => url.includes(ad))) {
                    return request.abort();
                }

                // Si detectamos formato de transmisión (.m3u8, .mp4, get_video, etc.)
                if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('/get_video')) {
                    const esBasura = url.includes('favicon') || url.includes('analytics') || url.includes('stripe');
                    if (!esBasura) {
                        videoEncontrado = request.url();
                    }
                }

                request.continue({ headers });
            });

            console.log(`🎥 Abriendo reproductor: ${playerUrl.substring(0, 60)}...`);
            await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30000, referer: this.referer });

            // Clics fantasma para activar el reproductor (muchos servidores requieren clic para soltar la URL)
            for (let click = 0; click < 3; click++) {
                if (videoEncontrado) break;
                try {
                    await page.mouse.click(500, 300); // Clic en el medio de la pantalla
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e) {}
            }

            // Monitoreo del DOM por si el video está directamente en un tag <video>
            for (let seg = 0; seg < 15; seg++) {
                if (videoEncontrado) break;
                videoEncontrado = await page.evaluate(() => {
                    if (window.MDCore && window.MDCore.wurl) {
                        return window.MDCore.wurl.startsWith('//') ? 'https:' + window.MDCore.wurl : window.MDCore.wurl;
                    }
                    const video = document.querySelector('video');
                    if (video && video.src && !video.src.startsWith('blob:')) return video.src;
                    return null;
                });
                await new Promise(r => setTimeout(r, 1000));
            }

        } catch (e) {
            console.error(`❌ Error en el reproductor: ${e.message}`);
        } finally {
            try { await page.close(); } catch (err) {}
        }

        return videoEncontrado;
    }
}

// ============================================================================
// SOPORTE (Browser & Security)
// ============================================================================
class BrowserManager {
    async launch() {
        const chromePath = this._detectChromePath();
        this.browser = await puppeteer.launch({ 
            headless: false, 
            executablePath: chromePath || undefined,
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled'] 
        });
        return this.browser;
    }
    _detectChromePath() {
        const platform = os.platform();
        const paths = {
            linux: ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
            win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
            darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        };
        return (paths[platform] || []).find(p => fs.existsSync(p)) || null;
    }
    async close() { if (this.browser) await this.browser.close(); }
}

class SecurityGuard {
    constructor(rl) { this.rl = rl; }
    async verifyCloudflare(page) {
        await new Promise(r => setTimeout(r, 3000));
        const content = await page.content();
        const title = await page.title();

        if (title.includes('Just a moment') || content.includes('cf-challenge') || content.includes('cloudflare')) {
            console.log(`\n⚠️  [SEGURIDAD] Resuelve el captcha en el navegador...`);
            await page.bringToFront();
            await this.rl.question(`⌨️  Presiona ENTER cuando la página haya cargado...`);
        }
    }
}

// ============================================================================
// ORQUESTADOR
// ============================================================================
class ExtractorApp {
    constructor() {
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        this.browserMgr = new BrowserManager();
        this.security = new SecurityGuard(this.rl);
    }

    async question(text) { return new Promise(resolve => this.rl.question(text, resolve)); }

    async chooseEpisodeInteractive(episodes) {
        let currentPage = 0;
        const pageSize = 12;
        
        while (true) {
            const startIndex = currentPage * pageSize;
            const endIndex = Math.min(startIndex + pageSize, episodes.length);
            const pageItems = episodes.slice(startIndex, endIndex);
            const totalPages = Math.ceil(episodes.length / pageSize);

            console.log(`\n======================================================`);
            console.log(`📺 CAPÍTULOS DISPONIBLES (Pág. ${currentPage + 1} de ${totalPages})`);
            console.log(`======================================================`);
            
            pageItems.forEach((ep, idx) => {
                console.log(`  ${idx + 1}. ${ep.texto}`);
            });

            console.log(`------------------------------------------------------`);
            
            if (endIndex < episodes.length) console.log(`  [M] Cargar más (Siguiente página)`);
            if (currentPage > 0) console.log(`  [B] Retroceder (Página anterior)`);
            console.log(`  [S] Buscar por número de capítulo exacto`);
            console.log(`  [Q] Volver a la búsqueda de shows`);
            console.log(`======================================================`);

            const choice = (await this.question("\n👉 Elige un número de la lista o una acción [M/B/S/Q]: ")).trim().toUpperCase();

            if (choice === 'Q') return null;
            
            if (choice === 'M' && endIndex < episodes.length) {
                currentPage++;
                continue;
            }
            if (choice === 'B' && currentPage > 0) {
                currentPage--;
                continue;
            }
            if (choice === 'S') {
                const searchNum = parseInt(await this.question(`🔍 Ingresa el número de capítulo exacto (1 al ${episodes.length}): `), 10);
                if (searchNum >= 1 && searchNum <= episodes.length) {
                    return episodes[searchNum - 1];
                } else {
                    console.log("❌ Número de capítulo inválido.");
                }
                continue;
            }

            const selection = parseInt(choice, 10) - 1;
            if (!isNaN(selection) && selection >= 0 && selection < pageItems.length) {
                return pageItems[selection];
            }

            console.log("❌ Opción inválida. Intenta nuevamente.");
        }
    }

    async run() {
        console.log("🌐 EXTRACTOR ESCALABLE v8.5 (Interactive Pagination)");
        const browser = await this.browserMgr.launch();

        try {
            const page = await browser.newPage();
            await page.setUserAgent(CONFIG.USER_AGENT);

            const entradaUrl = (await this.question("🔗 URL Base: ")).trim();
            const urlBase = asegurarProtocolo(entradaUrl);
            const keyword = (await this.question("📺 Búsqueda: ")).trim();

            const siteConfig = ConfigLoader.loadConfigForUrl(urlBase);
            const handler = new DynamicHandler(siteConfig);

            // 1. Buscar el show
            await page.goto(urlBase, { waitUntil: 'domcontentloaded' });
            await this.security.verifyCloudflare(page);
            
            await handler.search(page, keyword);
            await this.security.verifyCloudflare(page);

            const links = await handler.extractLinks(page);
            if (links.length === 0) throw new Error("No se encontraron resultados de búsqueda.");

            links.forEach((l, i) => console.log(`  ${i + 1}. ${l.texto}`));
            const choice = parseInt(await this.question("\n👉 Selecciona el show: ")) - 1;
            const targetShow = links[choice];

            // 2. Cargar ficha del show y extraer lista de episodios
            await page.goto(targetShow.href, { waitUntil: 'domcontentloaded' });
            await this.security.verifyCloudflare(page);

            const episodes = await handler.extractEpisodes(page, targetShow.href);

            let targetEpisode = null;
            if (episodes.length > 0) {
                targetEpisode = await this.chooseEpisodeInteractive(episodes);
                if (!targetEpisode) {
                    console.log("↩️ Regresando al menú principal...");
                    return;
                }
            } else {
                console.log("\nℹ️ No se detectaron capítulos. Procesando como contenido único.");
                targetEpisode = { texto: targetShow.texto, href: targetShow.href };
            }

            // 3. ENTRAR AL CAPÍTULO Y EXTRAER SERVIDORES
            console.log(`\n🎯 Entrando a: "${targetEpisode.texto}" -> ${targetEpisode.href}`);
            await page.goto(targetEpisode.href, { waitUntil: 'domcontentloaded' });
            await this.security.verifyCloudflare(page);

            console.log(`🔎 Escaneando reproductores de video...`);
            const servers = await handler.extractVideoServers(page);

            if (servers.length === 0) {
                console.log("❌ No se encontraron servidores de reproducción en esta página.");
            } else {
                console.log(`\n======================================================`);
                console.log(`✅ REPRODUCTORES DETECTADOS (${servers.length})`);
                console.log(`======================================================`);
                servers.forEach((srv, i) => {
                    console.log(`  ${i + 1}. [Servidor] -> ${srv.substring(0, 80)}...`);
                });
                console.log(`======================================================`);

                const resolver = await this.question("\n📺 ¿Deseas iniciar la resolución de video online (cazar el stream)? (s/n): ");
                
                if (resolver.toLowerCase() === 's') {
                    // Inicializar el cazador de streams usando la URL del capítulo como referer
                    const hunter = new StreamHunter(targetEpisode.href, this.rl);
                    let streamUrlFinal = null;

                    for (const srv of servers) {
                        console.log(`\n⌛ Analizando reproductor...`);
                        const stream = await hunter.hunt(browser, srv);
                        if (stream) {
                            streamUrlFinal = stream;
                            break; // Se detiene en cuanto captura el primer stream funcional
                        } else {
                            console.log(`❌ No se pudo capturar el flujo en este reproductor. Probando el siguiente...`);
                        }
                    }

                    if (streamUrlFinal) {
                        console.log(`\n======================================================`);
                        console.log(`✅ ¡ÉXITO! Enlace de transmisión directo obtenido:`);
                        console.log(`🔗 ${streamUrlFinal}`);
                        console.log(`======================================================`);
                        fs.appendFileSync(CONFIG.OUTPUT_FILE, `${targetShow.texto} | ${targetEpisode.texto} | ${streamUrlFinal}\n`, 'utf8');
                        console.log(`💾 Guardado en: ${CONFIG.OUTPUT_FILE}`);
                    } else {
                        console.log(`\n❌ Se analizaron todos los reproductores pero ninguno soltó el archivo de flujo (.m3u8 o .mp4).`);
                    }
                }
            }

        } catch (e) {
            console.error(`❌ Error: ${e.message}`);
        } finally {
            await this.browserMgr.close();
            this.rl.close();
        }
    }
}

new ExtractorApp().run();