// @ts-check
/**
 * @fileoverview Central serialization hub — currently undergoing progressive migration.
 *
 * Type-specific serialization logic is being moved to their respective type files:
 * - Transaction read/write → `types/transaction.mjs` (TransactionWriter / TransactionReader)
 * - Block read/write → `types/block.mjs` (planned)
 *
 * Network/protocol messages (blocksRangeRequest, transactionsResponse, etc.) will eventually
 * land in a dedicated `sync-messages.mjs`.
 *
 * Until then, this file remains the single entry point for all serialization needs.
 * Do not add new logic here — prefer the appropriate type file or create a new one. */

import { ADDRESS } from '../types/address.mjs';
import { SIZES } from './serializer-schema.mjs';
import { BinaryReader, BinaryWriter, NonZeroUint16 } from './binary-helpers.mjs';
import { Transaction_Builder } from '../node/src/transaction.mjs';
import { BlockFinalized, BlockCandidate } from '../types/block.mjs';
import { Converter, QsafeSigner, QsafeHelper } from '../node/src/conCrypto.mjs';
import { Transaction, TransactionReader, TransactionWriter, LedgerUtxo, TxOutput, UTXO_RULES_GLOSSARY, UTXO_RULESNAME_FROM_CODE } from '../types/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
export { SIZES, BinaryReader, BinaryWriter, NonZeroUint16 };

/**
* @typedef {import("../types/transaction.mjs").UTXO} UTXO
* @typedef {import("../types/transaction.mjs").TxId} TxId
* @typedef {import("../types/transaction.mjs").Witness} Witness
* @typedef {import("../types/transaction.mjs").TxAnchor} TxAnchor
* @typedef {import("../types/sync.mjs").BlockHeightHash} BlockHeightHash
*
* @typedef {Object} NodeSetting
* @property {string} privateKey
* @property {string} validatorRewardAddress
* @property {string} solverAddress
* @property {number} solverThreads */

const converter = new Converter();
const isNode = typeof self === 'undefined'; // @ts-expect-error - msgpack global added by browser script
const msgpack = isNode ? (await import('../external-libs/msgpack.min.js')).default : window.msgpack;

const dataPositions = { // specific helpers for partial block reading
	timestampInFinalizedBlock: SIZES.blockFinalizedHeader.bytes - SIZES.timestamp.bytes - SIZES.hash.bytes - SIZES.nonce.bytes,
}

/** Theses methods are used to serialize and deserialize the data of the blockchain.
 * 
 * - Method do not check the input data.
 * - Make sure to validate the data before using these functions. */
