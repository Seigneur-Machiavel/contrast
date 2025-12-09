// ELECTRON VERSION OF THE MINI LOGGER

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
let basePath = __dirname;
if (app.isPackaged) { basePath = path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), "miniLogger"); }

const HistoricalLog = (type = 'log', message = 'toto') => {
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
 * @property {{ [key: string]: boolean }} activeCategories */
const MiniLoggerConfig = () => {
    return {
        maxHistory: 100,
        allActive: false,
        activeCategories: { global: true },
		colors: { }
    }
}

/** @returns {MiniLoggerConfig} */
function loadDefaultConfig() {
    const defaultConfigPath = path.join(basePath, 'mini-logger-config.json');
    if (!fs.existsSync(defaultConfigPath)) return MiniLoggerConfig();

    const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath));
    return defaultConfig;
}
/** @returns {MiniLoggerConfig} */
function loadMergedConfig() {
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

class MiniLogger {
	color;
	shouldLog;

    /** @param {MiniLoggerConfig} miniLoggerConfig */
    constructor(category = 'global', miniLoggerConfig) {
        this.category = category;
        this.filePath = path.join(basePath, 'history', `${this.category}.json`);
        this.history = this.#loadHistory();
        /** @type {MiniLoggerConfig} */
        this.miniLoggerConfig = miniLoggerConfig || loadMergedConfig();
        this.shouldLog = this.#isCategoryActive();
		this.color = this.miniLoggerConfig.colors[this.category];
        if (!fs.existsSync(path.join(basePath, 'history'))) fs.mkdirSync(path.join(basePath, 'history'));
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
	log(message, callback = (m, c) => console.log(m, c)) {
        const type = callback.toString().split('console.')[1].split('(')[0].trim();
        this.#saveLog(type, message);
        if (this.shouldLog && typeof callback === 'function') callback(`%c${message}`, this.color);
    }
}

if (typeof module !== 'undefined') module.exports = { MiniLogger, loadMergedConfig, loadDefaultConfig };
else exports = { MiniLogger, loadMergedConfig, loadDefaultConfig };