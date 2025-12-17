// @ts-check
// A primitive way to store the blockchain data and wallet data etc...
// As usual, use Ctrl + k, Ctrl + 0 to fold all blocks of code
import fs from 'fs';
import url from 'url';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import HiveP2P from "hive-p2p";
import { serializer } from './serializer.mjs';
import { UTXO } from '../types/transaction.mjs';
import { BlockUtils } from '../node/src/block.mjs';
import { HashFunctions } from '../node/src/conCrypto.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';
import { BLOCKCHAIN_SETTINGS } from './blockchain-settings.mjs';

/**
 * @typedef {import("hive-p2p").Converter} Converter
 * @typedef {import("../types/block.mjs").BlockInfo} BlockInfo
 * @typedef {import("../types/transaction.mjs").TxId} TxId
 * @typedef {import("../types/transaction.mjs").VoutId} VoutId
 * @typedef {import("../types/transaction.mjs").TxAnchor} TxAnchor
 * @typedef {import("../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
*/

// GLOBALS VARS
/** @type {MiniLogger} */
const storageMiniLogger = new MiniLogger('storage');
const BLOCK_PER_DIRECTORY = 1000;

/** @param {number} fd - file descriptor @param {number} start - start position @param {number} totalBytes - number of bytes to read */
function fsReadBytesSync(fd, start, totalBytes) {
	const serialized = Buffer.allocUnsafe(totalBytes);
	fs.readSync(fd, serialized, 0, totalBytes, start);
	return serialized;
}

/** THE COMMON CLASS TO HANDLE THE STORAGE PATHS */
class StorageRoot {
	/** The local identifier used as subFolder */	localIdentifier;
	/** Is running in electron environment */		  isElectronEnv;
	/** Root folder path @type {string} */				 rootFolder;
	/** Paths used for storage */							   PATH;

	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = null) {
		this.localIdentifier = masterHex ? this.#getLocalIdentifier(masterHex) : null;
		const filePath = url.fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked');
		this.isElectronEnv = filePath.includes('app.asar');

		this.rootFolder = !this.isElectronEnv ? path.dirname(path.dirname(filePath))
			: path.dirname(path.dirname(path.dirname(path.dirname(filePath))))
	
		const basePath = !this.localIdentifier ? path.join(path.dirname(this.rootFolder), 'contrast-storage')
			: path.join(path.dirname(this.rootFolder), 'contrast-storage', this.localIdentifier);
	
		this.PATH = {
			/** path to the storage.mjs file */
			BASE_FILE: filePath,
			/** path to the storage folder (out of the root directory) */
			STORAGE: basePath,
			TRASH: path.join(basePath, 'trash'),
			TXS_IDS: path.join(basePath, 'addresses-txs-ids'),
			BLOCKCHAIN: path.join(basePath, 'blockchain'),
			TEST_STORAGE: path.join(basePath, 'test')
		};
		this.#init();
	}
	#init() {
		// create the contrast-storage folder if it doesn't exist, and any of subfolder
		// @ts-ignore
		if (this.isElectronEnv) delete this.PATH.TEST_STORAGE;
		if (!fs.existsSync(path.join(path.dirname(this.rootFolder), 'contrast-storage')))
			fs.mkdirSync(path.join(path.dirname(this.rootFolder), 'contrast-storage'));
		for (const dirPath of Object.values(this.PATH))
			if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
	}
	#getLocalIdentifier(masterHex = 'ff') {
		const separatorParts = 'local-identifier-separator'.split('');
		const keyParts = masterHex.split('');
		const input = [];
		for (let i = 0; i < keyParts.length; i++) {
			input.push(keyParts[i]);
			input.push(separatorParts[i % separatorParts.length]);
		}
		return HashFunctions.xxHash32(input.join(''));
	}
	clear(passHash = true, nodeSettings = true) {
		const dirPaths = [
			this.PATH.BLOCKCHAIN,
			this.PATH.TRASH,
			this.PATH.TXS_IDS,
			path.join(this.PATH.STORAGE, 'ACTIVE_CHECKPOINT'),
			this.PATH.TEST_STORAGE
		];
		const filePaths = [ path.join(this.PATH.STORAGE, 'AddressesTxsIdsStorage_config.json') ];
		if (passHash) filePaths.push(path.join(this.PATH.STORAGE, 'passHash.bin'));
		if (nodeSettings) filePaths.push(path.join(this.PATH.STORAGE, 'nodeSetting.bin'));

		for (const dirPath of dirPaths)
			if (!fs.existsSync(dirPath)) continue;
			else { fs.rmSync(dirPath, { recursive: true }); console.log(`${dirPath} removed.`) }

		for (const filePath of filePaths)
			if (!fs.existsSync(filePath)) continue;
			else { fs.unlinkSync(filePath); console.log(`${filePath} removed.`) }

		this.#init();
	}
}

