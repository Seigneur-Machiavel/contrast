import fs from 'fs';
import path from 'path';
import url from 'url';

const __filename = url.fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked');
const parentFolder = path.dirname(__filename);
const basePath = path.join(path.dirname(parentFolder), 'miniLogger');
const historyPath = path.join(basePath, 'history');

/**
 * @typedef HistoricalLine
 * @property {number} time
 * @property {string} type
 * @property {string} message
 */

export class MiniLoggerReader {
    static getAllHistoricals(category_ = 'all') {
        /** @type {Object<string, HistoricalLine[]>} */
        const historicals = {};
        const files = fs.readdirSync(historyPath);
        for (const file of files) {
            // example: blockchain-history.json
            const category = file.includes('-') ? file.split('-')[0] : file.split('.')[0];
            if (category_ !== 'all' && category_ !== category) continue;

            const filePath = path.join(historyPath, file);
            const content = fs.readFileSync(filePath);
            historicals[category] = JSON.parse(content);
        }

        return historicals;
    }
    /** @param {Object<string, HistoricalLine[]>} historicals */
    static mergeHistoricals(historicals) {
        const lines = [];
        while (true) {
            let historicalLineTimestamp = 0;
            let historicalLineToAddCategory;
            for (const category in historicals) {
                if (historicals[category].length === 0) continue;
                const lastLineTime = historicals[category][historicals[category].length - 1].time
                if (historicalLineTimestamp && lastLineTime < historicalLineTimestamp) continue;
                historicalLineTimestamp = lastLineTime;
                historicalLineToAddCategory = category;
            }
            if (!historicalLineToAddCategory) break;

            const historicalLineToAdd = historicals[historicalLineToAddCategory].pop();
            const formatedCategory = historicalLineToAddCategory.padStart(16, ' ');
            const formatedType = historicalLineToAdd.type.padEnd(8, ' ');
            lines.push(`${new Date(historicalLineToAdd.time).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} ${formatedCategory} ${formatedType} => ${historicalLineToAdd.message}`);
        }
        
        return lines;
    }
}