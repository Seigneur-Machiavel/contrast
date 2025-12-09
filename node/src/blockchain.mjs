import { BlocksCache } from './blockchain-cache.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { BlockUtils } from './block.mjs';
import { BlockchainStorage, AddressesTxsRefsStorage } from '../../utils/storage.mjs';
import { SnapshotSystem } from './snapshot.mjs';
import { CheckpointSystem } from './checkpoint.mjs';

/**
* @typedef {import("./vss.mjs").Vss} Vss
* @typedef {import("./mempool.mjs").MemPool} MemPool
* @typedef {import("./utxo-cache.mjs").UtxoCache} UtxoCache
* @typedef {import("./node.mjs").ContrastNode} ContrastNode
* @typedef {import("../../types/block.mjs").BlockData} BlockData
* @typedef {import("../../types/block.mjs").BlockMiningData} BlockMiningData */

/** Represents the blockchain and manages its operations. */
export class Blockchain {
    miniLogger = new MiniLogger('blockchain');
    cache = new BlocksCache(this.miniLogger);
	blockStorage;
	snapshotSystem;
	checkpointSystem;
	addressesTxsRefsStorage;

	/** @type {BlockData | null} */		lastBlock = null;
	/** @type {BlockMiningData[]} */	blockMiningData = []; // .csv mining datas research

	/** @param {import('../../utils/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence. */
	constructor(storage) {
		if (!storage) return;
		this.blockStorage = new BlockchainStorage(storage);
		this.snapshotSystem = new SnapshotSystem(storage);
		this.checkpointSystem = new CheckpointSystem(storage, this.blockStorage, this.snapshotSystem.miniLogger);
		this.addressesTxsRefsStorage = new AddressesTxsRefsStorage(storage);
		this.currentHeight = this.blockStorage.lastBlockIndex;
	}

    async load() {
        // Ensure consistency between the blockchain and the snapshot system
        this.snapshotSystem.moveSnapshotsHigherThanHeightToTrash(this.currentHeight);

        const snapshotsHeights = this.snapshotSystem.mySnapshotsHeights();
        const olderSnapshotHeight = snapshotsHeights[0] ? snapshotsHeights[0] : 0;
        const youngerSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];
        const startHeight = isNaN(youngerSnapshotHeight) ? -1 : youngerSnapshotHeight;

        // Cache the blocks from the last snapshot +1 to the last block
        // cacheStart : 0, 11, 21, etc... (depending on the modulo)
        const snapModulo = this.snapshotSystem.snapshotHeightModulo;
        const cacheStart = olderSnapshotHeight > snapModulo ? olderSnapshotHeight - (snapModulo-1) : 0;
        this.#loadBlocksFromStorageToCache(cacheStart, startHeight);
        this.currentHeight = startHeight;
        this.lastBlock = startHeight < 0 ? null : this.getBlock(startHeight);