class BinaryHandler {
    fd; cursor;
	get size() { return this.cursor; }
	
	/** @param {string} filePath @param {boolean} [createIfMissing] Default: true */
    constructor(filePath, createIfMissing = true) {
    	if (!fs.existsSync(filePath))
			if (createIfMissing) fs.writeFileSync(filePath, Buffer.alloc(0));
			else throw new Error(`File not found: ${filePath}`);

		this.fd = fs.openSync(filePath, 'r+');
        const stats = fs.fstatSync(this.fd);
        this.cursor = stats.size; // Start at end
    }

    /** @param {Uint8Array} data @param {number} [position] Default: this.cursor (append) */
    write(data, position = this.cursor) {
        fs.writeSync(this.fd, data, 0, data.length, position);
        if (position === this.cursor) this.cursor += data.length;
    } 
	/** @param {number} position @param {number} length */
    read(position, length) {
        const buffer = Buffer.allocUnsafe(length);
        fs.readSync(this.fd, buffer, 0, length, position);
        return buffer; // Don't move cursor for reads
    }
	/** Truncate the file to a new size @param {number} newSize */
    truncate(newSize) {
		if (newSize < 0) throw new Error('Cannot truncate file below size 0');
        fs.ftruncateSync(this.fd, newSize);
        this.cursor = newSize;
    }
	/** Reduce the file size by removing a number of bytes from the end @param {number} bytesToRemove */
	shrink(bytesToRemove) {
		const newSize = this.cursor - bytesToRemove;
		if (newSize < 0) throw new Error('Cannot shrink file below size 0');
		fs.ftruncateSync(this.fd, newSize);
		this.cursor = newSize;
	}
}

/** The main Storage */
export class ContrastStorage extends StorageRoot {
	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = null) { super(masterHex); }

	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
	saveBinary(fileName, serializedData, directoryPath) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!fs.existsSync(d)) fs.mkdirSync(d);
			
			fs.writeFileSync(path.join(d, `${fileName}.bin`), serializedData);
		} catch (/**@type {any}*/ error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
		return true;
	}
	/** @param {string} fileName @param {string} directoryPath @returns {Uint8Array|boolean} */
	loadBinary(fileName, directoryPath) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, `${fileName}.bin`);
		try { return fs.readFileSync(filePath) } // work as Uint8Array
		catch (/**@type {any}*/ error) {
			if (error.code === 'ENOENT') storageMiniLogger.log(`File not found: ${filePath}`, (m, c) => console.info(m, c));
			else storageMiniLogger.log(error.stack, (m, c) => console.info(m, c));
		}
		return false;
	}
	/** @param {string} fileName @param {Uint8Array} serializedData @param {string} directoryPath */
	async saveBinaryAsync(fileName, serializedData, directoryPath) {
		try {
			const d = directoryPath || this.PATH.STORAGE;
			if (!fs.existsSync(d)) fs.mkdirSync(d);
			await fs.promises.writeFile(path.join(d, `${fileName}.bin`), serializedData);
		} catch (/**@type {any}*/ error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false; }
	}
	/** @param {string} fileName @param {string} directoryPath @returns {Promise<Uint8Array|boolean>} */
	async loadBinaryAsync(fileName, directoryPath) {
		const filePath = path.join(directoryPath || this.PATH.STORAGE, `${fileName}.bin`);
		try {
			const buffer = await fs.promises.readFile(filePath);
			return buffer;
		} catch (/**@type {any}*/ error) {
			if (error.code === 'ENOENT') storageMiniLogger.log(`File not found: ${filePath}`, (m, c) => console.info(m, c));
			else storageMiniLogger.log(error.stack, (m, c) => console.info(m, c));
		}
		return false;
	}
	isFileExist(fileNameWithExtension = 'toto.bin', directoryPath = this.PATH.STORAGE) {
		const filePath = path.join(directoryPath, fileNameWithExtension);
		return fs.existsSync(filePath);
	}
	/** @param {string} fileName - The name of the file @param {any} data - The data to save */
	saveJSON(fileName, data) {
		try {
			const filePath = path.join(this.PATH.STORAGE, `${fileName}.json`);
			if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath));
			fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
		} catch (/**@type {any}*/ error) { storageMiniLogger.log(error.stack, (m, c) => console.info(m, c)); return false }
	}
	/** @param {string} fileName - The name of the file @returns {any|boolean} */
	loadJSON(fileName) {
		// @ts-ignore: readFileSync() on .json file returns string
		try { return JSON.parse(fs.readFileSync(path.join(this.PATH.STORAGE, `${fileName}.json`))) }
		catch (/**@type {any}*/ error) { return false }
	}
	/** @param {string} fileNameWithExtension - ex: 'toto.bin' @param {string} [directoryPath] - default is this.PATH.STORAGE */
	deleteFile(fileNameWithExtension = 'toto.bin', directoryPath = this.PATH.STORAGE) {
		const filePath = path.join(directoryPath, fileNameWithExtension);
		if (fs.existsSync(filePath)) fs.rmSync(filePath);
	}
	dumpTrashFolder() {
		if (fs.existsSync(this.PATH.TRASH)) fs.rmSync(this.PATH.TRASH, { recursive: true });
		fs.mkdirSync(this.PATH.TRASH);
	}
}

