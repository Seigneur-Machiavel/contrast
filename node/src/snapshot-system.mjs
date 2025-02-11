import fs from 'fs';
import path from 'path';
import { Storage, BlockchainStorage, PATH, copyFolderRecursiveSync } from '../../utils/storage-manager.mjs';
import { FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { BlockData, BlockUtils } from './block-classes.mjs';
import { HashFunctions } from './conCrypto.mjs';

/**
* @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
* @typedef {import("./vss.mjs").Vss} Vss
* @typedef {import("./memPool.mjs").MemPool} MemPool
*/

/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
function readSnapshotsHeightsOfDir(dirPath = '') {
	const snapshotDirs = fs.readdirSync(dirPath);
	if (snapshotDirs.length === 0) { return []; }
	
	// clean malformed snapshots
	for (const snapshotDir of snapshotDirs) {
		const snapshotPath = path.join(dirPath, snapshotDir);
		const files = fs.readdirSync(snapshotPath);
		let missingFiles = [];
		if (!files.includes('memPool.bin')) { missingFiles.push('memPool.bin'); }
		if (!files.includes('utxoCache.bin')) { missingFiles.push('utxoCache.bin'); }
		if (!files.includes('vss.bin')) { missingFiles.push('vss.bin'); }
		if (missingFiles.length === 0) { continue; }

		console.error(`Erasing malformed snapshot #${snapshotDir} | missing files: ${missingFiles.join(', ')}`);
		fs.rmSync(snapshotPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
	}

	// read heights and sort them in ascending order
	const snapshotsHeights = [];
	for (const snapshotDir of snapshotDirs) { snapshotsHeights.push(Number(snapshotDir)); }
	return snapshotsHeights.sort((a, b) => a - b);
}

export class SnapshotSystem {
	fastConverter = new FastConverter();
	loadedSnapshotHeight = 0;
	snapshotHeightModulo = 5;
	snapshotToConserve = 10;
	knownPubKeysAddressesSnapInfo = { height: 0, hash: '' };
	
	// SNAPSHOTS
	mySnapshotsHeights() {
		return readSnapshotsHeightsOfDir(PATH.SNAPSHOTS);
	}
	/** Save a snapshot of the current state of the blockchain's utxoCache and vss
	 * @param {UtxoCache} utxoCache 
	 * @param {Vss} vss 
	 * @param {MemPool} memPool */
	newSnapshot(utxoCache, vss, memPool) {
		const logPerf = false;
		const height = utxoCache.blockchain.currentHeight;
		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);
		if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }

		performance.mark('startSaveVssSpectrum'); // SAVE VSS SPECTRUM
		const serializedSpectum = serializer.serialize.rawData(vss.spectrum);
		Storage.saveBinary('vss', serializedSpectum, heightPath);
		performance.mark('endSaveVssSpectrum');

		performance.mark('startSaveMemPool'); // SAVE MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = serializer.serialize.pubkeyAddressesObj(memPool.knownPubKeysAddresses);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		Storage.saveBinary('memPool', serializedPKAddresses, heightPath);
		performance.mark('endSaveMemPool');

		performance.mark('startSaveUtxoCache'); // SAVE UTXO CACHE
		const totalOfBalancesSerialized = this.fastConverter.numberTo6BytesUint8Array(utxoCache.totalOfBalances);
		const totalSupplySerialized = this.fastConverter.numberTo6BytesUint8Array(utxoCache.totalSupply);
		const miniUTXOsSerialized = serializer.serialize.miniUTXOsObj(utxoCache.unspentMiniUtxos);

		const utxoCacheDataSerialized = new Uint8Array(6 + 6 + miniUTXOsSerialized.length);
		utxoCacheDataSerialized.set(totalOfBalancesSerialized);
		utxoCacheDataSerialized.set(totalSupplySerialized, 6);
		utxoCacheDataSerialized.set(miniUTXOsSerialized, 12);
		Storage.saveBinary('utxoCache', utxoCacheDataSerialized, heightPath);
		performance.mark('endSaveUtxoCache');

		if (logPerf) {
			performance.mark('newSnapshot end');
			performance.measure('\nsaveMemPool', 'startSaveMemPool', 'endSaveMemPool');
			performance.measure('saveVssSpectrum', 'startSaveVssSpectrum', 'endSaveVssSpectrum');
			performance.measure('saveUtxoCache', 'startSaveUtxoCache', 'endSaveUtxoCache');
			performance.measure('totalSnapshot', 'startSaveVssSpectrum', 'newSnapshot end');
		}
	}
	/** Roll back to a previous snapshot, will fill the utxoCache and vss with the data from the snapshot
	 * @param {number} height 
	 * @param {UtxoCache} utxoCache 
	 * @param {Vss} vss 
	 * @param {MemPool} memPool */
	rollBackTo(height, utxoCache, vss, memPool) {
		const logPerf = true;
		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);

		performance.mark('startLoadSpectrum'); // LOAD VSS SPECTRUM
		const serializedSpectrum = Storage.loadBinary('vss', heightPath);
		vss.spectrum = serializer.deserialize.rawData(serializedSpectrum);
		performance.mark('endLoadSpectrum');

		performance.mark('startLoadMemPool'); // LOAD MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = Storage.loadBinary('memPool', heightPath);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		memPool.knownPubKeysAddresses = serializer.deserialize.pubkeyAddressesObj(serializedPKAddresses);
		performance.mark('endLoadMemPool');

		performance.mark('startLoadUtxoCache'); // LOAD UTXO CACHE
		const utxoCacheDataSerialized = Storage.loadBinary('utxoCache', heightPath);
		utxoCache.totalOfBalances = this.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(0, 6));
		utxoCache.totalSupply = this.fastConverter.uint86BytesToNumber(utxoCacheDataSerialized.subarray(6, 12));
		//const deserializationStart = performance.now();
		utxoCache.unspentMiniUtxos = serializer.deserialize.miniUTXOsObj(utxoCacheDataSerialized.subarray(12));
		//const deserializationEnd = performance.now();
		//if (logPerf) { console.log(`Deserialization time: ${deserializationEnd - deserializationStart}ms`); }
		performance.mark('endLoadUtxoCache');

		performance.mark('buildAddressesAnchorsFromUnspentMiniUtxos');
		utxoCache.buildAddressesAnchorsFromUnspentMiniUtxos();
		performance.mark('endBuildAddressesAnchorsFromUnspentMiniUtxos');
		if (logPerf) {
			performance.mark('rollBackTo end');
			performance.measure('loadSpectrum', 'startLoadSpectrum', 'endLoadSpectrum');
			performance.measure('loadMemPool', 'startLoadMemPool', 'endLoadMemPool');
			performance.measure('loadUtxoCache', 'startLoadUtxoCache', 'endLoadUtxoCache');
			performance.measure('buildAddressesAnchorsFromUnspentMiniUtxos', 'buildAddressesAnchorsFromUnspentMiniUtxos', 'endBuildAddressesAnchorsFromUnspentMiniUtxos');
			performance.measure('totalRollBack', 'startLoadSpectrum', 'rollBackTo end');
		}

		this.loadedSnapshotHeight = height;
		return true;
	}
	/** Erase a snapshot @param {number} height */
	#moveSnapshotToTrash(height) {
		const targetPath = path.join(PATH.SNAPSHOTS, `${height}`);
		const trashTargetPath = path.join(PATH.TRASH, `${height}`);
		fs.renameSync(targetPath, trashTargetPath);
		
		console.info(`Snapshot #${height} moved to trash`);
	}
	/** Move all snapshots with a height higher than the given one to trash @param {number} height */
	moveSnapshotsHigherThanHeightToTrash(height) {
		for (const snapHeight of this.mySnapshotsHeights()) {
			if (snapHeight > height) { this.#moveSnapshotToTrash(snapHeight); }
		}
	}
	/** Move all snapshots with a height lower than the given one to trash @param {number} height */
	moveSnapshotsLowerThanHeightToTrash(height) {
		for (const snapHeight of this.mySnapshotsHeights()) {
			if (snapHeight < height) { this.#moveSnapshotToTrash(snapHeight); }
		}
	}
	/** Restore a snapshot from the trash */
	restoreLoadedSnapshot() {
		if (this.loadedSnapshotHeight === 0) { return false; }

		const targetPath = path.join(PATH.SNAPSHOTS, `${this.loadedSnapshotHeight}`);
		const trashTargetPath = path.join(PATH.TRASH, `${this.loadedSnapshotHeight}`);

		if (!fs.existsSync(trashTargetPath)) { return false; } // trash snapshot not found
		if (fs.existsSync(targetPath)) {
			if (!overwrite) { return false; }
			fs.rmSync(targetPath, { recursive: true, force: true }, (err) => { if (err) { console.error(err); } });
		}

		fs.renameSync(trashTargetPath, targetPath);
		console.info(`Snapshot #${this.loadedSnapshotHeight} restored from trash`);
	}
}

export class CheckpointSystem {
	/** @type {boolean | number} */
	activeCheckpointHeight = false;
	/** @type {boolean | number} */
	activeCheckpointLastSnapshotHeight = false;
	activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // hash of block -1
	activeCheckpointPath = path.join(PATH.STORAGE, 'ACTIVE_CHECKPOINT');

	minGapTryCheckpoint = 720; // 24h
	checkpointHeightModulo = 100;
	checkpointToConserve = 10;
	lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
	rndControlDiceFaces = 12;

	// MY CHECKPOINTS
	#getCheckpointsInfos() {
		/** @type {{ heights: number[], hashes: { [height: number]: string } }} */
		const result = { heights: [], hashes: {} };
		const dirs = fs.readdirSync(PATH.CHECKPOINTS);
		if (dirs.length === 0) { return result; }

		for (const dirName of dirs) {
			const height = Number(dirName);
			const files = fs.readdirSync(path.join(PATH.CHECKPOINTS, dirName));
			if (files.length !== 1) { console.error(`---! Checkpoint #${height} is corrupted !---`); continue; }

			result.heights.push(height);
			result.hashes[height] = files[0].split('.')[0];
		}

		result.heights.sort((a, b) => a - b);
		return result;
	}
	pruneCheckpoints(height = 1000) {
		let preservedCheckpoints = 0;
		for (const h of Object.keys(this.#getCheckpointsInfos().hashes)) {
			const maxCheckpointsReached = preservedCheckpoints >= this.checkpointToConserve;
			if (Number(h) < height && !maxCheckpointsReached) { preservedCheckpoints++; continue; }

			fs.rmSync(path.join(PATH.CHECKPOINTS, h), { recursive: true, force: true });
		}
	}
	newCheckpoint(height = 1000) {
		const hash = Storage.archiveCheckpoint(height); // save new checkpoint archive (.zip)
		if (typeof hash !== 'string') { console.error(`---! Checkpoint #${height} failed !---`); return false; }

		this.lastCheckpointInfo = { height, hash };
		return true;
	}
	readCheckpointZipArchive(archiveHash) {
		const checkpointsHashes = this.#getCheckpointsInfos().hashes;
		for (const height of Object.keys(checkpointsHashes)) {
			if (checkpointsHashes[height] !== archiveHash) { continue; }

			try {
				return fs.readFileSync( path.join(PATH.CHECKPOINTS, height, `${archiveHash}.zip`) );
			} catch (error) { console.error(error.stack); }
			return false;
		}
	}
	/** Read one time only if necessary, this.lastCheckpointInfo filled by: newCheckpoint() */
	myLastCheckpointInfo() {
		if (!this.lastCheckpointInfo.height) {
			const checkpointsInfos = this.#getCheckpointsInfos();
			if (checkpointsInfos.heights.length === 0) {
				this.lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
			} else {
				const lastHeight = checkpointsInfos.heights[checkpointsInfos.heights.length - 1];
				this.lastCheckpointInfo = { height: lastHeight, hash: checkpointsInfos.hashes[lastHeight] };
			}
		}

		return this.lastCheckpointInfo;
	}

	// ACTIVE CHECKPOINT
	checkForActiveCheckpoint() {
		if (!fs.existsSync(this.activeCheckpointPath)) { return false; }

		const checkpointSnapshotsPath = path.join(this.activeCheckpointPath, 'snapshots');
		if (!fs.existsSync(checkpointSnapshotsPath)) {
			console.error('Active checkpoint corrupted: snapshots folder missing');
			fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });
			return false;
		}

		const snapshotsHeights = readSnapshotsHeightsOfDir(checkpointSnapshotsPath);
		if (snapshotsHeights.length === 0) { return false; }
		
		this.activeCheckpointHeight = -1; // Set to -1 to indicate that the checkpoint is active (default: false)
		this.activeCheckpointLastSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];

		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		if (!fs.existsSync(checkpointBlocksPath)) { return true; } // exist but empty, need to sync missing blocks

		const blocksFoldersSorted = BlockchainStorage.getListOfFoldersInBlocksDirectory(checkpointBlocksPath);
		if (blocksFoldersSorted.length === 0) { return true; } // exist but empty, need to sync missing blocks

		const lastBlockFolder = blocksFoldersSorted[blocksFoldersSorted.length - 1];
		const files = fs.readdirSync(path.join(checkpointBlocksPath, lastBlockFolder));
		if (!files.length) { return true; } // exist but empty, need to sync missing blocks
		
		for (let j = 0; j < files.length; j++) {
			const fileName = files[j].split('.')[0];
			const blockIndex = parseInt(fileName.split('-')[0], 10);
			const blockHash = fileName.split('-')[1];
			if (blockIndex <= this.activeCheckpointHeight) { continue; }

			this.activeCheckpointHeight = blockIndex;
			this.activeCheckpointHash = blockHash;
		}

		return true; // need to sync missing blocks
	}
	#randomDiceRoll(diceFaces = 6) { return Math.floor(Math.random() * diceFaces) + 1 === 1; }
	/** @param {BlockData} finalizedBlock @param {Uint8Array} serializedBlock */
	async fillActiveCheckpointWithBlock(finalizedBlock, serializedBlock) {
		if (this.activeCheckpointHeight === false) { throw new Error('(Checkpoint fill) Active checkpoint not set'); }
		if (this.activeCheckpointHeight + 1 !== finalizedBlock.index) { throw new Error(`(Checkpoint fill) Block index mismatch: ${this.activeCheckpointHeight + 1} !== ${finalizedBlock.index}`); }
		if (finalizedBlock.prevHash !== this.activeCheckpointHash) { throw new Error(`(Checkpoint fill) Block prevHash mismatch: ${finalizedBlock.prevHash} !== ${this.activeCheckpointHash}`); }

		// Hash verification, argon2 based, cost CPU time (~500ms)
		const verify = this.#randomDiceRoll(this.rndControlDiceFaces);
		if (verify) {
			const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock);
        	if (finalizedBlock.hash !== hex) { throw new Error(`(Checkpoint fill) Block hash mismatch: ${finalizedBlock.hash} !== ${hex}`); }
		}

		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(finalizedBlock.index).name;
		const batchFolderPath = path.join(checkpointBlocksPath, batchFolderName);
		if (!fs.existsSync(batchFolderPath)) { fs.mkdirSync(batchFolderPath, { recursive: true }); }

		const blockFileName = `${finalizedBlock.index}-${finalizedBlock.hash}`;
		if (!Storage.saveBinary(blockFileName, serializedBlock, batchFolderPath)) { throw new Error('(Checkpoint fill) Block file save failed'); }

		this.activeCheckpointHeight = finalizedBlock.index;
		this.activeCheckpointHash = finalizedBlock.hash;

		return true;
	}
	deployActiveCheckpoint() {
		if (this.activeCheckpointHeight === false) { throw new Error(`(Checkpoint deploy) Active checkpoint not set`); }
		if (this.activeCheckpointLastSnapshotHeight === false) { throw new Error(`(Checkpoint deploy) Active checkpoint last snapshot height not set`); }

		const txsRefsConfigDest = path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json')
		if (fs.existsSync(txsRefsConfigDest)) { fs.rmSync(txsRefsConfigDest, { force: true }); }
		if (fs.existsSync(PATH.BLOCKS)) { fs.rmSync(PATH.BLOCKS, { recursive: true, force: true }); }
		if (fs.existsSync(PATH.SNAPSHOTS)) { fs.rmSync(PATH.SNAPSHOTS, { recursive: true, force: true }); }
		if (fs.existsSync(PATH.TXS_REFS)) { fs.rmSync(PATH.TXS_REFS, { recursive: true, force: true }); }
		if (fs.existsSync(PATH.TRASH)) { fs.rmSync(PATH.TRASH, { recursive: true, force: true }); }

		fs.renameSync(path.join(this.activeCheckpointPath, 'blocks'), PATH.BLOCKS);
		fs.renameSync(path.join(this.activeCheckpointPath, 'snapshots'), PATH.SNAPSHOTS);
		fs.renameSync(path.join(this.activeCheckpointPath, 'addresses-txs-refs'), PATH.TXS_REFS);
		fs.renameSync(path.join(this.activeCheckpointPath, 'AddressesTxsRefsStorage_config.json'), txsRefsConfigDest);
		fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });

		this.activeCheckpointHeight = false;
		this.activeCheckpointLastSnapshotHeight = false;
		this.activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // hash of block -1
	}
}