        this.blockStorage.removeBlocksHigherThan(startHeight); // Cache + db cleanup
        if (startHeight === -1) this.reset(); // no snapshot to load => reset the db
        return startHeight;
    }
    #loadBlocksFromStorageToCache(indexStart = 0, indexEnd = 9) {
        if (indexStart > indexEnd) return;

        for (let i = indexStart; i <= indexEnd; i++) {
            const block = this.getBlock(i);
            if (block) this.cache.addBlock(block);
			else break;
        }

        this.miniLogger.log(`Blocks loaded from ${indexStart} to ${indexEnd}`, (m, c) => console.debug(m, c));
    }
    /** Adds a new confirmed block to the blockchain.
     * @param {UtxoCache} utxoCache - The UTXO cache to use for the block.
     * @param {BlockData} block - The block to add.
     * @param {boolean} [persistToDisk=true] - Whether to persist the block to disk.
     * @param {boolean} [saveBlockInfo=true] - Whether to save the block info.
     * @param {Object<string, string>} [blockPubKeysAddresses] - The block public keys and addresses.
     * @throws {Error} If the block is invalid or cannot be added. */
    addConfirmedBlock(utxoCache, block, persistToDisk = true, saveBlockInfo = true, totalFees) {
        //this.miniLogger.log(`Adding new block: #${block.index}, blockHash=${block.hash.slice(0, 20)}...`, (m, c) => console.info(m, c));
		const blockInfo = saveBlockInfo ? BlockUtils.getFinalizedBlockInfo(utxoCache, block, totalFees) : undefined;
		if (persistToDisk) this.blockStorage.addBlock(block);
		if (saveBlockInfo) this.blockStorage.addBlockInfo(blockInfo);
		this.blockStorage.getBlockInfoByIndex(block.index);
		this.cache.addBlock(block);
		this.lastBlock = block;
		this.currentHeight = block.index;

		//this.miniLogger.log(`Block added: #${block.index}, hash=${block.hash.slice(0, 20)}...`, (m, c) => console.info(m, c));
		return blockInfo;
    }
    /** Applies the changes from added blocks to the UTXO cache and VSS.
    * @param {UtxoCache} utxoCache - The UTXO cache to update.
    * @param {Vss} vss - The VSS to update.
    * @param {BlockData} block - The block to apply.
    * @param {boolean} [storeAddAddressAnchors=false] - Whether to store added address anchors. */
    applyBlock(utxoCache, vss, block) {
        const blockDataCloneToDigest = BlockUtils.cloneBlockData(block); // clone to avoid modification
		const { newStakesOutputs, newUtxos, consumedUtxoAnchors } = utxoCache.preDigestFinalizedBlock(blockDataCloneToDigest);
		if (!vss.newStakes(newStakesOutputs, 'control')) throw new Error('VSS: Max supply reached during applyBlock().');
		utxoCache.digestFinalizedBlock(blockDataCloneToDigest, newUtxos, consumedUtxoAnchors);
		vss.newStakes(newStakesOutputs, 'persist');
		this.blockMiningData.push({ index: block.index, difficulty: block.difficulty, timestamp: block.timestamp, posTimestamp: block.posTimestamp });
    }
    /** @param {MemPool} memPool @param {number} indexStart @param {number} indexEnd */
    async persistAddressesTransactionsReferencesToDisk(memPool, indexStart, indexEnd) {
        let startIndex = JSON.parse(JSON.stringify(indexStart)); // deep copy to avoid mutation
        let existingSnapHeight = this.addressesTxsRefsStorage.snapHeight;
        ///if (existingSnapHeight === -1) existingSnapHeight = 0;

        // if the snapHeight is the same as the indexStart, we need to start from the next block
        if (existingSnapHeight === startIndex) startIndex += 1;
        if (existingSnapHeight +1 !== startIndex) {
            this.miniLogger.log(`Addresses transactions references snapHeight mismatch: ${existingSnapHeight} != ${indexStart}`, (m, c) => console.info(m, c));
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

        /** @type {Object<string, string[]>} */
        const actualizedAddrsTxsRefs = {};
        for (let i = startIndex; i <= indexEnd; i++) {
            const finalizedBlock = this.getBlock(i);
            if (!finalizedBlock) { console.error(`Block not found #${i}`); continue; }

            const transactionsReferencesSortedByAddress = BlockUtils.getFinalizedBlockTransactionsReferencesSortedByAddress(finalizedBlock, memPool.knownPubKeysAddresses);
			for (const address in transactionsReferencesSortedByAddress) {
                if (actualizedAddrsTxsRefs[address]) continue; // already loaded
                const startGTROA = performance.now();
                actualizedAddrsTxsRefs[address] = this.addressesTxsRefsStorage.getTxsReferencesOfAddress(address);
                totalGTROA_time += (performance.now() - startGTROA);
				await new Promise(resolve => setImmediate(resolve)); // breathing
            }

            for (const address in transactionsReferencesSortedByAddress) {
				const newTxsReferences = transactionsReferencesSortedByAddress[address];  
				const concatenated = actualizedAddrsTxsRefs[address].concat(newTxsReferences);
                actualizedAddrsTxsRefs[address] = concatenated;
                await new Promise(resolve => setImmediate(resolve)); // breathing
            }
        }

        let duplicateCountTime = 0;
        let totalRefs = 0;
        let totalDuplicates = 0;
        let savePromises = [];
        const saveStart = performance.now();
		for (const address in actualizedAddrsTxsRefs) {
            const actualizedAddressTxsRefs = actualizedAddrsTxsRefs[address];
            const cleanedTxsRefs = [];

            const duplicateStart = performance.now();
            const txsRefsDupiCounter = {};
            let duplicate = 0;
			for (const txRef of actualizedAddressTxsRefs) {
				if (txsRefsDupiCounter[txRef]) duplicate++;
                else cleanedTxsRefs.push(txRef);
                txsRefsDupiCounter[txRef] = true;
                totalRefs++;
            }
            totalDuplicates += duplicate;
            duplicateCountTime += (performance.now() - duplicateStart);

            savePromises.push(this.addressesTxsRefsStorage.setTxsReferencesOfAddress(address, cleanedTxsRefs, startIndex));
            await new Promise(resolve => setImmediate(resolve)); // breathing
        }

        await Promise.allSettled(savePromises);
        this.addressesTxsRefsStorage.save(indexEnd);
        const saveTime = performance.now() - saveStart;
        
        const logText = `AddressesTxsRefs persisted from #${startIndex} to #${indexEnd}(included) -> Duplicates: ${totalDuplicates}/${totalRefs}(${duplicateCountTime.toFixed(2)}ms) - TotalTime: ${(performance.now() - startTime).toFixed(2)}ms - GTROA: ${totalGTROA_time.toFixed(2)}ms - SaveTime: ${saveTime.toFixed(2)}ms`;
        this.miniLogger.log(logText, (m, c) => console.info(m, c));
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
    async getRangeOfBlocksByHeight(fromHeight, toHeight = 999_999_999, deserialize = true, includesInfo = false) {
        if (typeof fromHeight !== 'number' || typeof toHeight !== 'number') throw new Error('Invalid block range: not numbers');
        if (fromHeight > toHeight) throw new Error(`Invalid range: ${fromHeight} > ${toHeight}`);

        const blocks = [];
		const blocksInfo = [];
        for (let i = fromHeight; i <= toHeight; i++) {
            const blockData = this.getBlock(i, deserialize);
            if (!blockData) break;
            blocks.push(blockData);
			if (includesInfo) blocksInfo.push(this.blockStorage.getBlockInfoByIndex(i, deserialize));
			await new Promise(resolve => setImmediate(resolve)); // breathing
        }
        return { blocks, blocksInfo };
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

        this.miniLogger.log(`Block not found: blockHeightOrHash=${heightOrHash}`, (m, c) => console.info(m, c));
        return null;
    }
    /** Retrieve a transaction by its reference from cache(first) or disk(fallback). @param {string} txReference - The transaction reference in the format "height:txIndex" */
    getTransactionByReference(txReference, includeTimestamp = false) {
        const [height, txId] = txReference.split(':');
        const index = parseInt(height, 10);
        if (this.cache.blocksHashByHeight.has(index)) { // Try from cache first
            const block = this.cache.blocksByHash.get(this.cache.blocksHashByHeight.get(index));
			const tx = block.Txs[parseInt(txId, 10)];
            return tx ? { tx, timestamp: block.timestamp } : null;
        }

        try { return this.blockStorage.retreiveTx(txReference, includeTimestamp); } // Try from disk
        catch (error) { this.miniLogger.log(`${txReference} => ${error.message}`, (m, c) => console.info(m, c)); }

        return null;
    }
	/** @param {ContrastNode} node */
	async loadSnapshot(node, snapshotIndex = 0, eraseHigher = true) {
        const snapHeights = this.snapshotSystem.mySnapshotsHeights();
        const olderSnapHeight = snapHeights[0];
        const persistedHeight = olderSnapHeight - this.snapshotSystem.snapshotHeightModulo;

        if (snapshotIndex < 0) return persistedHeight;

        this.miniLogger.log(`Last known snapshot index: ${snapshotIndex}`, (m, c) => console.info(m, c));
        this.currentHeight = snapshotIndex;
        this.addressesTxsRefsStorage.pruneAllUpperThan(persistedHeight);
        // node.blockCandidate = null;
        await this.snapshotSystem.rollBackTo(snapshotIndex, node.utxoCache, node.vss, node.memPool);

        this.miniLogger.log(`Snapshot loaded: ${snapshotIndex}`, (m, c) => console.info(m, c));
        if (snapshotIndex < 1) { this.reset(); this.checkpointSystem?.resetCheckpoints() } // reset (:not: active) Checkpoints.

        this.lastBlock = this.getBlock(snapshotIndex);

        // place snapshot to trash folder, we can restaure it if needed
        if (eraseHigher) this.snapshotSystem.moveSnapshotsHigherThanHeightToTrash(snapshotIndex - 1);
        return persistedHeight;
    }
	/** @param {ContrastNode} node @param {BlockData} finalizedBlock */
    async saveSnapshot(node, finalizedBlock) {
        if (finalizedBlock.index === 0) return;
        if (finalizedBlock.index % this.snapshotSystem.snapshotHeightModulo !== 0) return;
		
        // erase the outdated blocks cache and persist the addresses transactions references to disk
        const eraseUnder = this.snapshotSystem.snapshotHeightModulo * this.snapshotSystem.snapshotToConserve;
        const cacheErasable = this.cache.erasableLowerThan(finalizedBlock.index - (eraseUnder - 1));
        if (cacheErasable !== null && cacheErasable.from < cacheErasable.to) {
            await this.persistAddressesTransactionsReferencesToDisk(node.memPool, cacheErasable.from, cacheErasable.to);
            node.updateState(`snapshot - erase cache #${cacheErasable.from} to #${cacheErasable.to}`);
            this.cache.eraseFromTo(cacheErasable.from, cacheErasable.to);
        }

        await this.snapshotSystem.newSnapshot(node.utxoCache, node.vss, node.memPool, true);
        this.snapshotSystem.moveSnapshotsLowerThanHeightToTrash(finalizedBlock.index - eraseUnder);
        // avoid gap between the loaded snapshot and the new one
        // at this stage we know that the loaded snapshot is consistent with the blockchain
        if (this.snapshotSystem.loadedSnapshotHeight < finalizedBlock.index - (eraseUnder*2))
            this.snapshotSystem.loadedSnapshotHeight = 0;

        this.snapshotSystem.restoreLoadedSnapshot();
    }
	/** @param {ContrastNode} node @param {BlockData} finalizedBlock */
    async saveCheckpoint(node, finalizedBlock, pruning = true) {
        if (finalizedBlock.index < 100) return;

        const startTime = performance.now();
        const snapshotGap = this.snapshotSystem.snapshotHeightModulo * this.snapshotSystem.snapshotToConserve; // 5 * 10 = 50
        // trigger example: #1050 - (5 * 10) % 100 === 0;
        const trigger = (finalizedBlock.index - snapshotGap) % this.checkpointSystem.checkpointHeightModulo === 0;
        if (!trigger) return;

        // oldest example: #1050 - (5 * 10) = 1000
        //const oldestSnapHeight = finalizedBlock.index - snapshotGap;
        const checkpointHeight = finalizedBlock.index - this.checkpointSystem.checkpointHeightModulo;
        node.updateState(`creating checkpoint #${checkpointHeight}`);
        const result = await this.checkpointSystem.newCheckpoint(checkpointHeight, this.snapshotSystem.snapshotHeightModulo);
        const logText = result ? 'SAVED Checkpoint:' : 'FAILED to SAVE checkpoint:';
        this.miniLogger.log(`${logText} ${checkpointHeight} in ${(performance.now() - startTime).toFixed(2)}ms`, (m, c) => console.info(m, c));
    
        if (pruning) this.checkpointSystem.pruneCheckpointsLowerThanHeight();
    }
    reset() {
        this.blockStorage.reset();
        this.addressesTxsRefsStorage.reset();
        this.miniLogger.log('Database erased', (m, c) => console.info(m, c));
    }
}