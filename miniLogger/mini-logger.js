if (false) { const miniLoggerConfig = require('./mini-logger-config.js'); }
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

class MiniLogger {
    /** @param {miniLoggerConfig} miniLoggerConfig */
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
        fs.writeFileSync('./history.json', JSON.stringify(this.history));
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
}

module.exports = MiniLogger;