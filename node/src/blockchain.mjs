import { BlockchainStorage } from '../../utils/storage-manager.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { BlockUtils } from './block-classes.mjs';
import { BlockMiningData } from './block-classes.mjs';
import { convert, FastConverter } from '../../utils/converters.mjs';
import { serializer, serializerFast } from '../../utils/serializer.mjs';
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
    fastConverter = new FastConverter();
    miniLogger = new MiniLogger('blockchain');

    /** @param {string} nodeId - The ID of the node. */
    constructor(nodeId) {
        this.nodeId = nodeId;
        this.blockStorage = new BlockchainStorage();
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
        this.currentHeight = this.blockStorage.lastBlockIndex;
        /** @type {BlockData|null} */
        this.lastBlock = null;
        /** @type {BlockMiningData[]} */
        this.blockMiningData = []; // .csv mining datas research

        this.miniLogger.log(`Blockchain instance created`, (m) => { console.info(m); });
    }
    /** @param {SnapshotSystem} snapshotSystem */
    async load(snapshotSystem) {
        // Ensure consistency between the blockchain and the snapshot system
        snapshotSystem.eraseSnapshotsHigherThan(this.currentHeight);

        const snapshotsHeights = snapshotSystem.getSnapshotsHeights();
        const olderSnapshotHeight = snapshotsHeights[0] ? snapshotsHeights[0] : 0;
        const youngerSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];
        const startHeight = isNaN(youngerSnapshotHeight) ? -1 : youngerSnapshotHeight;

        // Cache the blocks from the last snapshot +1 to the last block
        // cacheStart : 0, 11, 21, etc... (depending on the modulo)
        const snapModulo = snapshotSystem.snapshotHeightModulo;
        const cacheStart = olderSnapshotHeight > snapModulo ? olderSnapshotHeight - (snapModulo-1) : 0;
        this.#loadBlocksFromStorageToCache(cacheStart, startHeight);
        this.currentHeight = startHeight;
        this.lastBlock = this.getBlockByHeight(startHeight);

        // Cache + db cleanup
        this.blockStorage.removeBlocksHigherThan(startHeight);

        if (startHeight === -1) { this.reset(); } // no snapshot to load => reset the db

        return startHeight;
    }
    #loadBlocksFromStorageToCache(indexStart = 0, indexEnd = 9) {
        if (indexStart > indexEnd) { return; }

        for (let i = indexStart; i <= indexEnd; i++) {
            const block = this.getBlockByHeight(i);
            if (!block) { break; }

            this.#setBlockInCache(block);
        }

        this.miniLogger.log(`Blocks loaded from ${indexStart} to ${indexEnd}`, (m) => { console.debug(m); });
    }
    /** @param {BlockData} block */
    #setBlockInCache(block) {
        this.cache.blocksByHash.set(block.hash, block);
        this.cache.blocksHashByHeight.set(block.index, block.hash);
        this.cache.blockHeightByHash.set(block.hash, block.index);
    }
    /** Adds a new confirmed block to the blockchain.
     * @param {UtxoCache} utxoCache - The UTXO cache to use for the block.
     * @param {BlockData} block - The block to add.
     * @param {boolean} [persistToDisk=true] - Whether to persist the block to disk.
     * @param {boolean} [saveBlockInfo=true] - Whether to save the block info.
     * @param {Object<string, string>} [blockPubKeysAddresses] - The block public keys and addresses.
     * @throws {Error} If the block is invalid or cannot be added. */
    async addConfirmedBlock(utxoCache, block, persistToDisk = true, saveBlockInfo = true, totalFees) {
        this.miniLogger.log(`Adding new block: blockHeight=${block.index}, blockHash=${block.hash}`, (m) => { console.info(m); });
        try {
            const blockInfo = saveBlockInfo ? await BlockUtils.getFinalizedBlockInfo(utxoCache, block, totalFees) : undefined;
            
            this.#setBlockInCache(block);
            this.lastBlock = block;
            this.currentHeight = block.index;

            const promises = [];
            if (persistToDisk) { promises.push(this.#persistBlockToDisk(block)); }
            if (saveBlockInfo) { promises.push(this.#persistBlockInfoToDisk(blockInfo)) }

            await Promise.all(promises);

            this.miniLogger.log(`Block successfully added: blockHeight=${block.index}, blockHash=${block.hash}`, (m) => { console.info(m); });
            return blockInfo;
        } catch (error) {
            this.miniLogger.log(`Failed to add block: blockHash=${block.hash}, error=${error}`, (m) => { console.error(m); });
            throw error;
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

        this.miniLogger.log(`Cache erasable from ${oldestHeight} to ${erasableUntil}`, (m) => { console.debug(m); });
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

        this.miniLogger.log(`Cache erased from ${fromHeight} to ${erasedUntil}`, (m) => { console.debug(m); });
        return { from: fromHeight, to: erasedUntil };
    }
    /** Applies the changes from added blocks to the UTXO cache and VSS.
    * @param {UtxoCache} utxoCache - The UTXO cache to update.
    * @param {Vss} vss - The VSS to update.
    * @param {BlockData} block - The block to apply.
    * @param {boolean} [storeAddAddressAnchors=false] - Whether to store added address anchors. */
    async applyBlock(utxoCache, vss, block, storeAddAddressAnchors = false) {
        const blockDataCloneToDigest = BlockUtils.cloneBlockData(block); // clone to avoid modification
        try {
            const newStakesOutputs = await utxoCache.digestFinalizedBlocks([blockDataCloneToDigest], storeAddAddressAnchors);
            this.blockMiningData.push({ index: block.index, difficulty: block.difficulty, timestamp: block.timestamp, posTimestamp: block.posTimestamp });
            vss.newStakes(newStakesOutputs);
        } catch (error) {
            this.miniLogger.log(`Failed to apply block: blockHash=${block.hash}, error=${error}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /** @param {BlockData} finalizedBlock */
    async #persistBlockToDisk(finalizedBlock) {
        this.miniLogger.log(`Persisting block to disk: blockHash=${finalizedBlock.hash}`, (m) => { console.debug(m); });
        this.blockStorage.addBlock(finalizedBlock);
    }
    /** @param {BlockInfo} blockInfo */
    async #persistBlockInfoToDisk(blockInfo) {
        this.miniLogger.log(`Persisting block info to disk: blockHash=${blockInfo.header.hash}`, (m) => { console.debug(m); });
        this.blockStorage.addBlockInfo(blockInfo);
    }
    /** @param {MemPool} memPool @param {number} indexStart @param {number} indexEnd */
    async persistAddressesTransactionsReferencesToDisk(memPool, indexStart, indexEnd) { // DEPRECATED
        return; // disabled

        indexStart = Math.max(0, indexStart);
        if (indexStart > indexEnd) { return; }

        const addressesTxsRefsSnapHeightSerialized = await this.db.get('addressesTxsRefsSnapHeight').catch(() => null);
        const addressesTxsRefsSnapHeight = addressesTxsRefsSnapHeightSerialized ? this.fastConverter.uint86BytesToNumber(addressesTxsRefsSnapHeightSerialized) : -1;
        if (addressesTxsRefsSnapHeight >= indexEnd) { console.info(`[DB] Addresses transactions already persisted to disk: snapHeight=${addressesTxsRefsSnapHeight} / indexEnd=${indexEnd}`); return; }

        /** @type {Object<string, string[]>} */
        const actualizedAddressesTxsRefs = {};
        for (let i = indexStart; i <= indexEnd; i++) {
            const finalizedBlock = this.getBlockByHeight(i);
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
                    const deserialized = serializerFast.deserialize.txsReferencesArray(serialized);
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

            const serialized = serializerFast.serialize.txsReferencesArray(actualizedAddressTxsRefs);
            batch.put(`${address}-txs`, Buffer.from(serialized));
            batch.put('addressesTxsRefsSnapHeight', Buffer.from(this.fastConverter.numberTo6BytesUint8Array(indexEnd)));
        }

        if (totalDuplicates > 0) { this.miniLogger.log(`[DB] ${totalDuplicates} duplicate txs references found and removed`, (m) => { console.warn(m); }); }
        await batch.write();
            
        this.miniLogger.log(`Addresses transactions persisted to disk from ${indexStart} to ${indexEnd} (included)`, (m) => { console.info(m); });
    }
    /** @param {MemPool} memPool @param {string} address @param {number} [from=0] @param {number} [to=this.currentHeight] */
    async getTxsReferencesOfAddress(memPool, address, from = 0, to = this.currentHeight) { // DEPRECATED
        return []; // disabled

        const cacheStartIndex = this.cache.oldestBlockHeight();

        // try to get the txs references from the DB first
        let txsRefs = [];
        try {
            if (from >= cacheStartIndex) { throw new Error('Data in cache, no need to get from disk'); }

            const txsRefsSerialized = await this.db.get(`${address}-txs`);
            txsRefs = serializerFast.deserialize.txsReferencesArray(txsRefsSerialized);
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
            const blockData = this.getBlockByHeight(i, deserialize);
            if (!blockData) { break; }
            blocksData.push(blockData);
        }
        return blocksData;
    }
    /** Retrieves a block by its height. @param {number} height - The height of the block to retrieve. */
    getBlockByHeight(height, deserialize = true) {
        if (deserialize && this.cache.blocksHashByHeight.has(height)) {
            return this.cache.blocksByHash.get(this.cache.blocksHashByHeight.get(height));
        }

        const block = this.blockStorage.getBlockByIndex(height, deserialize);
        if (block) { return block; }

        this.miniLogger.log(`Block not found: blockHeight=${height}`, (m) => { console.error(m); });
        return null;
    }
    getBlockByHash(hash) {
        const block = this.cache.blocksByHash.has(hash)
        ? this.cache.blocksByHash.get(hash)
        : this.blockStorage.getBlockByHash(hash);

        if (block) { return block; }

        this.miniLogger.log(`Block not found: blockHash=${hash}`, (m) => { console.error(m); });
        throw new Error(`Block not found: ${hash}`);
    }
    getBlockInfoByHeight(height = 0) {
        return this.blockStorage.getBlockInfoByIndex(height);
    }
    /** @param {string} txReference - The transaction reference in the format "height:txId" */
    async getTransactionByReference(txReference) {
        const [height, txId] = txReference.split(':');
        try {
            /** @type {BlockData} */
            const block = this.getBlockByHeight(parseInt(height, 10));
            if (!block) { throw new Error('Block not found'); }

            const tx = block.Txs.find(tx => tx.id === txId);
            if (!tx) { throw new Error('Transaction not found'); }

            return tx;
        } catch (error) {
            this.miniLogger.log(`${txReference} => ${error.message}`, (m) => { console.error(m); });
            return null;
        }
    }
    /** @param {Uint8Array} serializedTx - The serialized transaction data */
    deserializeTransaction(serializedTx) {
        try { // Try fast deserialization first.
            return serializerFast.deserialize.transaction(serializedTx);
        } catch (error) {
            this.miniLogger.log(`Failed to fast deserialize transaction: error=${error}`, (m) => { console.debug(m); });
        }

        try { // Try the special transaction deserialization if fast deserialization fails.
            return serializer.transaction.fromBinary_v2(serializedTx);
        } catch (error) {
            this.miniLogger.log(`Failed to deserialize special transaction: error=${error}`, (m) => { console.debug(m); });
        }

        this.miniLogger.log('Unable to deserialize transaction using available strategies', (m) => { console.error(m); });
        return null;
    }
    
    /** @returns {string} The hash of the latest block */
    getLastBlockHash() {
        return this.lastBlock ? this.lastBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000";
    }
    reset() {
        this.blockStorage.reset();
        this.miniLogger.log('Database erased', (m) => { console.info(m); });
    }
}