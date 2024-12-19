import fs from 'fs';
import path from 'path';
const __dirname = path.resolve('miniLogger');

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

/** @returns {MiniLoggerConfig} */
export function loadDefaultConfig() {
    const defaultConfigPath = path.join(__dirname, 'mini-logger-config.json');
    if (!fs.existsSync(defaultConfigPath)) return MiniLoggerConfig();

    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath));
    return defaultConfig;
}
/** @returns {MiniLoggerConfig} */
export function loadMergedConfig() {
    const defaultConfig = loadDefaultConfig();
    const customConfigPath = path.join(__dirname, 'mini-logger-config-custom.json');
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
    /** @param {MiniLoggerConfig} miniLoggerConfig */
    constructor(category = 'global', miniLoggerConfig) {
        this.category = category;
        this.filePath = path.join(__dirname, 'history', `${this.category}.json`);
        this.history = this.#loadHistory();
        /** @type {MiniLoggerConfig} */
        this.miniLoggerConfig = miniLoggerConfig || loadMergedConfig();
        this.shouldLog = this.#isCategoryActive();
        if (!fs.existsSync(path.join(__dirname, 'history'))) { fs.mkdirSync(path.join(__dirname, 'history')); }
    }

    #isCategoryActive() {
        const allActive = this.miniLoggerConfig.allActive;
        const categoryActive = this.miniLoggerConfig.activeCategories[this.category];
        return allActive || categoryActive;
    }
    #loadHistory() {
        if (!fs.existsSync(this.filePath)) { return []; }
        
        try {
            const history = JSON.parse(fs.readFileSync(this.filePath));
            return history;
        } catch (error) {
            console.error('Error while loading history:', error);
            return [];
        }
    }
    #saveHistory() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.history));
    }
    #saveLog(type, message) {
        const historicalLog = HistoricalLog(type, message);
        this.history.push(historicalLog);

        if (this.history.length > this.miniLoggerConfig.maxHistory) { this.history.shift(); }

        this.#saveHistory();
    }
    log(message, callback = (m) => { console.log(m); }) {
        const type = callback.toString().split('console.')[1].split('(')[0].trim();
        this.#saveLog(type, message);

        if (this.shouldLog && typeof callback === 'function') { callback(message); }
    }
}