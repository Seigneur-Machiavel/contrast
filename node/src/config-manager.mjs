import fs from 'fs';
import path from 'path';

export class ConfigManager {
    /** @param {string} configPath - The path to the configuration file.*/
    constructor(configPath) {
        if (!configPath) throw new Error('Configuration file path must be provided.');
        this.configPath = path.resolve(configPath);
        this.config = {
            bootstrapNodes: ['/dns4/pinkparrot.science/tcp/27260', '/dns4/pinkparrot.observer/tcp/27261', '/dns4/pariah.monster/tcp/27260'],
            isInitNode: false
        };
    }

    init() {
        if (!fs.existsSync(this.configPath)) {
            console.warn(`Config file not found at ${this.configPath}. Creating a default config.`);
            if (!this.saveConfig()) throw new Error('Failed to save default config.');
        }

        this.config = this.loadConfig();
    }

    loadConfig() {
        try {
            const data = fs.readFileSync(this.configPath, 'utf-8');
            const parsed = JSON.parse(data);

            if (!Array.isArray(parsed.bootstrapNodes) || !parsed.bootstrapNodes.every(node => typeof node === 'string'))
                throw new Error('Invalid format for "bootstrapNodes". It should be an array of strings.');
            if (typeof parsed.isInitNode !== 'boolean')
                throw new Error('Invalid format for "isInitNode". It should be a boolean.');

            console.log('Configuration loaded successfully.');
            return parsed;
        } catch (err) {
            throw new Error(`Failed to load config: ${err.message}`);
        }
    }

    saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
            console.log('Configuration saved successfully.');
            return true;
        } catch (err) { throw new Error(`Failed to save config: ${err.message}`); return false; }
    }

    /** @returns {string[]} Array of bootstrap node strings.*/
    getBootstrapNodes = () => this.config.bootstrapNodes;

    /** @returns {boolean} The isInitNode value.*/
    getIsInitNode = () => this.config.isInitNode;
}

export default ConfigManager;
