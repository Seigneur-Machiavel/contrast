// NODEJS VERSION OF THE MINI LOGGER
const supportsAnsi = typeof process !== 'undefined' && process.stdout.isTTY && process.env.TERM !== 'dumb';
const isNode = typeof self === 'undefined';
let fs;
let url;
let path;
let __dirname;
let basePath = __dirname;
(async () => {
    if (!isNode) return;
    try { path = await import('path'); } catch (error) { path = window.path; }
    try { fs = await import('fs'); } catch (error) { fs = window.fs; }
    try { url = await import('url'); } catch (error) { url = window.url; }

    while (!url) { await new Promise(resolve => setTimeout(resolve, 10)); }
    const __filename = url.fileURLToPath(import.meta.url);
    basePath = path.dirname(__filename);
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
	for (let i = 0; i < 10; i++)
		if (fs && path && basePath) return true;
		else await new Promise(resolve => setTimeout(resolve, 100));
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
            fs.writeFileSync(this.filePath, JSON.stringify(this.history), 'utf-8');
        });*/
    }
    #loadAndConcatHistory() {
        if (!fs.existsSync(path.join(basePath, 'history'))) fs.mkdirSync(path.join(basePath, 'history'));
        if (!fs.existsSync(this.filePath)) return [];
        
		let fileContent;
        try {
            //const loadedHistory = JSON.parse(fs.readFileSync(this.filePath));
			fileContent = fs.readFileSync(this.filePath, 'utf-8');
            const loadedHistory = JSON.parse(fileContent);
            if (!Array.isArray(loadedHistory)) throw new Error('Invalid history format');
            return loadedHistory.concat(this.history);
        } catch (error) {
			console.error('Error while loading history:', error.stack);
			if (error.message.includes('at position ')) { // log the incorrect char
				const positionMatch = error.message.match(/at position (\d+)/);
				if (positionMatch) console.error(`The involved char is: ${fileContent[parseInt(positionMatch[1])]}`);
			}
		}
        return [];
    }
    async #saveHistoryLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.exiting) break;
            if (!this.saveRequested) continue;

            const maxHistory = this.miniLoggerConfig.maxHistory || 100;
            while (this.history.length > maxHistory) this.history.shift();
            fs.writeFileSync(this.filePath, JSON.stringify(this.history), 'utf-8');
            this.saveRequested = false;
        }
    }
    #saveLog(type, message) {
        this.history.push({ time: Date.now(), type, message });

        const maxHistory = this.miniLoggerConfig?.maxHistory || 100;
        while (this.history.length > maxHistory) this.history.shift();
        this.saveRequested = true;
    }
    log(message, callback = (m, c) => console.log(m, c)) {
        const type = callback.toString().split('console.')[1].split('(')[0].trim();
        if (isNode) this.#saveLog(type, message);
        //if (this.shouldLog && typeof callback === 'function') callback(`%c${message}`, this.color);
		if (this.shouldLog && typeof callback === 'function')
			if (supportsAnsi) callback(`${cssToAnsi(this.color)}${message}\x1b[0m`, '')
			else callback(`%c${message}`, this.color);
    }
    getReadableHistory() {
        return this.history.map(entry => {
            const date = new Date(entry.time);
            const formattedDate = date.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return `[${formattedDate}] [${entry.type}] ${entry.message}`;
        });
    }
}

// AINSI ADAPTER FOR MAXIMAL SUPPORT ------------------------------------
// Maps a subset of CSS color names + properties to ANSI codes
const ANSI_COLORS = {
    cyan: '\x1b[36m', darkseagreen: '\x1b[32m', deepskyblue: '\x1b[34m',
    white: '\x1b[37m', green: '\x1b[32m', yellow: '\x1b[33m',
    fuchsia: '\x1b[35m', red: '\x1b[31m', reset: '\x1b[0m',
};
const ANSI_STYLES = { bold: '\x1b[1m', dim: '\x1b[2m' };

// Parse "color: deepskyblue; font-weight: bold" → ANSI prefix string
function cssToAnsi(cssString) {
    if (!cssString) return '';
    let ansi = '';
    for (const part of cssString.split(';')) {
        const [prop, val] = part.split(':').map(s => s.trim());
        if (prop === 'color') ansi += ANSI_COLORS[val] ?? '';
        if (prop === 'font-weight' && val === 'bold') ansi += ANSI_STYLES.bold;
    }
    return ansi;
}