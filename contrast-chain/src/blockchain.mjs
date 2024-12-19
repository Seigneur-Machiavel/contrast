import fs from 'fs';
import path from 'path';
const url = await import('url');
import LevelUp from 'levelup';
import LevelDown from 'leveldown';
import pino from 'pino';
import { BlockUtils } from './block-classes.mjs';
import { BlockMiningData } from './block-classes.mjs';
import utils from './utils.mjs';
import { Transaction_Builder } from './transaction.mjs';

/**
* @typedef {import("../src/block-tree.mjs").TreeNode} TreeNode
* @typedef {import("./block-classes.mjs").BlockInfo} BlockInfo
* @typedef {import("./block-classes.mjs").BlockData} BlockData
* @typedef {import("../src/vss.mjs").Vss} Vss
* @typedef {import("../src/utxoCache.mjs").UtxoCache} UtxoCache
* @typedef {import("../src/memPool.mjs").MemPool} MemPool
* @typedef {import("../src/snapshot-system.mjs").SnapshotSystem} SnapshotSystem
*/

/** Represents the blockchain and manages its operations. */
export class Blockchain {
    __parentFolderPath = path.dirname(url.fileURLToPath(import.meta.url));
    __parentPath = path.join(this.__parentFolderPath, '..');
    /** Creates a new Blockchain instance.
     * @param {string} dbPath - The path to the LevelDB database.
     * @param {Object} [options] - Configuration options for the blockchain.
     * @param {string} [options.logLevel='info'] - The logging level for Pino.
     * @param {number} [options.snapshotInterval=100] - Interval at which to take full snapshots. */
    constructor(nodeId, options = {}) {
        this.nodeId = nodeId;
        const {
            logLevel = 'silent', // 'silent',
            snapshotInterval = 100,
        } = options;
        this.dbPath = path.join(this.__parentPath, 'nodes-data', nodeId, 'blockchain');
        // ensure folder exists
        if (!fs.existsSync(this.dbPath)) { fs.mkdirSync(this.dbPath, { recursive: true }); }
        this.db = LevelUp(LevelDown(this.dbPath));

        this.cache = {
            /** @type {Map<string, BlockData>} */
            blocksByHash: new Map(),
            /** @type {Map<number, string>} */
            blocksHashByHeight: new Map(),
            /** @type {Map<string, number>} */
            blockHeightByHash: new Map(),
            oldestBlockHeight: () => {
                if (this.cache.blocksHashByHeight.size === 0) { return -1; }
                return Math.min(...this.cache.blocksHashByHeight.keys());
            }
        };
        /** @type {number} */
        this.currentHeight = -1;
        /** @type {BlockData|null} */
        this.lastBlock = null;
        /** @type {number} */
        this.snapshotInterval = snapshotInterval;
        /** @type {BlockMiningData[]} */
        this.blockMiningData = []; // .csv mining datas research
        /** @type {pino.Logger} */
        this.logger = pino({
            level: logLevel,
            transport: {
                target: 'pino-pretty',
                options: { colorize: true }
            }
        });

        this.logger.info({ dbPath: './databases/blockchainDB-' + nodeId, snapshotInterval }, 'Blockchain instance created');
    }
    /** @param {SnapshotSystem} snapshotSystem */
    async load(snapshotSystem) {
        // OPENNING BLOCKCHAIN DATABASE
        try {
            while (this.db.status === 'opening') { await new Promise(resolve => setTimeout(resolve, 100)); }
        } catch (error) {
            console.error('Error while opening the databases:', error);
        }

        // ensure consistency between the blockchain and the snapshot system
        const lastSavedBlockHeight = await this.getLastKnownHeight();
        snapshotSystem.eraseSnapshotsHigherThan(lastSavedBlockHeight);

        const snapshotsHeights = snapshotSystem.getSnapshotsHeights();
        const olderSnapshotHeight = snapshotsHeights[0] ? snapshotsHeights[0] : 0;
        const youngerSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];
        const startHeight = isNaN(youngerSnapshotHeight) ? -1 : youngerSnapshotHeight;

