const fs = require('fs');

const HistoricalLog = (label = 'global', message = 'toto') => {
    return {
        time: () => {
            const date = new Date();
            return `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
        },
        label,
        message
    }
}

const MiniLoggerConfig = () => {
    return {
        maxHistory: 100,
        allActive: false,
        activeLabels: { global: true }
    }
}

/** @returns {MiniLoggerConfig} */
function loadDefaultConfig() {
    const defaultConfig = JSON.parse(fs.readFileSync('./miniLogger/mini-logger-config.json'));
    return defaultConfig;
}
/** @returns {MiniLoggerConfig} */
function loadMergedConfig() {
    const defaultConfig = loadDefaultConfig();
    if (!fs.existsSync('./miniLogger/mini-logger-config-custom.json')) return defaultConfig;

    const customConfig = JSON.parse(fs.readFileSync('./miniLogger/mini-logger-config-custom.json'));
    const config = {
        maxHistory: customConfig.maxHistory === undefined ? defaultConfig.maxHistory : customConfig.maxHistory,
        allActive: customConfig.allActive === undefined ? defaultConfig.allActive : customConfig.allActive,
        activeLabels: defaultConfig.activeLabels
    };

    for (const key in defaultConfig.activeLabels) {
        if (customConfig.activeLabels === undefined) break;
        if (customConfig.activeLabels[key] === undefined) continue;
        config.activeLabels[key] = customConfig.activeLabels[key];
    }

    return config;
}

class MiniLogger {
    /** @param {MiniLoggerConfig} miniLoggerConfig */
    constructor(miniLoggerConfig) {
        this.maxHistory = miniLoggerConfig.maxHistory || 100;
        this.history = this.#loadHistory();
        this.allActive = miniLoggerConfig.allActive || false;
        this.activeLabels = miniLoggerConfig.activeLabels || { global: true };
    }
    initFromConfig(miniLoggerConfig) {
        this.maxHistory = miniLoggerConfig.maxHistory || 100;
        this.allActive = miniLoggerConfig.allActive || false;
        this.activeLabels = miniLoggerConfig.activeLabels || { global: true };
    }
    #loadHistory() {
        if (!fs.existsSync('./history.json')) { return []; }
        
        try {
            const history = JSON.parse(fs.readFileSync('./history.json'));
            return history;
        } catch (error) {
            console.error('Error while loading history:', error);
            return [];
        }
    }
    #saveHistory() {
        fs.writeFileSync('./miniLogger/history.json', JSON.stringify(this.history));
    }
    #saveLog(label, message) {
        const historicalLog = HistoricalLog(label, message);
        this.history.push(historicalLog);

        if (this.history.length > this.maxHistory) { this.history.shift(); }

        this.#saveHistory();
    }
    log(label = 'global', message) {
        this.#saveLog(label, message);
        if (this.activeLabels[label] !== true && this.allActive !== true) return;

        console.log(`${message}`);
    }
    info(label = 'global', message) {
        this.#saveLog(label, message);
        if (this.activeLabels[label] !== true && this.allActive !== true) return;

        console.info(`${message}`);
    }
    debug(label = 'global', message) {
        this.#saveLog(label, message);
        if (this.activeLabels[label] !== true && this.allActive !== true) return;

        console.debug(`${message}`);
    }
    error(label = 'global', message) {
        this.#saveLog(label, message);
        if (this.activeLabels[label] !== true && this.allActive !== true) return;

        console.error(`${message}`);
    }
    warn(label = 'global', message) {
        this.#saveLog(label, message);
        if (this.activeLabels[label] !== true && this.allActive !== true) return;

        console.warn(`${message}`);
    }
}

module.exports = { MiniLogger, loadDefaultConfig, loadMergedConfig };