/** Transactions references are stored in binary format, folder architecture is optimized for fast access
 * @typedef {Object} addTxsRefsInfo
 * @property {number} highestIndex - The highest index of the transactions referenced (including temp refs)
 * @property {number} totalTxsIds - The total number of transactions referenced (excluding temp refs) */
export class AddressesTxsRefsStorage {
    codeVersion = 4;
    version = 0;
    loaded = false;
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
		this.configPath = path.join(storage.PATH.STORAGE, 'AddressesTxsIdsStorage_config.json');
		this.txsIdsPath = storage.PATH.TXS_IDS;
		this.#load();
	}

    #load() {
        if (!fs.existsSync(this.configPath)) {
            storageMiniLogger.log(`no config file found: ${this.configPath}`, (m, c) => console.error(m, c));
            return;
        }

        try {
            // @ts-ignore: readFileSync() on .json file returns string
            const config = JSON.parse(fs.readFileSync(this.configPath));
            this.version = config.version;
            this.snapHeight = config.snapHeight || -1;
            this.architecture = config.architecture || {};
            this.involedAddressesOverHeights = config.involedAddressesOverHeights || {};

            storageMiniLogger.log('[AddressesTxsRefsStorage] => config loaded', (m, c) => console.log(m, c));
            this.loaded = true;
        } catch (/**@type {any}*/ error) { storageMiniLogger.log(error, (m, c) => console.error(m, c)); }
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
        storageMiniLogger.log(`Pruned all transactions references upper than #${height}`, (m, c) => console.info(m, c));
    }
    reset(reason = 'na') {
        if (fs.existsSync(this.txsIdsPath)) fs.rmSync(this.txsIdsPath, { recursive: true });
        if (fs.existsSync(this.configPath)) fs.rmSync(this.configPath);
        
        fs.mkdirSync(this.txsIdsPath);
        this.snapHeight = -1;
        this.architecture = {};
        this.involedAddressesOverHeights = {};
        storageMiniLogger.log(`AddressesTxsRefsStorage reset: ${reason}`, (m, c) => console.info(m, c));
    }
}

/** New version of BlockchainStorage.
 * - No needs for "retreiveBlockByHash" anymore, we only use block indexes now
 * - Blocks hashes are stored in an index file (blockchain.idx) for fast retrieval
 * - Blocks are stored in binary files containing a batch of blocks (262_980 blocks per file) */
