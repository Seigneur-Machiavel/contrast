// @ts-ignore
// NODEJS VERSION OF THE MINI LOGGER

const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
let fs;
let path;
let __dirname;
let basePath = __dirname;
(async () => {
    if (!isNode) return;
    try { path = await import('path'); } catch (error) { path = window.path; }
    try { fs = await import('fs'); } catch (error) { fs = window.fs; }
    let url;
    try { url = await import('url'); } catch (error) { url = window.url; }

    while (!url) { await new Promise(resolve => setTimeout(resolve, 10)); }
    const __filename = url.fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked');
    const parentFolder = path.dirname(__filename);
    basePath = path.join(path.dirname(parentFolder), 'miniLogger');
})();
/**
 * @typedef MiniLoggerConfig
 * @property {number} maxHistory
 * @property {boolean} allActive
 * @property {{ [key: string]: boolean }} activeCategories */
class MiniLoggerConfig {
	maxHistory = 100;
	allActive = false;
	activeCategories = { global: true };
	colors = { };
}
async function loadedImports() {
	for (let i = 0; i < 10; i++) {
		if (fs && path && basePath) return true;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

/** @returns {MiniLoggerConfig} */
export function loadDefaultConfig() {
    const defaultConfigPath = path.join(basePath, 'mini-logger-config.json');
    if (!fs.existsSync(defaultConfigPath)) return MiniLoggerConfig();

    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath));
    return defaultConfig;
}
/** @returns {MiniLoggerConfig} */
export function loadMergedConfig() {
    const defaultConfig = loadDefaultConfig();
    const customConfigPath = path.join(basePath, 'mini-logger-config-custom.json');
    if (!fs.existsSync(customConfigPath)) return defaultConfig;

    const customConfig = JSON.parse(fs.readFileSync(customConfigPath));
    const config = {
        maxHistory: customConfig.maxHistory === undefined ? defaultConfig.maxHistory : customConfig.maxHistory,
        allActive: customConfig.allActive === undefined ? defaultConfig.allActive : customConfig.allActive,
        activeCategories: defaultConfig.activeCategories,
		colors: defaultConfig.colors
    };

    for (const key in defaultConfig.activeCategories) {
        if (customConfig.activeCategories === undefined) break;
        if (customConfig.activeCategories[key] === undefined) continue;
        config.activeCategories[key] = customConfig.activeCategories[key];
    }
	for (const key in defaultConfig.colors) {
		if (customConfig.colors === undefined) break;
		if (customConfig.colors[key] === undefined) continue;
		config.colors[key] = customConfig.colors[key];
	}

    return config;
}
/**
 * @typedef {Object} HistoryEntry
 * @property {number} time - Timestamp of the log entry
 * @property {string} type - Type of the log entry (e.g., 'log', 'error', 'warn')
 * @property {string} message - The log message */
export class MiniLogger {
    /** @type {HistoryEntry[]} */		history = [];
	/** @type {MiniLoggerConfig} */	miniLoggerConfig;
	color;
    filePath;
    exiting = false;
	shouldLog = true;
    saveRequested = false;

    constructor(category = 'global') {
        this.category = category;
        this.#init();
    }
    async #init() {
        if (!isNode) return;
		if (!(await loadedImports())) return;

        this.filePath = path.join(basePath, 'history', `${this.category}-history.json`);
        this.history = this.#loadAndConcatHistory();
        this.miniLoggerConfig = loadMergedConfig();

        const allActive = this.miniLoggerConfig.allActive;
        const categoryActive = this.miniLoggerConfig.activeCategories[this.category];
        this.shouldLog = allActive || (categoryActive === undefined ? true : categoryActive);
		this.color = this.miniLoggerConfig.colors[this.category];
        this.#saveHistoryLoop();

        // nodejs onclose -> save history
        //! Possible EventEmitter memory leak detected. 11 exit listeners ...
        /*process.on('exit', () => {
            this.exiting = true;
            fs.writeFileSync(this.filePath, JSON.stringify(this.history));
        });*/
    }
    #loadAndConcatHistory() {
        if (!fs.existsSync(path.join(basePath, 'history'))) { fs.mkdirSync(path.join(basePath, 'history')); };
        if (!fs.existsSync(this.filePath)) return [];
        
        try {
            const loadedHistory = JSON.parse(fs.readFileSync(this.filePath));
            if (!Array.isArray(loadedHistory)) throw new Error('Invalid history format');
            return loadedHistory.concat(this.history);
        } catch (error) { console.error('Error while loading history:', error) }
        return [];
    }
    async #saveHistoryLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.exiting) break;
            if (!this.saveRequested) continue;

            const maxHistory = this.miniLoggerConfig.maxHistory || 100;
            while (this.history.length > maxHistory) this.history.shift();
            fs.writeFileSync(this.filePath, JSON.stringify(this.history));
            this.saveRequested = false;
        }
    }
    #saveLog(type, message) {
        this.history.push({ time: Date.now(), type, message });

        const maxHistory = this.miniLoggerConfig.maxHistory || 100;
        while (this.history.length > maxHistory) this.history.shift();
        this.saveRequested = true;
    }
    log(message, callback = (m, c) => console.log(m, c)) {
        const type = callback.toString().split('console.')[1].split('(')[0].trim();
        if (isNode) this.#saveLog(type, message);
        if (this.shouldLog && typeof callback === 'function') callback(`%c${message}`, this.color);
    }
    getReadableHistory() {
        return this.history.map(entry => {
            const date = new Date(entry.time);
            const formattedDate = date.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return `[${formattedDate}] [${entry.type}] ${entry.message}`;
        });
    }
}