import { BlockchainStorage, AddressesTxsRefsStorage } from '../../utils/storage-manager.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { BlockUtils } from './block-classes.mjs';
import { BlockMiningData } from './block-classes.mjs';
import { FastConverter } from '../../utils/converters.mjs';
import { Breather } from '../../utils/breather.mjs';
import { BlocksCache } from './blockchain-cache.mjs';

/**
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
    cache = new BlocksCache(this.miniLogger);
    blockStorage = new BlockchainStorage();
    addressesTxsRefsStorage = new AddressesTxsRefsStorage();

    /** @param {string} nodeId - The ID of the node. */
    constructor(nodeId) {
        this.nodeId = nodeId;
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
        snapshotSystem.moveSnapshotsHigherThanHeightToTrash(this.currentHeight);

        const snapshotsHeights = snapshotSystem.mySnapshotsHeights();
        const olderSnapshotHeight = snapshotsHeights[0] ? snapshotsHeights[0] : 0;
        const youngerSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];
        const startHeight = isNaN(youngerSnapshotHeight) ? -1 : youngerSnapshotHeight;

        // Cache the blocks from the last snapshot +1 to the last block
        // cacheStart : 0, 11, 21, etc... (depending on the modulo)
        const snapModulo = snapshotSystem.snapshotHeightModulo;
        const cacheStart = olderSnapshotHeight > snapModulo ? olderSnapshotHeight - (snapModulo-1) : 0;
        this.#loadBlocksFromStorageToCache(cacheStart, startHeight);
        this.currentHeight = startHeight;
        this.lastBlock = startHeight < 0 ? null : this.getBlock(startHeight);

        // Cache + db cleanup
        this.blockStorage.removeBlocksHigherThan(startHeight);

        if (startHeight === -1) this.reset(); // no snapshot to load => reset the db
        return startHeight;
    }
    #loadBlocksFromStorageToCache(indexStart = 0, indexEnd = 9) {
        if (indexStart > indexEnd) return;

        for (let i = indexStart; i <= indexEnd; i++) {
            const block = this.getBlock(i);
            if (!block) break;

            this.cache.addBlock(block);
        }

        this.miniLogger.log(`Blocks loaded from ${indexStart} to ${indexEnd}`, (m) => { console.debug(m); });
    }
    /** Adds a new confirmed block to the blockchain.
     * @param {UtxoCache} utxoCache - The UTXO cache to use for the block.
     * @param {BlockData} block - The block to add.
     * @param {boolean} [persistToDisk=true] - Whether to persist the block to disk.
     * @param {boolean} [saveBlockInfo=true] - Whether to save the block info.
     * @param {Object<string, string>} [blockPubKeysAddresses] - The block public keys and addresses.
     * @throws {Error} If the block is invalid or cannot be added. */
    addConfirmedBlock(utxoCache, block, persistToDisk = true, saveBlockInfo = true, totalFees) {
        //this.miniLogger.log(`Adding new block: #${block.index}, blockHash=${block.hash.slice(0, 20)}...`, (m) => { console.info(m); });
        try {
            const blockInfo = saveBlockInfo ? BlockUtils.getFinalizedBlockInfo(utxoCache, block, totalFees) : undefined;
            
            if (persistToDisk) this.blockStorage.addBlock(block);
            if (saveBlockInfo) this.blockStorage.addBlockInfo(blockInfo);
            this.blockStorage.getBlockInfoByIndex(block.index);
            this.cache.addBlock(block);
            this.lastBlock = block;
            this.currentHeight = block.index;

            //this.miniLogger.log(`Block added: #${block.index}, hash=${block.hash.slice(0, 20)}...`, (m) => { console.info(m); });
            return blockInfo;
        } catch (error) {
            this.miniLogger.log(`Failed to add block: blockHash=${block.hash.slice(0, 20)}..., error=${error}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /** Applies the changes from added blocks to the UTXO cache and VSS.
    * @param {UtxoCache} utxoCache - The UTXO cache to update.
    * @param {Vss} vss - The VSS to update.
    * @param {BlockData} block - The block to apply.
    * @param {boolean} [storeAddAddressAnchors=false] - Whether to store added address anchors. */
    applyBlock(utxoCache, vss, block) {
        const blockDataCloneToDigest = BlockUtils.cloneBlockData(block); // clone to avoid modification
        try {
            const { newStakesOutputs, newUtxos, consumedUtxoAnchors } = utxoCache.preDigestFinalizedBlock(blockDataCloneToDigest);
            if (!vss.newStakesCanBeAdded(newStakesOutputs)) throw new Error('VSS: Max supply reached.');

            // here we are sure that the block can be applied
            utxoCache.digestFinalizedBlock(blockDataCloneToDigest, newUtxos, consumedUtxoAnchors);
            vss.newStakes(newStakesOutputs);
            this.blockMiningData.push({ index: block.index, difficulty: block.difficulty, timestamp: block.timestamp, posTimestamp: block.posTimestamp });
        } catch (error) {
            this.miniLogger.log(`Failed to apply block: blockHash=${block.hash}, error=${error}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /** @param {MemPool} memPool @param {number} indexStart @param {number} indexEnd */
    async persistAddressesTransactionsReferencesToDisk(memPool, indexStart, indexEnd, breathing = true) {
        let startIndex = JSON.parse(JSON.stringify(indexStart)); // deep copy to avoid mutation
        let existingSnapHeight = this.addressesTxsRefsStorage.snapHeight;
        ///if (existingSnapHeight === -1) existingSnapHeight = 0;

        // if the snapHeight is the same as the indexStart, we need to start from the next block
        if (existingSnapHeight === startIndex) startIndex += 1;
        if (existingSnapHeight +1 !== startIndex) {
            this.miniLogger.log(`Addresses transactions references snapHeight mismatch: ${existingSnapHeight} != ${indexStart}`, (m) => { console.error(m); });
            return;
        }
        
        const startTime = performance.now();
        let totalGTROA_time = 0;
        startIndex = Math.max(0, startIndex);
        if (startIndex > indexEnd) return;

        const addressesTxsRefsSnapHeight = this.addressesTxsRefsStorage.snapHeight;
        if (addressesTxsRefsSnapHeight >= indexEnd) {
            console.info(`[DB] Addresses transactions already persisted to disk: snapHeight=${addressesTxsRefsSnapHeight} / indexEnd=${indexEnd}`);
            return;
        }

        const breather = new Breather();

        /** @type {Object<string, string[]>} */
        const actualizedAddrsTxsRefs = {};
        for (let i = startIndex; i <= indexEnd; i++) {
            const finalizedBlock = this.getBlock(i);
            if (!finalizedBlock) { console.error(`Block not found #${i}`); continue; }

            const transactionsReferencesSortedByAddress = BlockUtils.getFinalizedBlockTransactionsReferencesSortedByAddress(finalizedBlock, memPool.knownPubKeysAddresses);
            for (const address of Object.keys(transactionsReferencesSortedByAddress)) {
                if (actualizedAddrsTxsRefs[address]) continue; // already loaded
                const startGTROA = performance.now();
                actualizedAddrsTxsRefs[address] = this.addressesTxsRefsStorage.getTxsReferencesOfAddress(address);
                totalGTROA_time += (performance.now() - startGTROA);
                if (breathing) await breather.breathe();
            }

            for (const [address, newTxsReferences] of Object.entries(transactionsReferencesSortedByAddress)) {
                const concatenated = actualizedAddrsTxsRefs[address].concat(newTxsReferences);
                actualizedAddrsTxsRefs[address] = concatenated;
                if (breathing) await breather.breathe();
            }
        }

        let duplicateCountTime = 0;
        let totalRefs = 0;
        let totalDuplicates = 0;
        let savePromises = [];
        const saveStart = performance.now();
        for (let i = 0; i < Object.keys(actualizedAddrsTxsRefs).length; i++) {
            const address = Object.keys(actualizedAddrsTxsRefs)[i];
            const actualizedAddressTxsRefs = actualizedAddrsTxsRefs[address];
            const cleanedTxsRefs = [];

            const duplicateStart = performance.now();
            const txsRefsDupiCounter = {};
            let duplicate = 0;
            for (let i = 0; i < actualizedAddressTxsRefs.length; i++) {
                totalRefs++;
                const txRef = actualizedAddressTxsRefs[i];
                if (txsRefsDupiCounter[txRef]) duplicate++;
                else cleanedTxsRefs.push(txRef);

                txsRefsDupiCounter[txRef] = true;
            }
            totalDuplicates += duplicate;
            duplicateCountTime += (performance.now() - duplicateStart);

            savePromises.push(this.addressesTxsRefsStorage.setTxsReferencesOfAddress(address, cleanedTxsRefs, startIndex));
            if (breathing) await breather.breathe();
        }

        await Promise.allSettled(savePromises);
        this.addressesTxsRefsStorage.save(indexEnd);
        const saveTime = performance.now() - saveStart;
        
        const logText = `AddressesTxsRefs persisted from #${startIndex} to #${indexEnd}(included) [${breather.breath} breaths] -> Duplicates: ${totalDuplicates}/${totalRefs}(${duplicateCountTime.toFixed(2)}ms) - TotalTime: ${(performance.now() - startTime).toFixed(2)}ms - GTROA: ${totalGTROA_time.toFixed(2)}ms - SaveTime: ${saveTime.toFixed(2)}ms`;
        this.miniLogger.log(logText, (m) => { console.info(m); });
    }
    /** @param {MemPool} memPool @param {string} address @param {number} [from=0] @param {number} [to=this.currentHeight] */
    getTxsReferencesOfAddress(memPool, address, from = 0, to = this.currentHeight) {
        const cacheStartIndex = this.cache.oldestBlockHeight();

        // try to get the txs references from the DB first
        let txsRefs = from >= cacheStartIndex ? [] : this.addressesTxsRefsStorage.getTxsReferencesOfAddress(address);

        // complete with the cache
        for (let index = cacheStartIndex; index <= to; index++) {
            const blockHash = this.cache.blocksHashByHeight.get(index);
            if (!blockHash) break;

            const block = this.cache.blocksByHash.get(blockHash);
            const transactionsReferencesSortedByAddress = BlockUtils.getFinalizedBlockTransactionsReferencesSortedByAddress(block, memPool.knownPubKeysAddresses);
            if (!transactionsReferencesSortedByAddress[address]) continue;

            const newTxsReferences = transactionsReferencesSortedByAddress[address];
            txsRefs = txsRefs.concat(newTxsReferences);
        }

        if (txsRefs.length === 0) return txsRefs;

        // remove duplicates
        const txsRefsDupiCounter = {};
        const txsRefsWithoutDuplicates = [];
        let duplicate = 0;
        for (let i = 0; i < txsRefs.length; i++) {
            if (txsRefsDupiCounter[txsRefs[i]]) { duplicate++; continue; }
            
            txsRefsDupiCounter[txsRefs[i]] = true;
            txsRefsWithoutDuplicates.push(txsRefs[i]);
        }

        if (duplicate > 0) console.warn(`[DB] ${duplicate} duplicate txs references found for address ${address}`);

        // filter to preserve only the txs references in the range
        let finalTxsRefs = [];
        for (let i = 0; i < txsRefsWithoutDuplicates.length; i++) {
            const txRef = txsRefsWithoutDuplicates[i];
            const height = parseInt(txRef.split(':')[0], 10);
            if (from > height) continue;

            finalTxsRefs = txsRefsWithoutDuplicates.slice(i);
            break;
        }
        for (let i = finalTxsRefs.length - 1; i >= 0; i--) {
            const txRef = finalTxsRefs[i];
            const height = parseInt(txRef.split(':')[0], 10);
            if (to < height) continue;

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
        if (typeof fromHeight !== 'number' || typeof toHeight !== 'number') throw new Error('Invalid block range: not numbers');
        if (fromHeight > toHeight) throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`);

        const blocksData = [];
        const breather = new Breather();
        for (let i = fromHeight; i <= toHeight; i++) {
            const blockData = this.getBlock(i, deserialize);
            if (!blockData) break;
            blocksData.push(blockData);
            await breather.breathe(); // breathing
        }
        return blocksData;
    }
    async getRangeOfBlocksInfoByHeight(fromHeight, toHeight = 999_999_999, deserialize = true) {
        if (typeof fromHeight !== 'number' || typeof toHeight !== 'number') throw new Error('Invalid block range: not numbers');
        if (fromHeight > toHeight) throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`);

        const blocksInfo = [];
        const breather = new Breather();
        for (let i = fromHeight; i <= toHeight; i++) {
            const blockInfo = this.blockStorage.getBlockInfoByIndex(i, deserialize);
            if (!blockInfo) break;
            blocksInfo.push(blockInfo);
            await breather.breathe(); // breathing
        }
        return blocksInfo;
    }
    /** Retrieves a block by its height or hash. (Trying from cache first then from disk) @param {number|string} heightOrHash */
    getBlock(heightOrHash, deserialize = true) {
        //const startTimestamp = performance.now();
        if (typeof heightOrHash !== 'number' && typeof heightOrHash !== 'string') return null;
        
        /** @type {BlockData} */
        let block;

        // try to get the block from the cache
        if (deserialize && typeof heightOrHash === 'number' && this.cache.blocksHashByHeight.has(heightOrHash))
            block = this.cache.blocksByHash.get(this.cache.blocksHashByHeight.get(heightOrHash));
        
        if (deserialize && typeof heightOrHash === 'string' && this.cache.blocksByHash.has(heightOrHash))
            block = this.cache.blocksByHash.get(heightOrHash);
        //const readCacheTime = (performance.now() - startTimestamp).toFixed(5);
        if (block) return block;

        // try to get the block from the storage
        block = this.blockStorage.retreiveBlock(heightOrHash, deserialize);
        //console.warn(`[DB] Read cache: ${readCacheTime}ms - [DB] getBlock: ${(performance.now() - startTimestamp).toFixed(5)}ms`);
        if (block) return block;

        this.miniLogger.log(`Block not found: blockHeightOrHash=${heightOrHash}`, (m) => { console.error(m); });
        return null;
    }
    /** @param {string} txReference - The transaction reference in the format "height:txId" */
    getTransactionByReference(txReference, includeTimestamp) {
        const [height, txId] = txReference.split(':');
        const index = parseInt(height, 10);
        
        if (this.cache.blocksHashByHeight.has(index)) { // Try from cache first
            const block = this.cache.blocksByHash.get(this.cache.blocksHashByHeight.get(index));
            const tx = block.Txs.find(tx => tx.id === txId);
            return tx ? { tx, timestamp: block.timestamp } : null;
        }

        try { return this.blockStorage.retreiveTx(txReference, includeTimestamp); } // Try from disk
        catch (error) { this.miniLogger.log(`${txReference} => ${error.message}`, (m) => { console.error(m); }); }

        return null;
    }
    reset() {
        this.blockStorage.reset();
        this.addressesTxsRefsStorage.reset();
        this.miniLogger.log('Database erased', (m) => { console.info(m); });
    }
}