        // Cache the blocks from the last snapshot +1 to the last block
        // cacheStart : 0, 11, 21, etc...
        const snapModulo = snapshotSystem.snapshotHeightModulo;
        const cacheStart = olderSnapshotHeight > snapModulo ? olderSnapshotHeight - (snapModulo-1) : 0;
        await this.#loadBlocksFromStorageToCache(cacheStart, startHeight);
        this.currentHeight = startHeight;
        this.lastBlock = await this.getBlockByHeight(startHeight);

        // cache + db cleanup
        await this.#eraseBlocksHigherThan(startHeight);
        if (startHeight === -1) { // no snapshot to load
            await this.eraseEntireDatabase();
        }

        return startHeight;
    }
    async #loadBlocksFromStorageToCache(indexStart = 0, indexEnd = 9) {
        if (indexStart > indexEnd) { return; }

        const blocksPromises = [];
        for (let i = indexStart; i <= indexEnd; i++) {
            blocksPromises.push(this.#getBlockFromDiskByHeight(i));
        }

        for (const blockPromise of blocksPromises) {
            const block = await blockPromise;
            if (!block) { break; }
            this.#setBlockInCache(block);
        }

        console.log(`[DB -> CACHE] Blocks loaded from ${indexStart} to ${indexEnd}`);
    }
    /** @param {BlockData} block */
    #setBlockInCache(block) {
        this.cache.blocksByHash.set(block.hash, block);
        this.cache.blocksHashByHeight.set(block.index, block.hash);
        this.cache.blockHeightByHash.set(block.hash, block.index);
    }
    /** Adds a new confirmed block to the blockchain.
     * @param {UtxoCache} utxoCache - The UTXO cache to use for the block.
     * @param {BlockData[]} blocks - The blocks to add. ordered by height
     * @param {boolean} [persistToDisk=true] - Whether to persist the block to disk.
     * @param {boolean} [saveBlockInfo=true] - Whether to save the block info.
     * @param {Object<string, string>} [blockPubKeysAddresses] - The block public keys and addresses.
     * @throws {Error} If the block is invalid or cannot be added. */
    async addConfirmedBlocks(utxoCache, blocks, persistToDisk = true, saveBlockInfo = true, totalFees) {
        for (const block of blocks) {
            this.logger.info({ blockHeight: block.index, blockHash: block.hash }, 'Adding new block');
            try {
                this.#setBlockInCache(block);
                this.lastBlock = block;
                this.currentHeight = block.index;

                const promises = [];
                if (persistToDisk) {
                    promises.push(this.#persistBlockToDisk(block));
                    promises.push(this.db.put('currentHeight', this.currentHeight.toString()));
                }

                const blockInfo = saveBlockInfo ? await BlockUtils.getFinalizedBlockInfo(utxoCache, block, totalFees) : undefined;
                if (saveBlockInfo) { promises.push(this.#persistBlockInfoToDisk(blockInfo)) }

                this.logger.info({ blockHeight: block.index, blockHash: block.hash }, 'Block successfully added');
                return blockInfo;
            } catch (error) {
                this.logger.error({ error, blockHash: block.hash }, 'Failed to add block');
                throw error;
            }
        }
    }
    /** returns the height of erasable blocks without erasing them. @param {number} height */
    erasableCacheLowerThan(height = 0) {
        let erasableUntil = null;
        const oldestHeight = this.cache.oldestBlockHeight();
        if (oldestHeight >= height) { return null; }

        for (let i = oldestHeight; i < height; i++) {
            const blockHash = this.cache.blocksHashByHeight.get(i);
            if (!blockHash) { continue; }
            erasableUntil = i;
        }

        console.log(`Cache erasable from ${oldestHeight} to ${erasableUntil}`);
        return { from: oldestHeight, to: erasableUntil };
    }
    /** Erases the cache from the oldest block to the specified height(included). */
    eraseCacheFromTo(fromHeight = 0, toHeight = 100) {
        if (fromHeight > toHeight) { return; }

        let erasedUntil = null;
        for (let i = fromHeight; i <= toHeight; i++) {
            const blockHash = this.cache.blocksHashByHeight.get(i);
            if (!blockHash) { continue; }

            this.cache.blocksHashByHeight.delete(i);
            this.cache.blockHeightByHash.delete(blockHash);
            this.cache.blocksByHash.delete(blockHash);
            erasedUntil = i;
        }

        console.log(`Cache erased from ${fromHeight} to ${erasedUntil}`);
        return { from: fromHeight, to: erasedUntil };
    }
    async eraseEntireDatabase() {
        const batch = this.db.batch();
        const stream = this.db.createKeyStream();
        for await (const key of stream) {
            batch.del(key);
        }
        await batch.write();
        console.info('[DB] Database erased');
    }
    async #eraseBlocksHigherThan(height = 0) {
        let erasedUntil = null;
        const batch = this.db.batch();
        let i = height + 1;
        while (true) {
            const block = await this.getBlockByHeight(i);
            if (!block) { break; }
            
            const blockHash = block.hash;
            batch.del(blockHash);
            batch.del(`height-${i}`);
            batch.del(`height-${i}-txIds`);

            for (const tx of block.Txs) {
                batch.del(`${i}:${tx.id}`);
            }

            this.cache.blocksHashByHeight.delete(i);
            this.cache.blockHeightByHash.delete(blockHash);
            this.cache.blocksByHash.delete(blockHash);

            erasedUntil = i;
            i++;
        }
        await batch.write();

        if (erasedUntil === null) { return; }
        console.info(`[DB] Blocks erased from ${height} to ${erasedUntil}`);
    }
    /** Applies the changes from added blocks to the UTXO cache and VSS.
    * @param {UtxoCache} utxoCache - The UTXO cache to update.
    * @param {Vss} vss - The VSS to update.
    * @param {BlockData[]} blocksData - The blocks to apply.
    * @param {boolean} [storeAddAddressAnchors=false] - Whether to store added address anchors. */
    async applyBlocks(utxoCache, vss, blocksData, storeAddAddressAnchors = false) {
        for (const block of blocksData) {
            const blockDataCloneToDigest = BlockUtils.cloneBlockData(block); // clone to avoid modification
            try {
                const newStakesOutputs = await utxoCache.digestFinalizedBlocks([blockDataCloneToDigest], storeAddAddressAnchors);
                this.blockMiningData.push({ index: block.index, difficulty: block.difficulty, timestamp: block.timestamp, posTimestamp: block.posTimestamp });
                vss.newStakes(newStakesOutputs);
            } catch (error) {
                this.logger.error({ error, blockHash: block.hash }, 'Failed to apply block');
                throw error;
            }
        }
    }

    /** Persists a block to disk.
     * @param {BlockData} finalizedBlock - The block to persist.
     * @returns {Promise<void>} */
    async #persistBlockToDisk(finalizedBlock) { // now using serializer v3
        this.logger.debug({ blockHash: finalizedBlock.hash }, 'Persisting block to disk');
        try {
            // TRYING THE BEST PRACTICE: full batch write
            const txsIds = [];
            const batch = this.db.batch();
            for (let i = 0; i < finalizedBlock.Txs.length; i++) {
                const tx = finalizedBlock.Txs[i];
                const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false;
                const serializedTx = specialTx ? utils.serializer.transaction.toBinary_v2(tx) : utils.serializerFast.serialize.transaction(tx);
                txsIds.push(tx.id);
                batch.put(`${finalizedBlock.index}:${tx.id}`, Buffer.from(serializedTx));
            }

            const serializedTxsIds = utils.serializer.array_of_tx_ids.toBinary_v3(txsIds);
            batch.put(`height-${finalizedBlock.index}-txIds`, Buffer.from(serializedTxsIds));

            const serializedHeader = utils.serializer.blockHeader_finalized.toBinary_v3(finalizedBlock);
            batch.put(finalizedBlock.hash, Buffer.from(serializedHeader));

            const serializedHash = utils.convert.hex.toUint8Array(finalizedBlock.hash);
            batch.put(`height-${finalizedBlock.index}`, Buffer.from(serializedHash));

            await batch.write();

            this.logger.debug({ blockHash: finalizedBlock.hash }, 'Block persisted to disk');
        } catch (error) {
            this.logger.error({ error, blockHash: finalizedBlock.hash }, 'Failed to persist block to disk');
            throw error;
        }
    }
    /** @param {BlockInfo} blockInfo */
    async #persistBlockInfoToDisk(blockInfo) {
        const blockHash = blockInfo.header.hash;
        this.logger.debug({ blockHash }, 'Persisting block info to disk');
        try {
            const serializedBlockInfo = utils.serializer.rawData.toBinary_v1(blockInfo);
            const buffer = Buffer.from(serializedBlockInfo);
            await this.db.put(`info-${blockHash}`, buffer);

            this.logger.debug({ blockHash }, 'Block info persisted to disk');
        } catch (error) {
            this.logger.error({ error, blockHash }, 'Failed to persist block info to disk');
            throw error;
        }
    }
    /** @param {MemPool} memPool @param {number} indexStart @param {number} indexEnd */
    async persistAddressesTransactionsReferencesToDisk(memPool, indexStart, indexEnd) {
        indexStart = Math.max(0, indexStart);
        if (indexStart > indexEnd) { return; }

        const addressesTxsRefsSnapHeightSerialized = await this.db.get('addressesTxsRefsSnapHeight').catch(() => null);
        const addressesTxsRefsSnapHeight = addressesTxsRefsSnapHeightSerialized ? utils.fastConverter.uint86BytesToNumber(addressesTxsRefsSnapHeightSerialized) : -1;
        if (addressesTxsRefsSnapHeight >= indexEnd) { console.info(`[DB] Addresses transactions already persisted to disk: snapHeight=${addressesTxsRefsSnapHeight} / indexEnd=${indexEnd}`); return; }

        /** @type {Object<string, string[]>} */
        const actualizedAddressesTxsRefs = {};
        for (let i = indexStart; i <= indexEnd; i++) {
            const finalizedBlock = await this.getBlockByHeight(i);
            if (!finalizedBlock) { console.error('Block not found'); continue; }
            const transactionsReferencesSortedByAddress = BlockUtils.getFinalizedBlockTransactionsReferencesSortedByAddress(finalizedBlock, memPool.knownPubKeysAddresses);

            /** @type {Object<string, Promise<string[]>} */
            const addressesTransactionsPromises = {};
            for (const address of Object.keys(transactionsReferencesSortedByAddress)) {
                if (actualizedAddressesTxsRefs[address]) { continue; } // already loaded
                addressesTransactionsPromises[address] = this.db.get(`${address}-txs`).catch(() => []);
            }

            for (const [address, newTxsReferences] of Object.entries(transactionsReferencesSortedByAddress)) {
                if (addressesTransactionsPromises[address]) {
                    const serialized = await addressesTransactionsPromises[address];
                    const deserialized = utils.serializerFast.deserialize.txsReferencesArray(serialized);
                    actualizedAddressesTxsRefs[address] = deserialized;
                }
                if (!actualizedAddressesTxsRefs[address]) { actualizedAddressesTxsRefs[address] = []; }
                const concatenated = actualizedAddressesTxsRefs[address].concat(newTxsReferences);
                actualizedAddressesTxsRefs[address] = concatenated;
            }
        }

        const batch = this.db.batch();
        let totalDuplicates = 0;
        for (const address of Object.keys(actualizedAddressesTxsRefs)) {
            const actualizedAddressTxsRefs = actualizedAddressesTxsRefs[address];

            const txsRefsDupiCounter = {};
            let duplicate = 0;
            for (let i = 0; i < actualizedAddressTxsRefs.length; i++) {
                const txRef = actualizedAddressTxsRefs[i];
                if (txsRefsDupiCounter[txRef]) { duplicate++; }
                
                txsRefsDupiCounter[txRef] = true;
            }
            if (duplicate > 0) { totalDuplicates += duplicate; };

            const serialized = utils.serializerFast.serialize.txsReferencesArray(actualizedAddressTxsRefs);
            batch.put(`${address}-txs`, Buffer.from(serialized));
            batch.put('addressesTxsRefsSnapHeight', Buffer.from(utils.fastConverter.numberTo6BytesUint8Array(indexEnd)));
        }
        if (totalDuplicates > 0) { console.warn(`[DB] ${totalDuplicates} duplicate txs references found and removed`); }

        await batch.write();
            
        console.info(`[DB] Addresses transactions persisted to disk from ${indexStart} to ${indexEnd} (included)`);
    }
    /** @param {MemPool} memPool @param {string} address @param {number} [from=0] @param {number} [to=this.currentHeight] */
    async getTxsReferencesOfAddress(memPool, address, from = 0, to = this.currentHeight) {
        const cacheStartIndex = this.cache.oldestBlockHeight();

        // try to get the txs references from the DB first
        let txsRefs = [];
        try {
            if (from >= cacheStartIndex) { throw new Error('Data in cache, no need to get from disk'); }

            const txsRefsSerialized = await this.db.get(`${address}-txs`);
            txsRefs = utils.serializerFast.deserialize.txsReferencesArray(txsRefsSerialized);
        } catch (error) {};

        // remove duplicates
        const txsRefsDupiCounter = {};
        const txsRefsWithoutDuplicates = [];
        let duplicate = 0;
        for (let i = 0; i < txsRefs.length; i++) {
            const txRef = txsRefs[i];
            if (txsRefsDupiCounter[txRef]) {
                duplicate++;
                continue;
            }
            
            txsRefsDupiCounter[txRef] = true;
            txsRefsWithoutDuplicates.push(txRef);
        }
        txsRefs = txsRefsWithoutDuplicates
        if (duplicate > 0) { console.warn(`[DB] ${duplicate} duplicate txs references found for address ${address}`); }

        // complete with the cache
        let index = cacheStartIndex;
        while (index <= to) {
            const blockHash = this.cache.blocksHashByHeight.get(index);
            if (!blockHash) { break; }
            index++;

            const block = this.cache.blocksByHash.get(blockHash);
            const transactionsReferencesSortedByAddress = BlockUtils.getFinalizedBlockTransactionsReferencesSortedByAddress(block, memPool.knownPubKeysAddresses);
            if (!transactionsReferencesSortedByAddress[address]) { continue; }

            const newTxsReferences = transactionsReferencesSortedByAddress[address];
            txsRefs = txsRefs.concat(newTxsReferences);
        }

        if (txsRefs.length === 0) { return txsRefs; }

        // filter to preserve only the txs references in the range
        let finalTxsRefs = [];
        for (let i = 0; i < txsRefs.length; i++) {
            const txRef = txsRefs[i];
            const height = parseInt(txRef.split(':')[0], 10);
            if (from > height) { continue; }

            finalTxsRefs = txsRefs.slice(i);
            break;
        }
        for (let i = finalTxsRefs.length - 1; i >= 0; i--) {
            const txRef = finalTxsRefs[i];
            const height = parseInt(txRef.split(':')[0], 10);
            if (to < height) { continue; }

            finalTxsRefs = finalTxsRefs.slice(0, i + 1);
            break;
        }

        return finalTxsRefs;
    }
    /** Retrieves a range of blocks from disk by height.
     * @param {number} fromHeight - The starting height of the range.
     * @param {number} [toHeight=999_999_999] - The ending height of the range.
     * @param {boolean} [deserialize=true] - Whether to deserialize the blocks. */
    async getRangeOfBlocksByHeight(fromHeight, toHeight = 999_999_999, deserialize = true) {
        if (typeof fromHeight !== 'number' || typeof toHeight !== 'number') { throw new Error('Invalid block range: not numbers'); }
        if (fromHeight > toHeight) { throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`); }

        const blocksData = [];
        for (let i = fromHeight; i <= toHeight; i++) {
            const blockData = await this.getBlockByHeight(i, deserialize);
            if (!blockData) { break; }
            blocksData.push(blockData);
        }
        return blocksData;
    }
    /** Retrieves a block by its hash.
     * @param {string} hash - The hash of the block to retrieve.
     * @returns {Promise<BlockData>} The retrieved block.
     * @throws {Error} If the block is not found. */
    async getBlockByHash(hash) {
        this.logger.debug({ blockHash: hash }, 'Retrieving block');

        const block = this.cache.blocksByHash.has(hash)
        ? this.cache.blocksByHash.get(hash)
        : await this.#getBlockFromDiskByHash(hash, true);

        if (block) { return block; }

        this.logger.error({ blockHash: hash }, 'Block not found');
        throw new Error(`Block not found: ${hash}`);
    }
    /** Retrieves a block by its height. @param {number} height - The height of the block to retrieve. */
    async getBlockByHeight(height, deserialize = true) {
        this.logger.debug({ blockHeight: height }, 'Retrieving block');

        if (deserialize && this.cache.blocksHashByHeight.has(height)) {
            return this.cache.blocksByHash.get(this.cache.blocksHashByHeight.get(height));
        }

        const block = await this.#getBlockFromDiskByHeight(height, deserialize);
        if (block) { return block; }

        this.logger.error({ blockHeight: height }, 'Block not found');
        return null;
    }
    /** Retrieves a block from disk by its hash. @param {string} hash - The hash of the block to retrieve. */
    async #getBlockFromDiskByHash(hash, deserialize = true) {
        try {
            const serializedHeader = await this.db.get(hash);
            const blockHeader = utils.serializer.blockHeader_finalized.fromBinary_v3(serializedHeader);
            const height = blockHeader.index;
            const serializedTxsIds = await this.db.get(`height-${height}-txIds`);

            const txsIds = utils.serializer.array_of_tx_ids.fromBinary_v3(serializedTxsIds);
            const txsPromises = txsIds.map(txId => this.db.get(`${height}:${txId}`));

            if (!deserialize) { return { header: serializedHeader, txs: await Promise.all(txsPromises) }; }

            return BlockUtils.blockDataFromSerializedHeaderAndTxs(serializedHeader, await Promise.all(txsPromises));
        } catch (error) {
            if (error.type === 'NotFoundError') { return null; }
            throw error;
        }
    }
    /** Retrieves a block from disk by its height. @param {number} height - The height of the block to retrieve. */
    async #getBlockFromDiskByHeight(height, deserialize = true) {
        try {
            const serializedHash = await this.db.get(`height-${height}`);
            if (!serializedHash) { return null; }
            const blockHash = utils.convert.uint8Array.toHex(serializedHash);

            const serializedHeader = this.db.get(blockHash);
            const serializedTxsIds = this.db.get(`height-${height}-txIds`);

            const txsIds = utils.serializer.array_of_tx_ids.fromBinary_v3(await serializedTxsIds);
            const txsPromises = txsIds.map(txId => this.db.get(`${height}:${txId}`));

            if (!deserialize) { return { header: await serializedHeader, txs: await Promise.all(txsPromises) }; }

            return BlockUtils.blockDataFromSerializedHeaderAndTxs(await serializedHeader, await Promise.all(txsPromises));
        } catch (error) {
            if (error.type === 'NotFoundError') { return null; }
            throw error;
        }
    }
    async getBlockInfoFromDiskByHeight(height = 0) {
        try {
            const serializedHash = await this.db.get(`height-${height}`);
            if (!serializedHash) { return null; }

            const blockHash = utils.convert.uint8Array.toHex(serializedHash);
            const blockInfoUint8Array = await this.db.get(`info-${blockHash}`);
            
            /** @type {BlockInfo} */
            const blockInfo = utils.serializer.rawData.fromBinary_v1(blockInfoUint8Array);
            return blockInfo;
        } catch (error) {
            if (error.type === 'NotFoundError') { return null; }
            throw error;
        }
    }
    /** @param {string} txReference - The transaction reference in the format "height:txId" */
    async getTransactionByReference(txReference) {
        const [height, txId] = txReference.split(':');
        try {
            const serializedTx = await this.db.get(`${height}:${txId}`);
            return this.deserializeTransaction(serializedTx);
        } catch (error) {
            // If the transaction is not found or deserialization fails, return null.
            this.logger.error({ txReference }, 'Transaction not found or failed to deserialize');
            return null;
        }
    }
    /** @param {Uint8Array} serializedTx - The serialized transaction data */
    deserializeTransaction(serializedTx) {
        try { // Try fast deserialization first.
            return utils.serializerFast.deserialize.transaction(serializedTx);
        } catch (error) {
            this.logger.debug({ error }, 'Failed to fast deserialize transaction');
        }

        try { // Try the special transaction deserialization if fast deserialization fails.
            return utils.serializer.transaction.fromBinary_v2(serializedTx);
        } catch (error) {
            this.logger.debug({ error }, 'Failed to deserialize special transaction');
        }

        // Return null if deserialization fails for all strategies.
        this.logger.error('luid-9f54fbca Unable to deserialize transaction using available strategies');
        return null;
    }

    async getLastKnownHeight() {
        const storedHeight = await this.db.get('currentHeight').catch(() => '-1');
        const storedHeightInt = parseInt(storedHeight, 10);
        return storedHeightInt;
    }
    /** @returns {string} The hash of the latest block */
    getLatestBlockHash() {
        return this.lastBlock ? this.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000";
    }
}