export class BlockchainStorage {
	converter = new HiveP2P.Converter();
	storage;
	batchSize = BLOCKCHAIN_SETTINGS.halvingInterval; // number of blocks per binary file
	lastBlockIndex = -1;
	/** Blockchain parts handler (blockchain-X.bin) Key: block file index @type {Object<number, BinaryHandler>} */
	bcHandlers = {};
	/** Blocks indexes (blockchain.idx) handler @type {BinaryHandler} */
	idxsHandler;
	
	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) {
		this.storage = storage;
		this.idxsHandler = new BinaryHandler(path.join(this.storage.PATH.BLOCKCHAIN, 'blockchain.idx'));
		if (this.idxsHandler.size % serializer.lengths.indexEntry !== 0) throw new Error(`blockchain.idx file is corrupted (size: ${this.idxsHandler.size})`);
		this.lastBlockIndex = Math.ceil(this.idxsHandler.size / serializer.lengths.indexEntry) - 1;
		storageMiniLogger.log(`BlockchainStorage initialized with ${this.lastBlockIndex + 1} blocks`, (m, c) => console.info(m, c));
	}
	
	// API METHODS
	/** @param {BlockFinalized} block */
    addBlock(block) {
		if (block.index !== this.lastBlockIndex + 1) throw new Error(`Block index mismatch: expected ${this.lastBlockIndex + 1}, got ${block.index}`);

		// DIGEST THE CONSUMED UTXOS
		const { involvedAnchors, repeatedAnchorsCount } = BlockUtils.extractInvolvedAnchors(block, 'blockFinalized');
		if (repeatedAnchorsCount > 0) throw new Error(`Block contains ${repeatedAnchorsCount} repeated UTXO anchors`);
		if (involvedAnchors.length && !this.#consumeUtxos(involvedAnchors)) throw new Error('Unable to consume UTXOs for the new block');

		// PREPARE DATA TO WRITE
		const utxosStates = BlockUtils.buildUtxosStatesOfFinalizedBlock(block);
		const blockBytes = serializer.serialize.block(block);
		const utxosStatesBytes = serializer.serialize.utxosStatesArray(utxosStates);
		const previousOffset = block.index % this.batchSize === 0 ? null
			: this.#getOffsetOfBlockData(this.lastBlockIndex);
		const start = previousOffset ? previousOffset.start + previousOffset.blockBytes + previousOffset.utxosStatesBytes : 0;
		const indexesBytes = serializer.serialize.blockIndexEntry(start, blockBytes.length, utxosStatesBytes.length);
		
		// UPDATE INDEXES and BLOCKCHAIN FILE, do not use "appendFileSync" => cursor position issues
		const blockchainHandler = this.#getBlockchainHandler(block.index);
		blockchainHandler.write(blockBytes);
		blockchainHandler.write(utxosStatesBytes);
		this.idxsHandler.write(indexesBytes);
		this.lastBlockIndex++;
    }
    getBlockBytes(height = 0, includeUtxosStates = false) {
        if (height > this.lastBlockIndex) return null;

		const offset = this.#getOffsetOfBlockData(height);
		if (!offset) return null;

		const { start, blockBytes, utxosStatesBytes } = offset;
		const blockchainHandler = this.#getBlockchainHandler(height);
		const totalBytes = blockBytes + (includeUtxosStates ? utxosStatesBytes : 0);
		const bytes = blockchainHandler.read(start, totalBytes);
		return {
			blockBytes: includeUtxosStates ? bytes.subarray(0, blockBytes) : bytes,
			utxosStatesBytes: includeUtxosStates ? bytes.subarray(blockBytes) : null,
			blockchainHandler, offset
		}
    }
	/** @param {number} height @param {number[]} txIndexes */
    getTransactions(height, txIndexes) {
		if (height > this.lastBlockIndex) return null;

		const { blockBytes } = this.getBlockBytes(height, false) || {};
		if (blockBytes) return this.#extractTransactionsFromBlockBytes(blockBytes, txIndexes);
	}
	/** @param {TxAnchor[]} anchors @param {boolean} breakOnSpent Specify if the function should return null when a spent UTXO is found (early abort) */
	getUtxos(anchors, breakOnSpent = false) {
		/** Key: Anchor, value: UTXO @type {Object<string, UTXO>} */
		const utxos = {};
		const search = this.#getUtxosSearchPattern(anchors);

		// BY BLOCK HEIGHT
		for (const height of search.keys()) {
			if (height > this.lastBlockIndex) return null;

			const { blockBytes, utxosStatesBytes } = this.getBlockBytes(height, true) || {};
			if (!blockBytes || !utxosStatesBytes) return null;
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point
			const txIndexes = Array.from(search.get(height).keys());
			const txs = this.#extractTransactionsFromBlockBytes(blockBytes, txIndexes)?.txs;
			if (!txs) return null;

			// BY TRANSACTION INDEX
			const searchPattern = new Uint8Array(4); // Search pattern: [txIndex(2), voutId(2)]
			for (const txIndex of txIndexes) {
				searchPattern.set(serializer.voutIdEncoder.encode(txIndex), 0);
				
				// BY VOUT ID
				// @ts-ignore: search.get(height).get(txIndex) can only contain valid voutIds at this point
				for (const voutId of search.get(height).get(txIndex)) {
					if (!txs[txIndex]?.outputs[voutId]) return null; // unable to find the referenced tx/output
					
					let utxoSpent = true;
					searchPattern.set(serializer.voutIdEncoder.encode(voutId), 2);
					const stateOffset = utxosStatesBytes.indexOf(searchPattern);
					if (stateOffset !== -1) utxoSpent = utxosStatesBytes[stateOffset + 4] === 1;
					if (utxoSpent && breakOnSpent) return null; // UTXO is spent

					const anchor = `${height}:${txIndex}:${voutId}`;
					const amount = txs[txIndex].outputs[voutId].amount;
					const rule = txs[txIndex].outputs[voutId].rule;
					const address = txs[txIndex].outputs[voutId].address;
					utxos[anchor] = new UTXO(anchor, amount, rule, address, utxoSpent);
				}
			}
		}

		return utxos;
	}
    undoBlock() {
        const offset = this.#getOffsetOfBlockData(this.lastBlockIndex);
		if (!offset) return false;

		// TRUNCATE INDEXES, AND BLOCKCHAIN FILE
		const blockchainHandler = this.#getBlockchainHandler(this.lastBlockIndex);
		blockchainHandler.shrink(offset.blockBytes + offset.utxosStatesBytes);
		this.idxsHandler.shrink(serializer.lengths.indexEntry);
		this.lastBlockIndex--;
    }
    reset() {
        if (fs.existsSync(this.storage.PATH.BLOCKCHAIN)) fs.rmSync(this.storage.PATH.BLOCKCHAIN, { recursive: true });
        fs.mkdirSync(this.storage.PATH.BLOCKCHAIN);
        this.lastBlockIndex = -1;
    }

	// INTERNAL METHODS
	/** @param {TxAnchor[]} anchors */
	#consumeUtxos(anchors) {
		const u = new Uint8Array(1); u[0] = 1; // spent state
		const search = this.#getUtxosSearchPattern(anchors);

		// BY BLOCK HEIGHT
		for (const height of search.keys()) {
			if (height > this.lastBlockIndex) return false;

			const { blockBytes, utxosStatesBytes, blockchainHandler, offset } = this.getBlockBytes(height, true) || {};
			if (!blockBytes || !utxosStatesBytes || !blockchainHandler || !offset) return false;

			// BY TRANSACTION INDEX
			const utxosStatesBytesStart = offset.start + offset.blockBytes;
			const searchPattern = new Uint8Array(4); // Search pattern: [txIndex(2), voutId(2)]
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point
			for (const txIndex of search.get(height).keys()) {
				// BY VOUT ID
				// @ts-ignore: search.get(height).get(txIndex) can only contain valid voutIds at this point
				for (const voutId of search.get(height).get(txIndex)) {
					searchPattern.set(serializer.voutIdEncoder.encode(txIndex), 0);
					searchPattern.set(serializer.voutIdEncoder.encode(voutId), 2);
					const stateOffset = utxosStatesBytes.indexOf(searchPattern);
					if (stateOffset === -1) throw new Error(`UTXO not found (anchor: ${height}:${txIndex}:${voutId})`);
					if (utxosStatesBytes[stateOffset + 4] === 1) throw new Error(`UTXO already spent (anchor: ${height}:${txIndex}:${voutId})`);
					
					// MARK UTXO AS SPENT
					blockchainHandler.write(u, utxosStatesBytesStart + stateOffset + 4);
				}
			}
		}

		return true;
	}
	/** @param {TxAnchor[]} anchors */
	#getUtxosSearchPattern(anchors) {
		// GROUP ANCHORS BY BLOCK HEIGHT
		/** height, Map(txindex, vout[]) @type {Map<number, Map<number, number[]>} */
		const search = new Map();
		for (const p of anchors) {
			const { height, txIndex, vout } = serializer.parseAnchor(p);
			if (!search.has(height)) search.set(height, new Map());
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point, if not, we want the error to be thrown
			if (!search.get(height).has(txIndex)) search.get(height)?.set(txIndex, []);
			// @ts-ignore: search.get(height) can only contain valid txIndexes at this point, if not, we want the error to be thrown
			search.get(height).get(txIndex).push(vout);
		}
		return search;
	}
	#getOffsetOfBlockData(height = -1) { // if reading is too slow, we can implement a caching system here
		if (height < 0 || height > this.lastBlockIndex) return null;
		const buffer = this.idxsHandler.read(height * serializer.lengths.indexEntry, serializer.lengths.indexEntry);
		return serializer.deserialize.blockIndexEntry(buffer);
	}
	#getBlockchainHandler(height = 0) {
		const batchIndex = Math.floor(height / this.batchSize);
		if (this.bcHandlers[batchIndex] === undefined)
			this.bcHandlers[batchIndex] = new BinaryHandler(path.join(this.storage.PATH.BLOCKCHAIN, `blockchain-${batchIndex}.bin`));
		return this.bcHandlers[batchIndex];
	}
	/** @param {Uint8Array} blockBytes @param {number[]} txIndexes */
	#extractTransactionsFromBlockBytes(blockBytes, txIndexes) {
		/** key: txIndex, value: transaction @type {Object<number, Transaction>} */
		const txs = {};
		/** @type {Object<number, 'miner' | 'validator'>} */
		const specialMode = { 0: 'miner', 1: 'validator' }; // finalized block only
		const nbOfTxs = this.converter.bytes2ToNumber(blockBytes.subarray(0, 2));
		const timestampOffset = serializer.dataPositions.timestampInFinalizedBlock;
		const timestamp = this.converter.bytes6ToNumber(blockBytes.subarray(timestampOffset, timestampOffset + 6));
		for (const i of txIndexes) {
			if (txs[i] !== undefined) continue; // already extracted
			if (i + 1 > nbOfTxs) return null;

			const pointerStart = serializer.lengths.blockFinalizedHeader + (i * 4);
			const pointerBuffer = blockBytes.subarray(pointerStart, pointerStart + 4);
			const offsetStart = this.converter.bytes4ToNumber(pointerBuffer);
			const offsetEnd = i + 1 === nbOfTxs ? blockBytes.length
				: this.converter.bytes4ToNumber(blockBytes.subarray(pointerStart + 4, pointerStart + 8));
			const txBuffer = blockBytes.subarray(offsetStart, offsetEnd);
			const tx = serializer.deserialize.transaction(txBuffer, specialMode[i] || 'tx');
			txs[i] = tx;
		}
		return { txs, timestamp };
    }
}

