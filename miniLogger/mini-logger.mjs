const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

let fs;
let path;
let __dirname;
let basePath = __dirname;
(async () => {
    if (!isNode) { return; }

    path = await import('path');
    fs = await import('fs');
    const url = await import('url');
    //basePath = path.resolve('miniLogger');
    //const { app } = await electron;
    //basePath = path.resolve('miniLogger');

    const __filename = url.fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked');
    const parentFolder = path.dirname(__filename);
    basePath = path.join(path.dirname(parentFolder), 'miniLogger');
    //basePath = parentFolder;
})();

const HistoricalLog = (type = 'log', message = 'toto') => {
    /*
    const date = new Date();
    return `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
    */
    return {
        time: Date.now(),
        type: type,
        message
    }
}

/**
 * @typedef MiniLoggerConfig
 * @property {number} maxHistory
 * @property {boolean} allActive
 * @property {{ [key: string]: boolean }} activeCategories
 */
const MiniLoggerConfig = () => {
    return {
        maxHistory: 100,
        allActive: false,
        activeCategories: { global: true }
    }
}

async function loadedImports() {
    while (!fs || !path || !basePath) { await new Promise(resolve => setTimeout(resolve, 100)); }
}

/** @returns {MiniLoggerConfig} */
export async function loadDefaultConfig() {
    await loadedImports();

    const defaultConfigPath = path.join(basePath, 'mini-logger-config.json');
    if (!fs.existsSync(defaultConfigPath)) return MiniLoggerConfig();

    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath));
    return defaultConfig;
}
/** @returns {MiniLoggerConfig} */
export async function loadMergedConfig() {
    await loadedImports();

    const defaultConfig = await loadDefaultConfig();
    const customConfigPath = path.join(basePath, 'mini-logger-config-custom.json');
    if (!fs.existsSync(customConfigPath)) return defaultConfig;

    const customConfig = JSON.parse(fs.readFileSync(customConfigPath));
    const config = {
        maxHistory: customConfig.maxHistory === undefined ? defaultConfig.maxHistory : customConfig.maxHistory,
        allActive: customConfig.allActive === undefined ? defaultConfig.allActive : customConfig.allActive,
        activeCategories: defaultConfig.activeCategories
    };

    for (const key in defaultConfig.activeCategories) {
        if (customConfig.activeCategories === undefined) break;
        if (customConfig.activeCategories[key] === undefined) continue;
        config.activeCategories[key] = customConfig.activeCategories[key];
    }

    return config;
}

export class MiniLogger {
    filePath;
    saveRequested = false;
    /** @param {MiniLoggerConfig} miniLoggerConfig */
    constructor(category = 'global', miniLoggerConfig) {
        this.category = category;
        this.history = [];
        /** @type {MiniLoggerConfig} */
        this.miniLoggerConfig = miniLoggerConfig || {};
        this.shouldLog = true;

        this.#init();
    }
    async #init() {
        if (!isNode) { return; }

        await loadedImports();

        this.filePath = path.join(basePath, 'history', `${this.category}-history.json`);
        this.history = await this.#loadAndConcatHistory();

        this.miniLoggerConfig = await loadMergedConfig();

        const allActive = this.miniLoggerConfig.allActive;
        const categoryActive = this.miniLoggerConfig.activeCategories[this.category];
        this.shouldLog = allActive || (categoryActive === undefined ? true : categoryActive);

        this.#saveHistoryLoop();
    }
    async #loadAndConcatHistory() {
        if (!fs.existsSync(path.join(basePath, 'history'))) { fs.mkdirSync(path.join(basePath, 'history')); };
        if (!fs.existsSync(this.filePath)) { return []; }
        
        try {
            const loadedHistory = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (!Array.isArray(loadedHistory)) { return []; }

            return loadedHistory.concat(this.history);
        } catch (error) {
            console.error('Error while loading history:', error);
            return [];
        }
    }
    async #saveHistoryLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!this.saveRequested) { continue; }

            fs.writeFileSync(this.filePath, JSON.stringify(this.history), 'utf8');
            this.saveRequested = false;
        }
    }
    #saveLog(type, message) {
        const historicalLog = HistoricalLog(type, message);
        this.history.push(historicalLog);

        const maxHistory = this.miniLoggerConfig.maxHistory || 100;
        if (this.history.length > maxHistory) { this.history.shift(); }

        this.saveRequested = true;
    }
    log(message, callback = (m) => { console.log(m); }) {
        const type = callback.toString().split('console.')[1].split('(')[0].trim();
        if (isNode) { this.#saveLog(type, message); }

        if (this.shouldLog && typeof callback === 'function') { callback(message); }
    }
}