export const serializer = {
	/** Routing of mode for transaction serialization
	 * - In candidate blocks, the first tx is always the validator tx
	 * - In finalized blocks, the first tx is always the solver (coinbase) tx, the second is the validator tx
	 * @type {Object<string, Object<string, 'solver' | 'validator' | undefined>>} */
	specialMode: {
		finalized: { 0: 'solver', 1: 'validator' },
		candidate: { 0: 'validator' }
	},
	nonZeroUint16: new NonZeroUint16(),
	dataPositions,
	converter,
	
	/** @param {TxId} txId ex: blockHeight:txIndex */
	parseTxId(txId) {
		const [height, txIndex] = txId.split(':').map(n => parseInt(n, 10));
		return { height, txIndex };
	},
	/** @param {TxAnchor} anchor ex: blockHeight:txIndex:vout */
	parseAnchor(anchor) {
		const [height, txIndex, vout] = anchor.split(':').map(n => parseInt(n, 10));
		return { height, txIndex, vout };
	},

    serialize: {
		/** @param {any} rawData */
        rawData(rawData) { // DEPRECATED: not used.
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(rawData);
            return encoded;
        },
		/** @param {number} height @param {number} txIndex @param {number} identityIndex */
		stamp(height, txIndex, identityIndex) {
			const w = new BinaryWriter(SIZES.stamp.bytes);
			w.writeBytes(converter.numberTo4Bytes(height));
			w.writeBytes(serializer.converter.numberTo2Bytes(txIndex));
			w.writeByte(identityIndex);
			return w.getBytesOrThrow(`Stamp serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
        /** @param {TxAnchor} anchor ex: blockHeight:txIndex:vout */
        anchor(anchor) {
			const w = new BinaryWriter(SIZES.anchor.bytes);
			const { height, txIndex, vout } = serializer.parseAnchor(anchor);
			w.writeBytes(converter.numberTo4Bytes(height));
			w.writeBytes(serializer.nonZeroUint16.encode(txIndex));
			w.writeBytes(serializer.nonZeroUint16.encode(vout));
			return w.getBytesOrThrow(`Anchor serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {number} height @param {number} txIndex @param {number} vout @param {number} amount @param {string} rule */
		ledgerUtxo(height, txIndex, vout, amount, rule) {
			const w = new BinaryWriter(SIZES.ledgerUtxo.bytes);
			w.writeBytes(converter.numberTo4Bytes(height));
			w.writeBytes(serializer.nonZeroUint16.encode(txIndex));
			w.writeBytes(serializer.nonZeroUint16.encode(vout));
			w.writeBytes(converter.numberTo6Bytes(amount));
			w.writeByte(UTXO_RULES_GLOSSARY[rule].code);
			return w.getBytesOrThrow(`Ledger UTXO serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {Record<TxAnchor, UTXO>} utxosObj */
		miniUTXOsObj(utxosObj) {
			let count = 0; // fast counter without garbage (no need to create an array of keys or values)
			for (const anchor in utxosObj) count++;

			const w = new BinaryWriter(count * (SIZES.anchor.bytes + SIZES.miniUTXO.bytes));
			for (const anchor in utxosObj) {
				const utxo = utxosObj[anchor];
				const rule = UTXO_RULES_GLOSSARY[utxo.rule];
				if (!rule) throw new Error(`Unknown UTXO rule: ${utxo.rule}`);
				w.writeBytes(this.anchor(anchor));
				w.writeBytes(ADDRESS.addressToBytes(utxo.address));
				w.writeBytes(converter.numberTo6Bytes(utxo.amount));
				w.writeByte(rule.code);
			}
			return w.getBytesOrThrow(`miniUTXOs object serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {TxId[] | Set<TxId>} txsIds ex: blockHeight:txIndex */
        txsIdsArray(txsIds) {
			const count = txsIds instanceof Set ? txsIds.size : txsIds.length;
			const w = new BinaryWriter(count * SIZES.txId.bytes);
			for (const txId of txsIds) {
				const { height, txIndex } = serializer.parseTxId(txId);
				w.writeBytes(converter.numberTo4Bytes(height));
				w.writeBytes(serializer.nonZeroUint16.encode(txIndex));
            };
            return w.getBytesOrThrow(`Txs references array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {number | undefined} threshold 'undefined' will set '0' and return 'undefined' on deserialization @param {string[]} pubKeysHex */
		identityEntry(threshold, pubKeysHex) {
			const pks = pubKeysHex.map(hybridKeyHex => converter.hexToBytes(hybridKeyHex));
			const pointersSize = BinaryWriter.calculatePointersSize(pks.length);
			const totalPksSize = pks.reduce((sum, pk) => sum + pk.length, 0);
			const w = new BinaryWriter(1 + pointersSize + totalPksSize);
			w.writeByte(threshold || 0);		// 1b
			w.writePointersAndDataChunks(pks);  // unspecified.
			return w.getBytesOrThrow(`Identity entry serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
        /** @param {Transaction} tx @param {'tx' | 'validator' | 'solver'} [mode] default: tx */
        transaction(tx, mode = 'tx') {
			const w = new TransactionWriter(tx, mode);
			w.writeHeader();
			w.writeWitnesses();
			w.writeIdentities();
			w.writeUtxoParams();
			w.writeInputs();
			w.writeOutputs();
			w.writeData();
			return w.w.getBytesOrThrow(`Transaction serialization incomplete: wrote ${w.w.cursor} of ${w.w.view.length} bytes`);
        },
		/** @param {Transaction[]} txs - Array of transactions(pointer32), Validator or solver tx excluded. */
		transactions(txs) {
			const serializedTxs = [];
			for (const tx of txs) serializedTxs.push(this.transaction(tx));
			const pointersSize = BinaryWriter.calculatePointersSize(serializedTxs.length, 'pointer32');
			const totalTxsSize = serializedTxs.reduce((sum, tx) => sum + tx.length, 0);
			const w = new BinaryWriter(pointersSize + totalTxsSize);
			w.writePointersAndDataChunks(serializedTxs, 'pointer32');
			return w.getBytesOrThrow(`Transactions serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {BlockFinalized | BlockCandidate} blockData @param {'finalized' | 'candidate'} [mode] default: finalized */
        block(blockData, mode = 'finalized') {
            /** @type {Uint8Array<ArrayBuffer>[]} */
            const serializedTxs = [];
			let totalTxsSize = 0;
            for (let i = 0; i < blockData.Txs.length; i++) {
				const s = this.transaction(blockData.Txs[i], serializer.specialMode[mode][i]);
                serializedTxs.push(s);
                totalTxsSize += s.length; // tx bytes + pointer(4)
            }
            
            let totalSize = mode === 'finalized' ? SIZES.blockFinalizedHeader.bytes : SIZES.blockCandidateHeader.bytes;
			totalSize += BinaryWriter.calculatePointersSize(serializedTxs.length, 'pointer32') + totalTxsSize; // pointers + txs
            
			const w = new BinaryWriter(totalSize);
			w.writeBytes(converter.numberTo2Bytes(blockData.Txs.length));	// nbOfTxs
			w.writeBytes(converter.numberTo4Bytes(blockData.index));		// index
			w.writeBytes(converter.numberTo6Bytes(blockData.supply));		// supply
			w.writeBytes(converter.numberTo4Bytes(blockData.coinBase));		// coinBase
			w.writeBytes(converter.numberTo4Bytes(blockData.difficulty));	// difficulty
			w.writeBytes(converter.numberTo2Bytes(blockData.legitimacy));	// legitimacy
			w.writeBytes(converter.hexToBytes(blockData.prevHash));			// prevHash
			w.writeBytes(converter.numberTo6Bytes(blockData.posTimestamp));	// posTimestamp
			
			if (mode === 'finalized' && 'timestamp' in blockData)
				w.writeBytes(converter.numberTo6Bytes(blockData.timestamp)); // timestamp
			if (mode === 'candidate' && 'powReward' in blockData)
				w.writeBytes(converter.numberTo6Bytes(blockData.powReward || 0)); // powReward

			if (mode === 'finalized' && 'hash' in blockData)  // write hash if any
				w.writeBytes(converter.hexToBytes(blockData.hash));	
			if (mode === 'finalized' && 'nonce' in blockData) // write nonce if any
				w.writeBytes(converter.hexToBytes(blockData.nonce));
            
			w.writePointersAndDataChunks(serializedTxs, 'pointer32'); // write pointers and txs in one call
			return w.getBytesOrThrow(`Block serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {number} blockHeight @param {string} blockHash */
		blockHeightHash(blockHeight, blockHash) {
			const w = new BinaryWriter(4 + SIZES.hash.bytes);
			w.writeBytes(converter.numberTo4Bytes(blockHeight));
			w.writeBytes(converter.hexToBytes(blockHash));
			return w.getBytes();
		},
		/** @param {number} start @param {number} blockBytes @param {number} utxosStatesBytes */
		blockIndexEntry(start, blockBytes, utxosStatesBytes) {
			const w = new BinaryWriter(12);
			w.writeBytes(converter.numberTo6Bytes(start));
			w.writeBytes(converter.numberTo4Bytes(blockBytes));
			w.writeBytes(converter.numberTo2Bytes(utxosStatesBytes));
			return w.getBytes();
		},
		/** @param {BlockFinalized} block */
		utxosStatesOfBlock(block) {
			let utxoCount = 0;
			for (let i = 0; i < block.Txs.length; i++) utxoCount += block.Txs[i].outputs.length;

			const w = new BinaryWriter(utxoCount * SIZES.utxoState.bytes);
			for (let i = 0; i < block.Txs.length; i++)
				for (let j = 0; j < block.Txs[i].outputs.length; j++) {
					w.writeBytes(serializer.nonZeroUint16.encode(i));
					w.writeBytes(serializer.nonZeroUint16.encode(j));
					w.writeByte(0);
				}
			
			return w.getBytesOrThrow(`UTXO states array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {NodeSetting} nodeSetting */
        nodeSetting(nodeSetting) {
			const w = new BinaryWriter(32 + SIZES.address.bytes + SIZES.address.bytes + 1);
			w.writeBytes(converter.hexToBytes(nodeSetting.privateKey));
			w.writeBytes(ADDRESS.addressToBytes(nodeSetting.validatorRewardAddress));
			w.writeBytes(ADDRESS.addressToBytes(nodeSetting.solverAddress));
			w.writeByte(nodeSetting.solverThreads);
            return w.getBytes();
        },
		/** @param {number} fromHeight @param {number} toHeight */
		blocksRangeRequest(fromHeight, toHeight) {
			const w = new BinaryWriter(4 * 2);
			w.writeBytes(converter.numberTo4Bytes(fromHeight));
			w.writeBytes(converter.numberTo4Bytes(toHeight));
			return w.getBytes();
		},
		/** @param {number[]} heights @param {number[]} timestamps */
		blocksTimestampsResponse(heights, timestamps) {
			if (heights.length !== timestamps.length) throw new Error('Heights and timestamps arrays must have the same length');
			const w = new BinaryWriter((4 * heights.length) + (SIZES.timestamp.bytes * timestamps.length));
			for (let i = 0; i < heights.length; i++) {
				w.writeBytes(converter.numberTo4Bytes(heights[i]));
				w.writeBytes(converter.numberTo6Bytes(timestamps[i]));
			}
			return w.getBytes();
		},
		/** @param {Array<{address: string, authorizedAddresses: Set<string>}>} roundsLegitimacies */
		roundsLegitimaciesResponse(roundsLegitimacies) {
			let entries = [];
			for (const entry of roundsLegitimacies) {
				const authorizedAddressesSize = entry.authorizedAddresses.size * SIZES.address.bytes;
				const w = new BinaryWriter(SIZES.address.bytes + authorizedAddressesSize);
				w.writeBytes(ADDRESS.addressToBytes(entry.address));
				for (const address of entry.authorizedAddresses) w.writeBytes(ADDRESS.addressToBytes(address));
				entries.push(w.getBytesOrThrow(`Round legitimacy entry serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`));
			}

			const pointersSize = BinaryWriter.calculatePointersSize(entries.length);
			const totalSize = pointersSize + entries.reduce((sum, bytes) => sum + bytes.length, 0);
			const w = new BinaryWriter(totalSize);
			w.writePointersAndDataChunks(entries);
			return w.getBytesOrThrow(`Rounds legitimacies response serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {Record<TxId, Transaction>} txs @param {Record<TxAnchor, UTXO>} impliedUtxos */
		transactionsResponse(txs, impliedUtxos) {
			const modes = [];
			const serializedTxs = [];
			for (const id in txs) { // SERIALIZE TXs WITH SPECIAL MODE IF VALIDATOR/SOLVER TX
				const mode = Transaction_Builder.isSolverOrValidatorTx(txs[id]);
				modes.push(!mode ? 0 : mode === 'solver' ? 1 : 2); // 0 = tx, 1 = solver, 2 = validator
				serializedTxs.push(this.transaction(txs[id], mode));
			}

			const serializedUtxos = this.miniUTXOsObj(impliedUtxos);
			const idsSize = SIZES.txId.bytes * serializedTxs.length;
			const modeSize = serializedTxs.length; 		 // mode(1b) for each tx (solver/validator/tx)
			const offsetSize = 4 * serializedTxs.length; // pointer(4b) for each tx
			const txsSize = serializedTxs.reduce((sum, tx) => sum + tx.length, 0);
			const totalSize = idsSize + modeSize + offsetSize + txsSize + 4 + serializedUtxos.length;
			
			const w = new BinaryWriter(totalSize);
			w.writeBytes(converter.numberTo4Bytes(serializedUtxos.length));
			w.writeBytes(serializedUtxos);

			let i = 0;
			for (const id in txs) {
				const { height, txIndex } = serializer.parseTxId(id);
				w.writeBytes(converter.numberTo4Bytes(height));
				w.writeBytes(converter.numberTo2Bytes(txIndex));
				w.writeByte(modes[i]);

				const serializedTx = serializedTxs[i];
				w.writeBytes(converter.numberTo4Bytes(serializedTx.length)); // pointer
				w.writeBytes(serializedTx);
				i++;
			}

			return w.getBytes();
		}
	},
    deserialize: {
		/** @param {Uint8Array} encodedData */
        rawData(encodedData) { // DEPRECATED: not used.
            return msgpack.decode(encodedData);
        },
		/** @param {Uint8Array} serializedStamp */
		stamp(serializedStamp) {
			const r = new BinaryReader(serializedStamp);
			const blockHeight = converter.bytes4ToNumber(r.read(4));
			const txIndex = converter.bytes2ToNumber(r.read(2));
			const identityIndex = r.read(1)[0];
			if (r.isReadingComplete) return { blockHeight, txIndex, identityIndex };
			else throw new Error(`Stamp is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
		},
        /** @param {Uint8Array} serializedAnchor */
        anchor(serializedAnchor) {
			const r = new BinaryReader(serializedAnchor);
			const blockHeight = converter.bytes4ToNumber(r.read(4));
			const txIndex = serializer.nonZeroUint16.decode(r.read(2));
			const inputIndex = serializer.nonZeroUint16.decode(r.read(2));
			if (r.isReadingComplete) return `${blockHeight}:${txIndex}:${inputIndex}`;
			else throw new Error(`Anchor is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
		/** @param {Uint8Array} serializedLedgerUtxos */
		ledgerUtxosArray(serializedLedgerUtxos) {
			/** @type {LedgerUtxo[]} */
			const ledgerUtxos = [];
			const r = new BinaryReader(serializedLedgerUtxos);
			for (let i = 0; i < serializedLedgerUtxos.length; i += SIZES.ledgerUtxo.bytes) {
				const height = converter.bytes4ToNumber(r.read(4));
				const txIndex = serializer.nonZeroUint16.decode(r.read(2));
				const vout = serializer.nonZeroUint16.decode(r.read(2));
				const amount = converter.bytes6ToNumber(r.read(6));
				const ruleCode = r.read(1)[0];
				ledgerUtxos.push(new LedgerUtxo(`${height}:${txIndex}:${vout}`, amount, ruleCode));
			}
			if (r.isReadingComplete) return ledgerUtxos;
			else throw new Error(`LedgerUtxos array is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
		},
		/** @param {Uint8Array} serializedMiniUTXOsObj */
		miniUTXOsObj(serializedMiniUTXOsObj) {
			/** @type {Record<TxAnchor, { address: string, amount: number, rule: string }>} */
			const miniUTXOsObj = {};
			const r = new BinaryReader(serializedMiniUTXOsObj);
			for (let i = 0; i < serializedMiniUTXOsObj.length; i += (SIZES.anchor.bytes + SIZES.miniUTXO.bytes)) {
				const anchor = this.anchor(r.read(SIZES.anchor.bytes));
				const address = ADDRESS.bytesToAddress(r.read(SIZES.address.bytes));
				const amount = converter.bytes6ToNumber(r.read(6));
				const rule = UTXO_RULESNAME_FROM_CODE[r.read(1)[0]];
				miniUTXOsObj[anchor] = { address, amount, rule };
			}
			if (r.isReadingComplete) return miniUTXOsObj;
			else throw new Error(`miniUTXOs object is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
		},
		/** @param {Uint8Array} serializedTxsIds */
        txsIdsArray(serializedTxsIds) {
			if (serializedTxsIds.length % SIZES.txId.bytes !== 0) throw new Error('Serialized txIds length is invalid');
			/** @type {TxId[]} */
			const txsIds = [];
			const expectedNbOfTxsId = serializedTxsIds.length / SIZES.txId.bytes;
			const r = new BinaryReader(serializedTxsIds);
			for (let i = 0; i < expectedNbOfTxsId; i++) {
				const blockHeight = converter.bytes4ToNumber(r.read(4));
				const txIndex = serializer.nonZeroUint16.decode(r.read(2));
				txsIds.push(`${blockHeight}:${txIndex}`);
			}
			if (r.isReadingComplete) return txsIds;
			else throw new Error(`TxsIds array is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
		/** @param {Uint8Array} identityEntry */
		identityEntry(identityEntry) {
			const r = new BinaryReader(identityEntry);
			const threshold = r.read(1)[0] || undefined;
			const pubKeysHex = [];
			const pks = r.readPointersAndExtractDataChunks();
			for (const pk of pks) pubKeysHex.push(converter.bytesToHex(pk));
			return { pubKeysHex, threshold };
		},
		/** @param {Uint8Array} serializedTx @param {'tx' | 'validator' | 'solver'} [mode] default: normal */
		transaction(serializedTx, mode = 'tx') {
			if (serializedTx.length > BLOCKCHAIN_SETTINGS.maxTransactionSize) throw new Error('Serialized transaction exceeds maximum allowed size');

			const r = new TransactionReader(serializedTx, mode);
			const witnesses 	= r.getWitnesses();
			const identities 	= r.getIdentities();
			const utxoParams	= r.getUtxoParams();
			const inputs 		= r.getInputs();
			const outputs 		= r.getOutputs();
			const data 			= r.getSerializedSection('data');
			if (!r.r.isReadingComplete) throw new Error('Transaction is not fully deserialized');
			return new Transaction(inputs, outputs, r.lastValidHeight, witnesses, identities, utxoParams, data, r.version);
		},
		/** @param {Uint8Array} serializedTxs - Array of serializedTx(pointer32), Validator and solver txs should be excluded */
		transactions(serializedTxs) {
			const r = new BinaryReader(serializedTxs);
			const txs = r.readPointersAndExtractDataChunks('pointer32');
			const transactions = [];
			for (const tx of txs) transactions.push(this.transaction(tx));
			if (!r.isReadingComplete) throw new Error('Transactions are not fully deserialized');
			return transactions;
		},
		/** @param {BinaryReader} r BinaryReader with cursor set at start of block header @param {'finalized' | 'candidate'} [mode] default: finalized */
		blockHeader(r, mode = 'finalized') {
			const nbOfTxs = converter.bytes2ToNumber(r.read(2));
			const index = converter.bytes4ToNumber(r.read(4));
			const supply = converter.bytes6ToNumber(r.read(6));
			const coinBase = converter.bytes4ToNumber(r.read(4));
			const difficulty = converter.bytes4ToNumber(r.read(4));
			const legitimacy = converter.bytes2ToNumber(r.read(2));
			const prevHash = converter.bytesToHex(r.read(SIZES.hash.bytes));
			const posTimestamp = converter.bytes6ToNumber(r.read(6));
			let timestamp, powReward, hash, nonce;
			if (mode === 'candidate') powReward = converter.bytes6ToNumber(r.read(6));
			else if (mode === 'finalized') {
				timestamp = converter.bytes6ToNumber(r.read(SIZES.timestamp.bytes));
				hash = converter.bytesToHex(r.read(SIZES.hash.bytes));
				nonce = converter.bytesToHex(r.read(SIZES.nonce.bytes));
			}
			// We accept partial deserialization of the block header.
			return { nbOfTxs, index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce, powReward };
		},
		/** @param {Uint8Array} serializedBlock @param {'finalized' | 'candidate'} [mode] default: finalized */
		blockData(serializedBlock, mode = 'finalized') { // local use only
			const r = new BinaryReader(serializedBlock);
			const { nbOfTxs, index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce, powReward } = this.blockHeader(r, mode);
			const txsSerialized = r.readPointersAndExtractDataChunks('pointer32');
			const txs = [];
			for (let i = 0; i < nbOfTxs; i++) txs.push(this.transaction(txsSerialized[i], serializer.specialMode[mode][i]));

			if (!r.isReadingComplete) throw new Error('Block is not fully deserialized');
			return { index, supply, coinBase, difficulty, legitimacy, prevHash, txs, txsSerialized, posTimestamp, timestamp, hash, nonce, powReward };
		},
		/** @param {Uint8Array} serializedBlock */
		blockCandidate(serializedBlock) {
			const { index, supply, coinBase, difficulty, legitimacy, prevHash, txs, posTimestamp, powReward } = this.blockData(serializedBlock, 'candidate');
			if (typeof powReward === 'undefined') throw new Error('Candidate block is missing data');
			return new BlockCandidate(index, supply, coinBase, difficulty, legitimacy, prevHash, txs, posTimestamp, powReward);
		},
		/** @param {Uint8Array} serializedBlock */
		blockFinalized(serializedBlock) {
			const { index, supply, coinBase, difficulty, legitimacy, prevHash, txs, posTimestamp, timestamp, hash, nonce } = this.blockData(serializedBlock, 'finalized');
			if (typeof hash === 'undefined' || typeof timestamp === 'undefined' || typeof nonce === 'undefined') throw new Error('Finalized block is missing data');
			return new BlockFinalized(index, supply, coinBase, difficulty, legitimacy, prevHash, txs, posTimestamp, timestamp, hash, nonce);
		},
		/** @param {Uint8Array} serializedBlockHeightHash */
		blockHeightHash(serializedBlockHeightHash) {
			const r = new BinaryReader(serializedBlockHeightHash);
			const blockHeight = converter.bytes4ToNumber(r.read(4));
			const blockHash = converter.bytesToHex(r.read(SIZES.hash.bytes));
			if (r.isReadingComplete) return { blockHeight, blockHash };
			else throw new Error(`BlockHeightHash is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
		},
		/** @param {Uint8Array} entry */
		blockIndexEntry(entry) {
			const offset = {
				start: serializer.converter.bytes6ToNumber(entry.subarray(0, 6)),
				blockBytes: serializer.converter.bytes4ToNumber(entry.subarray(6, 10)),
				utxosStatesBytes: serializer.converter.bytes2ToNumber(entry.subarray(10, 12))
			};
			return offset;
		},
		/** @param {Uint8Array} serializedNodeSetting */
        nodeSetting(serializedNodeSetting) {
			const r = new BinaryReader(serializedNodeSetting);
			const privateKey = converter.bytesToHex(r.read(32));
			const validatorRewardAddress = ADDRESS.bytesToAddress(r.read(SIZES.address.bytes));
			const solverAddress = ADDRESS.bytesToAddress(r.read(SIZES.address.bytes));
			const solverThreads = r.read(1)[0];
            return { privateKey, validatorRewardAddress, solverAddress, solverThreads };
        },
		/** @param {Uint8Array} serializedRequest */
		blocksRangeRequest(serializedRequest) {
			const r = new BinaryReader(serializedRequest);
			const fromHeight = converter.bytes4ToNumber(r.read(4));
			const toHeight = converter.bytes4ToNumber(r.read(4));
			if (r.isReadingComplete) return { fromHeight, toHeight };
			else throw new Error(`BlocksRangeRequest is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
		},
		/** @param {Uint8Array} serializedResponse */
		blocksTimestampsResponse(serializedResponse) {
			if (serializedResponse.length % (4 + SIZES.timestamp.bytes) !== 0) throw new Error('Serialized blocks timestamps response length is invalid');
			const heights = [];
			const timestamps = [];
			const r = new BinaryReader(serializedResponse);
			while (!r.isReadingComplete) {
				heights.push(converter.bytes4ToNumber(r.read(4)));
				timestamps.push(converter.bytes6ToNumber(r.read(6)));
			}
			return { heights, timestamps };
		},
		/** @param {Uint8Array} serializedResponse */
		roundsLegitimaciesResponse(serializedResponse) {
			const r = new BinaryReader(serializedResponse);
			const roundsLegitimacies = [];
			const entries = r.readPointersAndExtractDataChunks();
			for (const entry of entries) {
				const entryReader = new BinaryReader(entry);
				const address = ADDRESS.bytesToAddress(entryReader.read(SIZES.address.bytes));
				const authorizedAddresses = new Set();
				if (entryReader.view.length % SIZES.address.bytes !== 0) throw new Error('Serialized rounds legitimacy entry is invalid: remaining bytes after reading address should be a multiple of address size');
				while (!entryReader.isReadingComplete)
					authorizedAddresses.add(ADDRESS.bytesToAddress(entryReader.read(SIZES.address.bytes)));
				roundsLegitimacies.push({ address, authorizedAddresses });
			}
			return roundsLegitimacies;
		},
		/** @param {Uint8Array} serializedResponse */
		transactionsResponse(serializedResponse) {
			/** @type {Record<TxId, Transaction>} */
			const txs = {};
			const r = new BinaryReader(serializedResponse);
			const utxosSize = converter.bytes4ToNumber(r.read(4));
			const impliedUtxos = this.miniUTXOsObj(r.read(utxosSize)); // read implied utxos

			while (!r.isReadingComplete) {
				const blockHeight = converter.bytes4ToNumber(r.read(4));
				const txIndex = converter.bytes2ToNumber(r.read(2));
				const modeByte = r.read(1)[0];
				const mode = modeByte === 0 ? 'tx' : modeByte === 1 ? 'solver' : modeByte === 2 ? 'validator' : null;
				if (!mode) throw new Error(`Invalid mode byte in transactions response: ${modeByte}`);

				const txSize = converter.bytes4ToNumber(r.read(4));
				const tx = this.transaction(r.read(txSize), mode);
				txs[`${blockHeight}:${txIndex}`] = tx;
			}

			return { txs, impliedUtxos };
		}
    }
};