// used to settle the difference between loading a big file and loading multiple small files
// also compare reading methods: sync, async, partial read, etc...
class TestStorage extends ContrastStorage {
    txBinaryWeight = 200; // in bytes
    txCount = 1100; // tx in a simulated block
	/** @param {string|null} masterHex - master hex string to generate local identifier */
	constructor(masterHex = '') { super(masterHex); }

    // erase all blocks
    reset() {
        fs.rmSync(this.PATH.TEST_STORAGE, { recursive: true });
        fs.mkdirSync(this.PATH.TEST_STORAGE);
    }
    #createRandomTx() {
        //const tx = new Uint8Array(this.txBinaryWeight);
        //crypto.getRandomValues(tx);
		const tx = crypto.randomBytes(this.txBinaryWeight);
        return tx;
    }
    #createRandomBlock() {
        const block = [];
        for (let i = 0; i < this.txCount; i++) block.push(this.#createRandomTx());
        return block;
    }
	/** @param {Uint8Array[]} block @param {number} index */
    async saveBlock(block, index) {
        const totalSize = block.reduce((acc, tx) => acc + tx.length, 0);
        const concatenated = new Uint8Array(totalSize);
        let offset = 0;
        for (let i = 0; i < block.length; i++) {
            concatenated.set(block[i], offset);
            offset += block[i].length;
        }

        await this.saveBinaryAsync(index.toString(), concatenated, this.PATH.TEST_STORAGE);
    }
	/** @param {Uint8Array[]} block @param {number} index */
    saveBlockDecomposed(block, index) {
        const blockDir = path.join(this.PATH.TEST_STORAGE, index.toString());
        for (let i = 0; i < block.length; i++) this.saveBinary(`${index}-${i}`, block[i], blockDir);
    }
    async createAndSaveBlocks(num = 100, { unified = true, decomposed = true } = {}) {
        for (let i = 0; i < num; i++) {
            const block = this.#createRandomBlock();
            if (unified) await this.saveBlock(block, i);
            if (decomposed) this.saveBlockDecomposed(block, i);
        }
    }
    loadBlock(index = 0, count = this.txCount) {
		const block = [];
		const buffer = this.loadBinary(index.toString(), this.PATH.TEST_STORAGE);
		if (typeof buffer === 'boolean') throw new Error(`Unable to load block #${index}`);
		for (let i = 0; i < count; i++) {
			const start = i * this.txBinaryWeight;
			const end = start + this.txBinaryWeight;
			block.push(buffer.slice(start, end));
		}
		return block;
    }
	async loadBlockAsync(index = 0) {
		return await this.loadBinaryAsync(index.toString(), this.PATH.TEST_STORAGE);
	}
	getFilesInBlockDir(index = 0) {
        const blockDir = path.join(this.PATH.TEST_STORAGE, index.toString());
        return { blockDir, files: fs.readdirSync(blockDir) };
    }
    loadBlockDecomposed(index = 0, blockDir = '', filesCount = 0) {
        const block = [];
        for (let i = 0; i < filesCount; i++)
			block.push(this.loadBinary(`${index}-${i}`, blockDir));
        return block;
    }
	async loadBlockDecomposedAsync(index = 0, blockDir = '', filesCount = 0) {
		const loadPromises = [];
		for (let i = 0; i < filesCount; i++)
			loadPromises.push(this.loadBinaryAsync(`${index}-${i}`, blockDir));
		return await Promise.all(loadPromises);
	}
	readSpecificTxsFromBlock(index = 0, count = 1, log = true) {
		const logs = [];
		const block = [];
		let s = 0;
		if (log) s = performance.now();
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		if (log) logs.push(`Time to join path: ${(performance.now() - s).toFixed(5)}ms`);

		if (log) s = performance.now();
		const fd = fs.openSync(p, 'r');
		if (log) logs.push(`Time to open file: ${(performance.now() - s).toFixed(5)}ms`);

		if (log) s = performance.now();
		for (let i = 0; i < count; i++) {
			block.push(Buffer.allocUnsafe(this.txBinaryWeight));
			fs.readSync(fd, block[i], 0, this.txBinaryWeight, i * this.txBinaryWeight);
		}
		if (log) logs.push(`Time to read files: ${(performance.now() - s).toFixed(5)}ms`);

		if (log) s = performance.now();
		fs.closeSync(fd);
		if (log) logs.push(`Time to close file: ${(performance.now() - s).toFixed(5)}ms`);
		return { block, logs };
	}
	readXPercentOfBlockBytesTest(index = 0, percentRead = 10) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		const fd = fs.openSync(p, 'r');
		const size = fs.fstatSync(fd).size;
		const start = performance.now();
		const readSize = Math.floor(size * (percentRead / 100));
		const buffer = fsReadBytesSync(fd, 0, readSize);
		console.log(`Time to read ${percentRead}% of block bytes: ${(performance.now() - start).toFixed(5)}ms`);
		fs.closeSync(fd);
		return buffer;
	}
	truncateBlock(index = 0, offset = 0) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		fs.truncateSync(p, offset);
	}
	truncateBlockByDesc(index = 0, newSize = 0) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		const fd = fs.openSync(p, 'r+');
		fs.ftruncateSync(fd, newSize);
		fs.closeSync(fd);
	}
	getBlockFileSize(index = 0) {
		const p = path.join(this.PATH.TEST_STORAGE, `${index}.bin`);
		const fd = fs.openSync(p, 'r');
		const getSizeStart = performance.now();
		const stats = fs.fstatSync(fd);
		console.log(`Block size: ${stats.size} bytes (calculated in ${(performance.now() - getSizeStart).toFixed(5)}ms)`);
		fs.closeSync(fd);
		return stats.size;
	}
}
async function test() {
	const testStorage = new TestStorage('00000000000000000000000000000000000000000000000000000000000000ff');
    testStorage.txBinaryWeight *= 1;
	testStorage.txCount = 1100; //100 * 1024;
	testStorage.reset();
	const nbOfTxsToRead = 100;
	const writeStart = performance.now();
    await testStorage.createAndSaveBlocks(2, { unified: true, decomposed: false });

	testStorage.getBlockFileSize(0);
	testStorage.readXPercentOfBlockBytesTest(0, 1);
	testStorage.readXPercentOfBlockBytesTest(0, 10);
	testStorage.readXPercentOfBlockBytesTest(0, 100);

	console.log(`Time to write test block: ${(performance.now() - writeStart).toFixed(5)}ms`);
	//const { blockDir, files } = testStorage.getFilesInBlockDir(0);
	console.log(`Test with ${testStorage.txCount} txs of ${testStorage.txBinaryWeight} bytes each (~${(testStorage.txCount * testStorage.txBinaryWeight / 1024).toFixed(2)}KB total)`);
	
	console.log('--- SYNC Test start ---');
	
    const timeStart_C = performance.now();
    const loadedBlock_C = testStorage.loadBlock(0, nbOfTxsToRead); // for detailled timing
	const avgBigTime = ((performance.now() - timeStart_C) / nbOfTxsToRead).toFixed(5);
    console.log(`Time to read ${nbOfTxsToRead} txs (big block): ${(performance.now() - timeStart_C).toFixed(5)}ms (~${avgBigTime}ms per tx)`);
	
	// -------------------------------------
	console.log('--- Partial Read Test start ---');
	const { block, logs } = testStorage.readSpecificTxsFromBlock(1, 1); // for detailled timing
	//logs.push(`Time to read 1 tx: ${(performance.now() - timeStart_G).toFixed(5)}ms`);
	logs.forEach(log => console.log(log));
	const timeStart_G = performance.now();
	const r = testStorage.readSpecificTxsFromBlock(0, 1, false);
	console.log(`Time to read 1 tx: ${(performance.now() - timeStart_G).toFixed(5)}ms`);

	//testStorage.loadBlockDecomposed(0, blockDir, testStorage.txCount); // to reset OS cache
	
	const timeStart_H = performance.now();
	const { block: block2, logs: logs2 } = testStorage.readSpecificTxsFromBlock(1, nbOfTxsToRead, false);
	//logs2.push(`Time to read all txs: ${(performance.now() - timeStart_H).toFixed(5)}ms`);
	const avgPartialReadTime = ((performance.now() - timeStart_H) / nbOfTxsToRead).toFixed(5);
	console.log(`Time to read ${nbOfTxsToRead} txs: ${(performance.now() - timeStart_H).toFixed(5)}ms (~${avgPartialReadTime}ms per tx)`);



	const timeStart_T = performance.now();
	const truncatedOffset = Math.floor((testStorage.txBinaryWeight * testStorage.txCount) / 2);
	testStorage.truncateBlock(1, truncatedOffset);
	console.log(`Time to truncate block at offset ${truncatedOffset}: ${(performance.now() - timeStart_T).toFixed(5)}ms`);

	const timeStart_U = performance.now();
	testStorage.truncateBlockByDesc(0, truncatedOffset);
	console.log(`Time to truncate block by desc to new size ${truncatedOffset}: ${(performance.now() - timeStart_U).toFixed(5)}ms`);

	console.log('--- Test end ---');
}
//test();

/* 1100 files of 200 bytes each or 220KB => 1 block
Time to load a big file: 0.74550ms
Time to load multiple small files: 194.24940ms (~0.17657ms per tx)

Time to read dir: 0.54700msJe
Time to load multiple small files async: 361.34590ms (~0.32847ms per tx)
*/