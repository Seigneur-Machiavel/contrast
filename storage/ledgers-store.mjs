// @ts-check
import fs from 'fs';
import path from 'path';
import { serializer } from '../utils/serializer.mjs';

/**

 * @typedef {import("../types/transaction.mjs").TxId} TxId */


export class LedgersStorage {
	storage;
	get logger() { return this.storage.miniLogger; }

	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.storage = storage;
		//this.#load();
	}

	reset() { // TO IMPLEMENT
		
	}
}

/** Transactions references are stored in binary format, folder architecture is optimized for fast access
 * @typedef {Object} addTxsRefsInfo
 * @property {number} highestIndex - The highest index of the transactions referenced (including temp refs)
 * @property {number} totalTxsIds - The total number of transactions referenced (excluding temp refs) */
class AddressesTxsRefsStorage {
	storage;
	get logger() { return this.storage.miniLogger; }

    codeVersion = 4;
    loaded = false;
    version = 0;
    configPath;
	txsIdsPath;
    batchSize = 1000; // number of transactions references per file
    snapHeight = -1;
	
    /** @type {Object<string, Object<string, Object<string, addTxsRefsInfo>>} */
    architecture = {}; // lvl0: { lvl1: { address: addTxsRefsInfo } }
    /** @type {Object<number, Object<string, boolean>>} */
    involedAddressesOverHeights = {}; // { height: {addresses: true} } useful for pruning
    maxInvoledHeights = 10; // max number of heights to keep in memory useful when loading snapshots
    
	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.storage = storage;
		this.configPath = path.join(storage.PATH.STORAGE, 'AddressesTxsIdsStorage_config.json');
		this.txsIdsPath = storage.PATH.TXS_IDS;
		this.#load();
	}

    #load() {
        if (!fs.existsSync(this.configPath)) {
            this.logger.log(`no config file found: ${this.configPath}`, (m, c) => console.error(m, c));
            return;
        }

        try {
            // @ts-ignore: readFileSync() on .json file returns string
            const config = JSON.parse(fs.readFileSync(this.configPath));
            this.version = config.version;
            this.snapHeight = config.snapHeight || -1;
            this.architecture = config.architecture || {};
            this.involedAddressesOverHeights = config.involedAddressesOverHeights || {};

            this.logger.log('[AddressesTxsRefsStorage] => config loaded', (m, c) => console.log(m, c));
            this.loaded = true;
        } catch (/**@type {any}*/ error) { this.logger.log(error, (m, c) => console.error(m, c)); }
    }
    #pruneInvoledAddressesOverHeights() {
        // SORT BY DESCENDING HEIGHTS -> KEEP ONLY THE UPPER HEIGHTS
        const keys = Object.keys(this.involedAddressesOverHeights).map(Number).sort((a, b) => b - a);
        for (let i = 0; i < keys.length; i++)
            if (i > this.maxInvoledHeights) delete this.involedAddressesOverHeights[keys[i]];
    }
    save(indexEnd = -1) {
        this.#pruneInvoledAddressesOverHeights();

        this.snapHeight = indexEnd;
        const config = {
            version: this.codeVersion,
            snapHeight: this.snapHeight,
            architecture: this.architecture,
            involedAddressesOverHeights: this.involedAddressesOverHeights
        };
        fs.writeFileSync(this.configPath, JSON.stringify(config));
    }
    #dirPathOfAddress(address = '') {
        const lvl0 = address.slice(0, 2);
        if (this.architecture[lvl0] === undefined) {
            this.architecture[lvl0] = {};
            if (!fs.existsSync(path.join(this.txsIdsPath, lvl0))) fs.mkdirSync(path.join(this.txsIdsPath, lvl0));
        }

        const lvl1 = address.slice(2, 3);
        if (this.architecture[lvl0][lvl1] === undefined) {
            this.architecture[lvl0][lvl1] = {};
            if (!fs.existsSync(path.join(this.txsIdsPath, lvl0, lvl1))) fs.mkdirSync(path.join(this.txsIdsPath, lvl0, lvl1));
        }

        return { lvl0, lvl1 };
    }
    #clearArchitectureIfFolderMissing(lvl0 = 'Ca', lvl1 = 'a', address = 'Caabccddeeff00112233') {
        if (!this.architecture[lvl0][lvl1][address]) return;

        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) { // Clean the architecture if the folder is missing
            delete this.architecture[lvl0][lvl1][address];
            if (Object.keys(this.architecture[lvl0][lvl1]).length === 0) delete this.architecture[lvl0][lvl1];
            if (Object.keys(this.architecture[lvl0]).length === 0) delete this.architecture[lvl0];
            return true;
        }
    }
    /** @param {number} batchNegativeIndex 0 for the temp batch, -1 for the last batch, -2 for the second to last batch, etc... */
    getTxsReferencesOfAddress(address = '', batchNegativeIndex = 0) {
        if (typeof address !== 'string' || address.length !== 20) return [];

        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address]) return [];
        if (this.#clearArchitectureIfFolderMissing(lvl0, lvl1, address)) return [];
        
        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        const existingBatch = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsIds / this.batchSize);
        const fileName = batchNegativeIndex === 0 ? 'temp.bin' : `${existingBatch + batchNegativeIndex}.bin`;
        const filePath = path.join(dirPath, fileName);
        if (!fs.existsSync(filePath)) return []; // 'temp.bin can be missing'

        const serialized = fs.readFileSync(filePath);
        return serializer.deserialize.txsIdsArray(serialized);
    }
	/** @param {string} address - The address to save txs references for @param {TxId[]} batch - The array of tx ids to save */
    async #saveNewBatchOfTxsIds(address, batch) {
        const serialized = serializer.serialize.txsIdsArray(batch);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        this.architecture[lvl0][lvl1][address].totalTxsIds += batch.length;

        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        // 0-100: 0, 100-200: 1, 200-300: 2, etc...
        const batchIndex = Math.floor(this.architecture[lvl0][lvl1][address].totalTxsIds / this.batchSize);
        const filePath = path.join(dirPath, `${batchIndex -1}.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
	/** @param {string} address - The address to save txs references for @param {TxId[]} txsIds - The array of tx ids to save */
    async #saveTempTxsIds(address, txsIds) {
        const serialized = serializer.serialize.txsIdsArray(txsIds);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        const filePath = path.join(dirPath, `temp.bin`);
        return fs.promises.writeFile(filePath, serialized); //? not sure "return" is good here
    }
	/** @param {string} address - The address to set txs references for @param {TxId[]} txsIds - The array of tx ids to set @param {number} indexStart - The starting index of the tx ids */
    async setTxsReferencesOfAddress(address = '', txsIds = [], indexStart = -1) {
        if (txsIds.length === 0) return; //TODO: ERASE ADDRESS DATA ?

        // RECORD THE ADDRESS ACTIVITY FOR EASIER PRUNING
        if (this.involedAddressesOverHeights[indexStart] === undefined)
            this.involedAddressesOverHeights[indexStart] = {};
        this.involedAddressesOverHeights[indexStart][address] = true;

        // UPDATE ARCHITECTURE INFO
        const highestIndex = Number(txsIds[txsIds.length - 1].split(':')[0]);
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address])
            this.architecture[lvl0][lvl1][address] = { highestIndex, totalTxsIds: 0 };

        // SAVE BATCH IF TOO BIG
        let promises = [];
        while (txsIds.length > this.batchSize)
            promises.push(this.#saveNewBatchOfTxsIds(address, txsIds.splice(0, this.batchSize)));
        promises.push(this.#saveTempTxsIds(address, txsIds)); // SAVE TEMP TXS IDS

        if (promises.length > 0) await Promise.allSettled(promises);
        this.architecture[lvl0][lvl1][address].highestIndex = highestIndex;
    }
	/** @param {TxId[]} batch @param {number} height */
    #pruneBatchRefsUpperThan(batch, height) {
        return batch.filter(txsRef => Number(txsRef.split(':')[0]) <= height);
    }
    #pruneAddressRefsUpperThan(address = '', height = 0) {
        if (typeof address !== 'string' || address.length !== 20) return false;
        
        const { lvl0, lvl1 } = this.#dirPathOfAddress(address);
        if (!this.architecture[lvl0][lvl1][address]) return false;
        if (this.#clearArchitectureIfFolderMissing(lvl0, lvl1, address)) return false;

        const dirPath = path.join(this.txsIdsPath, lvl0, lvl1, address);
        const numberOfFiles = fs.readdirSync(dirPath).length;
        if (numberOfFiles === 0) return false; // no files to prune, should not happen because empty folders are deleted

        const existingBatch = Math.floor(numberOfFiles / this.batchSize);
        let batchNegativeIndex = numberOfFiles -1;
        
        while (true) {
            const fileName = batchNegativeIndex === 0 ? 'temp.bin' : `${existingBatch + batchNegativeIndex}.bin`;
            const filePath = path.join(dirPath, fileName);
            const exists = fs.existsSync(filePath);
            if (exists) {
                const serialized = fs.readFileSync(filePath);
                const txsIds = serializer.deserialize.txsIdsArray(serialized);
                const remainingBatchTxsIds = this.#pruneBatchRefsUpperThan(txsIds, height);
                const removedTxs = txsIds.length - remainingBatchTxsIds.length;

                if (batchNegativeIndex !== 0 && removedTxs === 0) break; // no more files to check
                if (removedTxs !== 0) this.architecture[lvl0][lvl1][address].totalTxsIds -= removedTxs;
                
                if (remainingBatchTxsIds.length === 0) fs.rmSync(filePath); // delete the file if empty
                else fs.writeFileSync(filePath, serializer.serialize.txsIdsArray(remainingBatchTxsIds));
            } else if (batchNegativeIndex !== 0) break; // no more files to check

            batchNegativeIndex--;
        }

        // if the address is empty, we can delete it from the architecture
        const totalTxsIds = this.architecture[lvl0][lvl1][address].totalTxsIds;
        if (!totalTxsIds || totalTxsIds <= 0) {
            fs.rmSync(dirPath, { recursive: true }); // delete the folder
            delete this.architecture[lvl0][lvl1][address];
            if (Object.keys(this.architecture[lvl0][lvl1]).length === 0) delete this.architecture[lvl0][lvl1];
            if (Object.keys(this.architecture[lvl0]).length === 0) delete this.architecture[lvl0];
        }
    }
    /** Pruning to use while loading a snapshot */
    pruneAllUpperThan(height = 0) {
        const keys = Object.keys(this.involedAddressesOverHeights).map(Number).filter(h => h > height);
        for (let i = 0; i < keys.length; i++) {
            for (const address in this.involedAddressesOverHeights[keys[i]])
                this.#pruneAddressRefsUpperThan(address, keys[i]);

            delete this.involedAddressesOverHeights[keys[i]];
        }

        this.snapHeight = Math.min(this.snapHeight, height);
        this.logger.log(`Pruned all transactions references upper than #${height}`, (m, c) => console.info(m, c));
    }
    reset(reason = 'na') {
        if (fs.existsSync(this.txsIdsPath)) fs.rmSync(this.txsIdsPath, { recursive: true });
        if (fs.existsSync(this.configPath)) fs.rmSync(this.configPath);
        
        fs.mkdirSync(this.txsIdsPath);
        this.snapHeight = -1;
        this.architecture = {};
        this.involedAddressesOverHeights = {};
        this.logger.log(`AddressesTxsRefsStorage reset: ${reason}`, (m, c) => console.info(m, c));
    }
}