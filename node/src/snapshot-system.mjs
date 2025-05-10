import fs from 'fs';
import path from 'path';
import { Storage, StorageAsync, BlockchainStorage, CheckpointsStorage, PATH, copyFolderRecursiveSync } from '../../utils/storage-manager.mjs';
import { FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { BlockData, BlockUtils } from './block-classes.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { Breather } from '../../utils/breather.mjs';

/**
* @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
* @typedef {import("./vss.mjs").Vss} Vss
* @typedef {import("./memPool.mjs").MemPool} MemPool
*/

/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
function readSnapshotsHeightsOfDir(dirPath = '') {
	const snapshotDirs = fs.readdirSync(dirPath).filter((file) => {
		const filePath = path.join(dirPath, file);
		return fs.statSync(filePath).isDirectory() && !isNaN(Number(file));
	});
	if (snapshotDirs.length === 0) return [];
	
	// remove malformed snapshots
	const snapshotsHeights = [];
	for (const snapshotDir of snapshotDirs) {
		const snapshotPath = path.join(dirPath, snapshotDir);
		const files = fs.readdirSync(snapshotPath);
		let missingFiles = [];
		if (!files.includes('memPool.bin')) missingFiles.push('memPool.bin');
		if (!files.includes('utxoCache.bin')) missingFiles.push('utxoCache.bin');
		if (!files.includes('vss.bin')) missingFiles.push('vss.bin');
		if (missingFiles.length === 0) snapshotsHeights.push(Number(snapshotDir));
		else {
			console.error(`Erasing malformed snapshot #${snapshotDir} | missing files: ${missingFiles.join(', ')}`);
			fs.rmSync(snapshotPath, { recursive: true, force: true }, (err) => { if (err) console.error(err.stack); });
		}
	}

	// read heights and sort them in ascending order
	return snapshotsHeights.sort((a, b) => a - b);
}

export class SnapshotSystem {
	fastConverter = new FastConverter();
	loadedSnapshotHeight = 0;
	snapshotHeightModulo = 5;
	snapshotToConserve = 10;
	knownPubKeysAddressesSnapInfo = { height: 0, hash: '' };
	
	/** Get the heights of the snapshots that are saved in the snapshot folder - sorted in ascending order */
	mySnapshotsHeights() { return readSnapshotsHeightsOfDir(PATH.SNAPSHOTS) }
	/** Save a snapshot of the current state of the blockchain's utxoCache and vss
	 * @param {UtxoCache} utxoCache 
	 * @param {Vss} vss 
	 * @param {MemPool} memPool */
	async newSnapshot(utxoCache, vss, memPool, logPerf = false) {
		const breather = new Breather();
		const height = utxoCache.blockchain.currentHeight;
		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);
		if (!fs.existsSync(heightPath)) { fs.mkdirSync(heightPath); }

		performance.mark('startSaveVssSpectrum'); // SAVE VSS SPECTRUM
		const serializedSpectum = serializer.serialize.rawData(vss.spectrum);
		//Storage.saveBinary('vss', serializedSpectum, heightPath);
		await StorageAsync.saveBinary('vss', serializedSpectum, heightPath);
		performance.mark('endSaveVssSpectrum');
		await breather.breathe();

		performance.mark('startSaveMemPool'); // SAVE MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		const serializedPKAddresses = serializer.serialize.pubkeyAddressesObj(memPool.knownPubKeysAddresses);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		//Storage.saveBinary('memPool', serializedPKAddresses, heightPath);
		await StorageAsync.saveBinary('memPool', serializedPKAddresses, heightPath);
		performance.mark('endSaveMemPool');
		await breather.breathe();

		performance.mark('startSaveUtxoCache'); // SAVE UTXO CACHE
		const utxoCacheDataSerialized = serializer.serialize.utxoCacheData(utxoCache);
		//Storage.saveBinary('utxoCache', utxoCacheDataSerialized, heightPath);
		await StorageAsync.saveBinary('utxoCache', utxoCacheDataSerialized, heightPath);
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
	async rollBackTo(height, utxoCache, vss, memPool) {
		if (height === 0) return false;
		
		const logPerf = true;
		const heightPath = path.join(PATH.SNAPSHOTS, `${height}`);

		performance.mark('startLoadSpectrum'); // LOAD VSS SPECTRUM
		//const serializedSpectrum = Storage.loadBinary('vss', heightPath);
		const serializedSpectrum = await StorageAsync.loadBinary('vss', heightPath);
		vss.spectrum = serializer.deserialize.rawData(serializedSpectrum);
		performance.mark('endLoadSpectrum');

		performance.mark('startLoadMemPool'); // LOAD MEMPOOL (KNOWN PUBKEYS-ADDRESSES)
		//const serializedPKAddresses = Storage.loadBinary('memPool', heightPath);
		const serializedPKAddresses = await StorageAsync.loadBinary('memPool', heightPath);
		this.knownPubKeysAddressesSnapInfo = { height, hash: HashFunctions.xxHash32(serializedPKAddresses) };
		memPool.knownPubKeysAddresses = serializer.deserialize.pubkeyAddressesObj(serializedPKAddresses);
		performance.mark('endLoadMemPool');

		performance.mark('startLoadUtxoCache'); // LOAD UTXO CACHE
		//const utxoCacheDataSerialized = Storage.loadBinary('utxoCache', heightPath);
		const utxoCacheDataSerialized = await StorageAsync.loadBinary('utxoCache', heightPath);
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
		if (fs.existsSync(trashTargetPath)) fs.rmSync(trashTargetPath, { recursive: true, force: true });
		fs.renameSync(targetPath, trashTargetPath);
		console.info(`Snapshot #${height} moved to trash`);
	}
	/** Move all snapshots with a height higher than the given one to trash @param {number} height */
	moveSnapshotsHigherThanHeightToTrash(height) {
		for (const snapHeight of this.mySnapshotsHeights())
			if (snapHeight > height) this.#moveSnapshotToTrash(snapHeight);
	}
	/** Move all snapshots with a height lower than the given one to trash @param {number} height */
	moveSnapshotsLowerThanHeightToTrash(height) {
		for (const snapHeight of this.mySnapshotsHeights())
			if (snapHeight < height) this.#moveSnapshotToTrash(snapHeight);
	}
	/** Restore a snapshot from the trash */
	restoreLoadedSnapshot(overwrite = false) {
		if (this.loadedSnapshotHeight === 0) return false;

		const targetPath = path.join(PATH.SNAPSHOTS, `${this.loadedSnapshotHeight}`);
		const trashTargetPath = path.join(PATH.TRASH, `${this.loadedSnapshotHeight}`);

		if (!fs.existsSync(trashTargetPath)) return false; // trash snapshot not found
		if (fs.existsSync(targetPath)) {
			if (!overwrite) return false;
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
	activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // fake hash
	activeCheckpointPath = path.join(PATH.STORAGE, 'ACTIVE_CHECKPOINT');

	minGapTryCheckpoint = 720; // 24h
	checkpointHeightModulo = 25;
	checkpointToConserve = 4;
	lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
	rndControlDiceFaces = 27; // 1 in 27 chance to verify the block hash

	// MY CHECKPOINTS
	#getCheckpointsInfos() {
		/** @type {{ heights: number[], hashes: { [height: number]: string } }} */
		const result = { heights: [], hashes: {} };
		const dirs = fs.readdirSync(PATH.CHECKPOINTS);
		if (dirs.length === 0) return result;

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
	pruneCheckpointsLowerThanHeight(height = 0) { // dangerous to prune checkpoints, use with caution
		const result = { erased: [], preserved: [] };
		const descendingHeights = this.#getCheckpointsInfos().heights.reverse();
		for (const h of descendingHeights) {
			const maxCheckpointsReached = result.preserved.length >= this.checkpointToConserve;
			if (h > height && !maxCheckpointsReached) { result.preserved.push(h); continue; }

			fs.rmSync(path.join(PATH.CHECKPOINTS, h.toString()), { recursive: true, force: true });
			result.erased.push(h);
		}

		if (result.erased.length === 0) return; // no need to log
		console.info(`Checkpoints pruned | erased: ${result.erased.join(', ')} | preserved: ${result.preserved.join(', ')}`);
	}
	async newCheckpoint(height = 1000, snapshotHeightModulo, fromPath, overwrite = false) {
		// We prefer to not overwrite existing checkpoints, but it's possible to force it
		//! The danger is to overwrite a valid checkpoint with a corrupted one:
		//! The "addresses-txs-refs" as been removed from checkpoints
		const heightPath = path.join(PATH.CHECKPOINTS, height.toString());
		if (fs.existsSync(heightPath)) { console.error(`---! Checkpoint #${height} already exists (overwrite: ${overwrite}) !---`); return false; }
		if (fs.existsSync(heightPath) && !overwrite) { return false; }

		const snapshotsPath = fromPath ? path.join(fromPath, 'snapshots') : PATH.SNAPSHOTS;
		const snapshotsHeights = readSnapshotsHeightsOfDir(snapshotsPath);
		const neededSnapHeights = [
			height,
			height - snapshotHeightModulo,
			height - (snapshotHeightModulo * 2)
		];
		const hash = await CheckpointsStorage.archiveCheckpoint(height, fromPath, snapshotsHeights, neededSnapHeights); // save new checkpoint archive (.zip)
		if (typeof hash !== 'string') { console.error(`---! Checkpoint #${height} failed !---`); return false; }

		this.lastCheckpointInfo = { height, hash };
		return true;
	}
	readCheckpointZipArchive(archiveHash) {
		const checkpointsHashes = this.#getCheckpointsInfos().hashes;
		for (const height of Object.keys(checkpointsHashes)) {
			if (checkpointsHashes[height] !== archiveHash) continue;

			try { return fs.readFileSync( path.join(PATH.CHECKPOINTS, height, `${archiveHash}.zip`) ) }
			catch (error) { console.error(error.stack); return false }
		}
	}
	/** Read one time only if necessary, this.lastCheckpointInfo filled by: newCheckpoint () */
	myLastCheckpointInfo() {
		if (!this.lastCheckpointInfo.height) {
			const checkpointsInfos = this.#getCheckpointsInfos();
			if (checkpointsInfos.heights.length === 0)
				this.lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
			else {
				const lastHeight = checkpointsInfos.heights[checkpointsInfos.heights.length - 1];
				this.lastCheckpointInfo = { height: lastHeight, hash: checkpointsInfos.hashes[lastHeight] };
			}
		}

		return this.lastCheckpointInfo;
	}

	// ACTIVE CHECKPOINT
	#randomDiceRoll(diceFaces = 27) { return Math.floor(Math.random() * diceFaces) + 1 === 1; }
	checkForActiveCheckpoint() {
		if (!fs.existsSync(this.activeCheckpointPath)) return false;

		const checkpointSnapshotsPath = path.join(this.activeCheckpointPath, 'snapshots');
		if (!fs.existsSync(checkpointSnapshotsPath)) {
			console.error('Active checkpoint corrupted: snapshots folder missing');
			fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });
			return false;
		}

		const snapshotsHeights = readSnapshotsHeightsOfDir(checkpointSnapshotsPath);
		if (snapshotsHeights.length === 0) return false;
		
		this.activeCheckpointHeight = -1; // Set to -1 to indicate that the checkpoint is active (default: false)
		this.activeCheckpointLastSnapshotHeight = snapshotsHeights[snapshotsHeights.length - 1];

		const checkpointBlocksPath = path.join(this.activeCheckpointPath, 'blocks');
		if (!fs.existsSync(checkpointBlocksPath)) return true; // exist but empty, need to sync missing blocks

		const blocksFoldersSorted = BlockchainStorage.getListOfFoldersInBlocksDirectory(checkpointBlocksPath);
		if (blocksFoldersSorted.length === 0) return true; // exist but empty, need to sync missing blocks

		const lastBlockFolder = blocksFoldersSorted[blocksFoldersSorted.length - 1];
		const files = fs.readdirSync(path.join(checkpointBlocksPath, lastBlockFolder));
		if (!files.length) return true; // exist but empty, need to sync missing blocks
		
		for (let j = 0; j < files.length; j++) {
			const fileName = files[j].split('.')[0];
			const blockIndex = parseInt(fileName.split('-')[0], 10);
			const blockHash = fileName.split('-')[1];
			if (blockIndex <= this.activeCheckpointHeight) continue;

			this.activeCheckpointHeight = blockIndex;
			this.activeCheckpointHash = blockHash;
		}

		return true; // need to sync missing blocks
	}
	async migrateBlocksToActiveCheckpoint(stopAt = -1100) {
		if (this.activeCheckpointHeight !== -1) return false; // checkpoint not active or not "init state"
	
		const blocksFoldersSorted = BlockchainStorage.getListOfFoldersInBlocksDirectory();
		for (const folderName of blocksFoldersSorted) {
			const folderPath = path.join(PATH.BLOCKS, folderName);
			if (!fs.existsSync(folderPath)) break;
			
			const files = fs.readdirSync(folderPath);
			if (!files.length || files.length <= 0) break;

			let lastBlockIndex = -1;
			let lastBlockHash = '';
			for (let j = 0; j < files.length; j++) {
				const fileName = files[j].split('.')[0];
				const index = parseInt(fileName.split('-')[0], 10);
				if (index >= this.activeCheckpointLastSnapshotHeight + stopAt) {
					fs.rmSync(path.join(folderPath, files[j]), { force: true });
					continue; // remove the block file, not needed
				}
				
				lastBlockIndex = index;
				lastBlockHash = fileName.split('-')[1];
			}

			if (lastBlockIndex === -1) break; // no more blocks to migrate

			// MOVE THE FOLDER TO THE ACTIVE CHECKPOINT
			const infoFolderPath = path.join(PATH.BLOCKS_INFO, folderName);
			if (!fs.existsSync(infoFolderPath)) break; // no more blocks to migrate, missing info folder
			if (!fs.existsSync(path.join(this.activeCheckpointPath, 'blocks'))) fs.mkdirSync(path.join(this.activeCheckpointPath, 'blocks'), { recursive: true });
			if (!fs.existsSync(path.join(this.activeCheckpointPath, 'blocks-info'))) fs.mkdirSync(path.join(this.activeCheckpointPath, 'blocks-info'), { recursive: true });
			fs.renameSync(folderPath, path.join(this.activeCheckpointPath, 'blocks', folderName));
			fs.renameSync(infoFolderPath, path.join(this.activeCheckpointPath, 'blocks-info', folderName)); // move info folder

			console.info(`Checkpoint migration: moved folder ${folderName} to active checkpoint`);
			this.activeCheckpointHeight = lastBlockIndex;
			this.activeCheckpointHash = lastBlockHash;
		}

		// ENSURE ALL BLOCKS FOLDERS DELETION
		for (const folderName of fs.readdirSync(PATH.BLOCKS)) fs.rmSync(path.join(PATH.BLOCKS, folderName), { recursive: true, force: true });
		for (const folderName of fs.readdirSync(PATH.BLOCKS_INFO)) fs.rmSync(path.join(PATH.BLOCKS_INFO, folderName), { recursive: true, force: true });
	}
	/** @param {BlockData} finalizedBlock @param {Uint8Array} serializedBlock @param {Uint8Array} serializedBlockInfo */
	#saveBlockBinary(finalizedBlock, serializedBlock, serializedBlockInfo) {
		const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(finalizedBlock.index).name;
		const batchFolderPath = path.join(this.activeCheckpointPath, 'blocks', batchFolderName);
		const infoBatchFolderPath = path.join(this.activeCheckpointPath, 'blocks-info', batchFolderName);
		const blockFileName = `${finalizedBlock.index}-${finalizedBlock.hash}`;
		
		if (fs.existsSync(path.join(batchFolderPath, `${blockFileName}.bin`))) fs.rmSync(path.join(batchFolderPath, `${blockFileName}.bin`), { force: true });
		if (fs.existsSync(path.join(infoBatchFolderPath, `${blockFileName}.bin`))) fs.rmSync(path.join(infoBatchFolderPath, `${blockFileName}.bin`), { force: true });
		
		if (!fs.existsSync(batchFolderPath)) fs.mkdirSync(batchFolderPath, { recursive: true });
		if (!fs.existsSync(infoBatchFolderPath)) fs.mkdirSync(infoBatchFolderPath, { recursive: true });

		if (!Storage.saveBinary(blockFileName, serializedBlock, batchFolderPath)) throw new Error('(Checkpoint fill) Block file save failed');
		if (!Storage.saveBinary(blockFileName, serializedBlockInfo, infoBatchFolderPath)) throw new Error('(Checkpoint fill) Block info file save failed');
	}
	/** @param {BlockData} finalizedBlock @param {Uint8Array} serializedBlock @param {Uint8Array} serializedBlockInfo */
	async fillActiveCheckpointWithBlock(finalizedBlock, serializedBlock, serializedBlockInfo) {
		if (this.activeCheckpointHeight === false) throw new Error('(Checkpoint fill) Active checkpoint not set');
		if (this.activeCheckpointHeight + 1 !== finalizedBlock.index) throw new Error(`(Checkpoint fill) Block index mismatch: ${this.activeCheckpointHeight + 1} !== ${finalizedBlock.index}`);
		
		// on invalid hash!=prevHash => erase the block batch folder, trying to resolve conflict
		if (finalizedBlock.prevHash !== this.activeCheckpointHash) { 
			const batchFolderName = BlockchainStorage.batchFolderFromBlockIndex(finalizedBlock.index).name;
			const batchFolderPath = path.join(this.activeCheckpointPath, 'blocks', batchFolderName);
			if (fs.existsSync(batchFolderPath)) fs.rmSync(batchFolderPath, { recursive: true, force: true });
			return 'restart'
		}

		// Hash verification, argon2 based, cost CPU time (~500ms)
		if (this.#randomDiceRoll(this.rndControlDiceFaces)) {
			console.info(`Checkpoint fill: verifying block hash ${finalizedBlock.index}...`);
			const { hex, bitsArrayAsString } = await BlockUtils.getMinerHash(finalizedBlock);
        	if (finalizedBlock.hash !== hex) throw new Error(`(Checkpoint fill) Block hash mismatch: ${finalizedBlock.hash} !== ${hex}`);
		}

		this.#saveBlockBinary(finalizedBlock, serializedBlock, serializedBlockInfo);
		this.activeCheckpointHeight = finalizedBlock.index;
		this.activeCheckpointHash = finalizedBlock.hash;

		return true;
	}
	async deployActiveCheckpoint(snapshotHeightModulo, saveZipArchive = true) {
		if (this.activeCheckpointHeight === false) throw new Error(`(Checkpoint deploy) Active checkpoint not set`);
		if (this.activeCheckpointLastSnapshotHeight === false) throw new Error(`(Checkpoint deploy) Active checkpoint last snapshot height not set`);

		if (saveZipArchive) await this.newCheckpoint(this.activeCheckpointHeight, snapshotHeightModulo, this.activeCheckpointPath);

		const txsRefsConfigDest = path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json')
		if (fs.existsSync(txsRefsConfigDest)) fs.rmSync(txsRefsConfigDest, { force: true });
		if (fs.existsSync(PATH.BLOCKS)) fs.rmSync(PATH.BLOCKS, { recursive: true, force: true });
		if (fs.existsSync(PATH.SNAPSHOTS)) fs.rmSync(PATH.SNAPSHOTS, { recursive: true, force: true });
		if (fs.existsSync(PATH.TXS_REFS)) fs.rmSync(PATH.TXS_REFS, { recursive: true, force: true });
		if (fs.existsSync(PATH.TRASH)) fs.rmSync(PATH.TRASH, { recursive: true, force: true });
		if (fs.existsSync(PATH.BLOCKS_INFO)) fs.rmSync(PATH.BLOCKS_INFO, { recursive: true, force: true });

		fs.renameSync(path.join(this.activeCheckpointPath, 'blocks'), PATH.BLOCKS);
		fs.renameSync(path.join(this.activeCheckpointPath, 'blocks-info'), PATH.BLOCKS_INFO);
		fs.renameSync(path.join(this.activeCheckpointPath, 'snapshots'), PATH.SNAPSHOTS);
		//! fs.renameSync(path.join(this.activeCheckpointPath, 'addresses-txs-refs'), PATH.TXS_REFS);
		//! fs.renameSync(path.join(this.activeCheckpointPath, 'AddressesTxsRefsStorage_config.json'), txsRefsConfigDest);
		fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });

		this.activeCheckpointHeight = false;
		this.activeCheckpointLastSnapshotHeight = false;
		this.activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // hash of block -1
	}
	resetCheckpoints() {
		CheckpointsStorage.reset();
		this.lastCheckpointInfo = { height: 0, hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
	}
	resetActiveCheckpoint() {
		if (this.activeCheckpointHeight === false) return false;
		fs.rmSync(this.activeCheckpointPath, { recursive: true, force: true });
		this.activeCheckpointHeight = false;
		this.activeCheckpointLastSnapshotHeight = false;
		this.activeCheckpointHash = '0000000000000000000000000000000000000000000000000000000000000000'; // fake hash
		return true;
	}
}