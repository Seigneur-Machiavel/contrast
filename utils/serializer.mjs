// @ts-check
import { Converter } from 'hive-p2p';
import { BlockData } from '../types/block.mjs';
import { Transaction, TxOutput } from '../types/transaction.mjs';
import { UTXO_RULES_GLOSSARY, UTXO_RULESNAME_FROM_CODE } from './utxo-rules.mjs';

/**
* @typedef {import("../types/transaction.mjs").UTXO} UTXO
* @typedef {import("../types/transaction.mjs").TxAnchor} TxAnchor
* @typedef {import("../types/transaction.mjs").TxReference} TxReference
* @typedef {import("../node/src/utxo-cache.mjs").UtxoCache} UtxoCache
*
* @typedef {Object} NodeSetting
* @property {string} privateKey
* @property {string} validatorRewardAddress
* @property {string} minerAddress
* @property {number} minerThreads
* 
* @typedef {Object} CheckpointInfo
* @property {number} height
* @property {string} hash
* 
* @typedef {Object} SyncStatus
* @property {number} currentHeight
* @property {string} latestBlockHash
* @property {CheckpointInfo} checkpointInfo
*/

const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
const msgpack = isNode ? (await import('../libs/msgpack.min.js')).default : window.msgpack;
const converter = new Converter();

export class BinaryWriter {
	cursor = 0;
	buffer;
	view;

	/** @param {number} size */
	constructor(size) {
		this.buffer = new ArrayBuffer(size);
		this.view = new Uint8Array(this.buffer);
	}

	get isWritingComplete() { return this.cursor === this.view.length; }
	/** @param {number} byte */
	writeByte(byte) {
		this.view[this.cursor] = byte;
		this.cursor += 1;
	}
	/** @param {Uint8Array} data */
	writeBytes(data) {
		this.view.set(data, this.cursor);
		this.cursor += data.length;
	}
	getBytes() { return this.view; }
}
export class BinaryReader {
	cursor = 0
	view;

	/** @param {ArrayBuffer | Uint8Array} buffer */
	constructor(buffer) {
		this.view = new Uint8Array(buffer);
	}
	
	get isReadingComplete() { return this.cursor === this.view.length; }

	/** @param {number} length */
	read(length) {
		const [start, end] = [this.cursor, this.cursor + length];
		this.cursor = end;
		return this.view.slice(start, end);
	}
}
/** Types length in bytes */
const lengths = {
	pubKey: 32,
	address: 16,
	signature: 64,
	witness: 96,
	anchor: 8,
	miniUTXO: 25,
	txReference: 6,

	/** nbOfTxs(2) + index(4) + supply(8) + coinBase(4) + difficulty(4) + legitimacy(2) + prevHash(32) + posTimestamp(8) + powReward(8) */
    blockCandidateHeader: 2 + 4 + 8 + 4 + 4 + 2 + 32 + 8 + 8,
	/** nbOfTxs(2) + index(4) + supply(8) + coinBase(4) + difficulty(4) + legitimacy(2) + prevHash(32) + posTimestamp(8) + timestamp(8) + hash(32) + nonce(4) */
	blockFinalizedHeader: 2 + 4 + 8 + 4 + 4 + 2 + 32 + 8 + 8 + 32 + 4,
}

/** Theses functions are used to serialize and deserialize the data of the blockchain.
 * 
 * - functions do not check the input data.
 * - Make sure to validate the data before using these functions. */
export const serializer = {
	lengths,
	/** Routing of mode for transaction serialization
	 * - In candidate blocks, the first tx is always the validator tx
	 * - In finalized blocks, the first tx is always the miner (coinbase) tx, the second is the validator tx
	 * @type {Object<string, Object<string, 'miner' | 'validator' | undefined>>} */
	specialMode: { // Routing of mode for transaction serialization
		finalized: { 0: 'miner', 1: 'validator' },
		candidate: { 0: 'validator' }
	},
	/** @param {TxReference} txRef ex: blockHeight:txIndex */
	parseTxReference(txRef) {
		const [height, txIdx] = txRef.split(':').map(n => parseInt(n, 10));
		return { height, txIdx };
	},
	/** @param {TxAnchor} anchor ex: blockHeight:txIndex:vout */
	parseAnchor(anchor) {
		const [height, txIdx, vout] = anchor.split(':').map(n => parseInt(n, 10));
		return { height, txIdx, vout };
	},

    serialize: {
		/** @param {any} rawData */
        rawData(rawData) {
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(rawData);
            return encoded;
        },
        /** @param {TxAnchor} anchor ex: blockHeight:txIndex:vout */
        anchor(anchor) {
			const w = new BinaryWriter(lengths.anchor);
			const { height, txIdx, vout } = serializer.parseAnchor(anchor);
			w.writeBytes(converter.numberTo4Bytes(height));
			w.writeBytes(converter.numberTo2Bytes(txIdx));
			w.writeBytes(converter.numberTo2Bytes(vout));
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Anchor serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
        /** @param {TxAnchor[]} anchors */
        anchorsArray(anchors) {
			const w = new BinaryWriter(lengths.anchor * anchors.length);
            for (let j = 0; j < anchors.length; j++) { // -> anchor ex: "3:2:0"
				const { height, txIdx, vout } = serializer.parseAnchor(anchors[j]);
				w.writeBytes(converter.numberTo4Bytes(height));
				w.writeBytes(converter.numberTo2Bytes(txIdx));
				w.writeBytes(converter.numberTo2Bytes(vout))
            };
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Anchors array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {Object<TxAnchor, boolean>} anchors */
        anchorsObjToArray(anchors) {
            return this.anchorsArray(Object.keys(anchors));
        },
        /** serialize the UTXO as a miniUTXO: {address, amount, rule} @param {UTXO | TxOutput} utxo */
        miniUTXO(utxo) {
			const rule = UTXO_RULES_GLOSSARY[utxo.rule];
			if (!rule) throw new Error(`Unknown UTXO rule: ${utxo.rule}`);

			const w = new BinaryWriter(lengths.miniUTXO);
			w.writeBytes(converter.addressBase58ToBytes(utxo.address));
			w.writeBytes(converter.numberTo8Bytes(utxo.amount));
			w.writeByte(rule.code);
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`miniUTXO serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {UTXO[] | TxOutput[]} utxos */
        miniUTXOsArray(utxos) {
			const w = new BinaryWriter(lengths.miniUTXO * utxos.length);
			for (let i = 0; i < utxos.length; i++) {
				const rule = UTXO_RULES_GLOSSARY[utxos[i].rule];
				if (!rule) throw new Error(`Unknown UTXO rule: ${utxos[i].rule}`);
				w.writeBytes(converter.addressBase58ToBytes(utxos[i].address));
				w.writeBytes(converter.numberTo8Bytes(utxos[i].amount));
				w.writeByte(rule.code);
			}
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`miniUTXOs array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {Object <string, Uint8Array>} utxos */
        miniUTXOsObj(utxos) { // Here we minimize garbage.
			let totalBytes = 0;
			for (const a in utxos) totalBytes += lengths.anchor + lengths.miniUTXO;

			const w = new BinaryWriter(totalBytes);
			for (const anchor in utxos) {
				const { height, txIdx, vout } = serializer.parseAnchor(anchor);
				w.writeBytes(converter.numberTo4Bytes(height));
				w.writeBytes(converter.numberTo2Bytes(txIdx));
				w.writeBytes(converter.numberTo2Bytes(vout));
				w.writeBytes(utxos[anchor]);
			}
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`miniUTXOs object serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {TxReference[]} txsRef ex: blockHeight:txIndex */
        txsReferencesArray(txsRef) {
			const w = new BinaryWriter(txsRef.length * lengths.txReference);
            for (let j = 0; j < txsRef.length; j++) {
				const { height, txIdx } = serializer.parseTxReference(txsRef[j]);
				w.writeBytes(converter.numberTo4Bytes(height));
				w.writeBytes(converter.numberTo2Bytes(txIdx))
            };
            if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Txs references array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {Object<string, string>} pubkeyAddresses ex: { pubKeyHex: addressBase58, ... } */
        pubkeyAddressesObj(pubkeyAddresses) { // Here we minimize garbage.
			let totalBytes = 0;
			for (const p in pubkeyAddresses) totalBytes += lengths.pubKey + lengths.address;

			const w = new BinaryWriter(totalBytes);
			for (const pubKeyHex in pubkeyAddresses) {
				w.writeBytes(converter.hexToBytes(pubKeyHex));
				w.writeBytes(converter.addressBase58ToBytes(pubkeyAddresses[pubKeyHex]));
			}
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Pubkey-addresses object serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
        /** @param {string[]} witnesses ex: [ "signature:pubKey", ... ] */
        witnessesArray(witnesses) {
			const w = new BinaryWriter(lengths.witness * witnesses.length);
			for (const witness of witnesses) w.writeBytes(converter.hexToBytes(witness.replace(':', '')));
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Witnesses array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
        /** @param {Transaction} tx @param {'tx' | 'validator' | 'miner'} [mode] default: normal */
        transaction(tx, mode = 'tx') {
			if (mode === 'miner' && (tx.inputs.length !== 1 || tx.inputs[0].length !== 8)) throw new Error('Invalid coinbase transaction');
            if (mode === 'validator' && (tx.inputs.length !== 1 || tx.inputs[0].length !== 85)) throw new Error('Invalid transaction');
			if (tx.data && !(tx.data instanceof Uint8Array)) throw new Error('Transaction data must be a Uint8Array');

			const witnessesBytes = tx.witnesses.length * lengths.witness;
			let inputBytes = lengths.anchor;
			if (mode === 'miner') inputBytes = 4; 			// input = nonce
			if (mode === 'validator') inputBytes = 16 + 32;	// input = address + posHash
			const inputsBytes = tx.inputs.length * inputBytes;
			const outputsBytes = tx.outputs.length * lengths.miniUTXO;
			const dataBytes = tx.data?.length || 0;			// arbitrary data

			// header (10) => version(2) + witnesses(2) + inputs(2) + outputs(2) + dataLength(2)
			const w = new BinaryWriter(10 + witnessesBytes + inputsBytes + outputsBytes + dataBytes);
			w.writeBytes(converter.numberTo2Bytes(tx.version)); 				// version
			w.writeBytes(converter.numberTo2Bytes(tx.witnesses?.length || 0)); 	// nb of witnesses
			w.writeBytes(converter.numberTo2Bytes(tx.inputs.length)); 			// nb of inputs
			w.writeBytes(converter.numberTo2Bytes(tx.outputs.length));			// nb of outputs
			w.writeBytes(converter.numberTo2Bytes(tx.data?.length || 0)); 		// data: bytes
			if (mode !== 'miner') w.writeBytes(this.witnessesArray(tx.witnesses));	// witnesses
			if (mode === 'tx') w.writeBytes(this.anchorsArray(tx.inputs));			// inputs
			if (mode === 'miner') w.writeBytes(converter.hexToBytes(tx.inputs[0])); // nonce (hex)
			if (mode === 'validator') {
				const s = tx.inputs[0].split(':');
				w.writeBytes(converter.addressBase58ToBytes(s[0])); 			// address
				w.writeBytes(converter.hexToBytes(s[1]));						// posHash
			}
			w.writeBytes(this.miniUTXOsArray(tx.outputs));						// outputs
			if (tx.data) w.writeBytes(tx.data);									// data
			
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Transaction serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {BlockData} blockData @param {'finalized' | 'candidate'} [mode] default: finalized */
        block(blockData, mode = 'finalized') {
			if (mode === 'candidate' && blockData.Txs.length !== 1) throw new Error('Candidate block must have exactly one transaction (the validator tx)');

            /** @type {Uint8Array<ArrayBuffer>[]} */
            const serializedTxs = [];
			let totalTxsBytes = 0;
            for (let i = 0; i < blockData.Txs.length; i++) {
				const s = this.transaction(blockData.Txs[i], serializer.specialMode[mode][i]);
                serializedTxs.push(s);
                totalTxsBytes += s.length; // tx bytes + pointer(4)
            }
            
            let totalBytes = mode === 'finalized' ? lengths.blockFinalizedHeader : lengths.blockCandidateHeader;
			totalBytes += (serializedTxs.length * 4) + totalTxsBytes; // pointers + txs
            
			const w = new BinaryWriter(totalBytes);
			w.writeBytes(converter.numberTo2Bytes(blockData.Txs.length));	// nbOfTxs
			w.writeBytes(converter.numberTo4Bytes(blockData.index));		// index
			w.writeBytes(converter.numberTo8Bytes(blockData.supply));		// supply
			w.writeBytes(converter.numberTo4Bytes(blockData.coinBase));		// coinBase
			w.writeBytes(converter.numberTo4Bytes(blockData.difficulty));	// difficulty
			w.writeBytes(converter.numberTo2Bytes(blockData.legitimacy));	// legitimacy
			w.writeBytes(converter.hexToBytes(blockData.prevHash));			// prevHash
			w.writeBytes(converter.numberTo8Bytes(blockData.posTimestamp));	// posTimestamp
			
			if (mode === 'finalized') w.writeBytes(converter.numberTo8Bytes(blockData.timestamp || 0)); 	// timestamp
			if (mode === 'candidate') w.writeBytes(converter.numberTo8Bytes(blockData.powReward || 0)); 	// powReward

			if (mode === 'finalized') w.writeBytes(converter.hexToBytes(blockData.hash || '00'.repeat(32))); // hash
			if (mode === 'finalized') w.writeBytes(converter.numberTo4Bytes(blockData.nonce || 0)); 		// nonce
            
            // POINTERS & TXS -> This specific traitment offer better reading performance:
            // no need to deserialize the whole block to read the txs
			let offset = w.cursor + (serializedTxs.length * 4);
            for (let i = 0; i < serializedTxs.length; i++) { // WRITE POINTERS
                w.writeBytes(converter.numberTo4Bytes(offset));
				offset += serializedTxs[i].length;
			}

			for (const serializedTx of serializedTxs) w.writeBytes(serializedTx); // WRITE TXS

            if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`Block serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {NodeSetting} nodeSetting */
        nodeSetting(nodeSetting) {
			const w = new BinaryWriter(32 + 16 + 16 + 1);
			w.writeBytes(converter.hexToBytes(nodeSetting.privateKey));
			w.writeBytes(converter.addressBase58ToBytes(nodeSetting.validatorRewardAddress));
			w.writeBytes(converter.addressBase58ToBytes(nodeSetting.minerAddress));
			w.writeByte(nodeSetting.minerThreads);
            return w.getBytes();
        },
		/** @param {UtxoCache} utxoCache */
        utxoCacheData(utxoCache) {
            const miniUTXOsSerialized = serializer.serialize.miniUTXOsObj(utxoCache.unspentMiniUtxos);
			const w = new BinaryWriter(8 + 8 + miniUTXOsSerialized.length);
			w.writeBytes(converter.numberTo8Bytes(utxoCache.totalOfBalances));
			w.writeBytes(converter.numberTo8Bytes(utxoCache.totalSupply));
			w.writeBytes(miniUTXOsSerialized);
			if (w.isWritingComplete) return w.getBytes();
			else throw new Error(`UTXO cache serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
	},
    deserialize: {
		/** @param {Uint8Array} encodedData */
        rawData(encodedData) {
            return msgpack.decode(encodedData);
        },
        /** @param {Uint8Array} serializedAnchor */
        anchor(serializedAnchor) {
			const r = new BinaryReader(serializedAnchor);
			const blockHeight = converter.bytes4ToNumber(r.read(4));
			const txIndex = converter.bytes2ToNumber(r.read(2));
			const inputIndex = converter.bytes2ToNumber(r.read(2));
			if (r.isReadingComplete) return `${blockHeight}:${txIndex}:${inputIndex}`;
			else throw new Error(`Anchor is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
        /** @param {Uint8Array} serializedAnchorsArray */
        anchorsArray(serializedAnchorsArray) {
			/** @type {TxAnchor[]} */
            const anchors = [];
            for (let i = 0; i < serializedAnchorsArray.length; i += lengths.anchor)
                anchors.push(this.anchor(serializedAnchorsArray.slice(i, i + lengths.anchor)));
            return anchors;
        },
        /** @param {Uint8Array} serializedAnchorsObj */
        anchorsObjFromArray(serializedAnchorsObj) {
			/** @type {Object<string, boolean>} */
			const anchorsObj = {};
			for (const anchor of this.anchorsArray(serializedAnchorsObj || [])) anchorsObj[anchor] = true;
			return anchorsObj;
        },
		/** Deserialize a miniUTXO: { address, amount, rule } @param {Uint8Array} serializedMiniUTXO */
        miniUTXO(serializedMiniUTXO) {
			const r = new BinaryReader(serializedMiniUTXO);
			const address = converter.addressBytesToBase58(r.read(lengths.address));
			const amount = converter.bytes8ToNumber(r.read(8));
			const rule = UTXO_RULESNAME_FROM_CODE[r.read(1)[0]];
			if (r.isReadingComplete) return { address, amount, rule };
			else throw new Error(`miniUTXO is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
        /** @param {Uint8Array} serializedMiniUTXOs */
        miniUTXOsArray(serializedMiniUTXOs) {
            const miniUTXOs = [];
            for (let i = 0; i < serializedMiniUTXOs.length; i += lengths.miniUTXO)
                miniUTXOs.push(this.miniUTXO(serializedMiniUTXOs.slice(i, i + lengths.miniUTXO)));
            return miniUTXOs;
        },
        /** @param {Uint8Array} serializedMiniUTXOs */
        miniUTXOsObj(serializedMiniUTXOs) {
			if (serializedMiniUTXOs.length % (lengths.anchor + lengths.miniUTXO) !== 0) throw new Error('Serialized miniUTXOs length is invalid');
			/** @type {Object<TxAnchor, Uint8Array>} */
			const miniUTXOsObj = {};
			const expectedNbOfUTXOs = serializedMiniUTXOs.length / (lengths.anchor + lengths.miniUTXO);
			const r = new BinaryReader(serializedMiniUTXOs);
			for (let i = 0; i < expectedNbOfUTXOs; i++) {
				const anchor = this.anchor(r.read(lengths.anchor));
				miniUTXOsObj[anchor] = r.read(lengths.miniUTXO);
			}
			return miniUTXOsObj;
        },
		/** @param {Uint8Array} serializedTxsRef */
        txsReferencesArray(serializedTxsRef) {
			if (serializedTxsRef.length % lengths.txReference !== 0) throw new Error('Serialized txsReferences length is invalid');
			/** @type {TxReference[]} */
			const txsRef = [];
			const expectedNbOfTxsRef = serializedTxsRef.length / lengths.txReference;
			const r = new BinaryReader(serializedTxsRef);
			for (let i = 0; i < expectedNbOfTxsRef; i++) {
				const blockHeight = converter.bytes4ToNumber(r.read(4));
				const txIndex = converter.bytes2ToNumber(r.read(2));
				txsRef.push(`${blockHeight}:${txIndex}`);
			}
			return txsRef;
        },
		/** @param {Uint8Array} serializedPubkeyAddresses */
		pubkeyAddressesObj(serializedPubkeyAddresses) {
			if (serializedPubkeyAddresses.length % (lengths.pubKey + lengths.address) !== 0) throw new Error('Serialized pubkeyAddresses length is invalid');
			/** @type {Object<string, string>} */
			const pubkeyAddresses = {};
			const expectedNbOfEntries = serializedPubkeyAddresses.length / (lengths.pubKey + lengths.address);
			const r = new BinaryReader(serializedPubkeyAddresses);
			for (let i = 0; i < expectedNbOfEntries; i++) {
				const pubKeyHex = converter.bytesToHex(r.read(lengths.pubKey));
				const addressBase58 = converter.addressBytesToBase58(r.read(lengths.address));
				pubkeyAddresses[pubKeyHex] = addressBase58;
			}
			return pubkeyAddresses;
		},
		/** @param {Uint8Array} serializedWitnesses */
		witnessesArray(serializedWitnesses) {
			if (serializedWitnesses.length % lengths.witness !== 0) throw new Error('Serialized witnesses length is invalid');
			const witnesses = [];
			const expectedNbOfWitnesses = serializedWitnesses.length / lengths.witness;
			const r = new BinaryReader(serializedWitnesses);
			for (let i = 0; i < expectedNbOfWitnesses; i++) {
				const signature = converter.bytesToHex(r.read(64));
				const pubKey = converter.bytesToHex(r.read(32));
				witnesses.push(`${signature}:${pubKey}`);
			}
			return witnesses;
		},
		/** @param {Uint8Array} serializedTx @param {'tx' | 'validator' | 'miner'} [mode] default: normal */
		transaction(serializedTx, mode = 'tx') {
			const r = new BinaryReader(serializedTx);
			const version = converter.bytes2ToNumber(r.read(2));
			const nbOfWitnesses = converter.bytes2ToNumber(r.read(2));
			const nbOfInputs = converter.bytes2ToNumber(r.read(2));
			const nbOfOutputs = converter.bytes2ToNumber(r.read(2));
			const dataLength = converter.bytes2ToNumber(r.read(2));
			const witnesses = mode !== 'miner' ? this.witnessesArray(r.read(nbOfWitnesses * lengths.witness)) : [];
			const inputs = mode === 'tx' ? this.anchorsArray(r.read(nbOfInputs * lengths.anchor)) : [];
			if (mode === 'miner') inputs.push(converter.bytesToHex(r.read(4), 4)); // nonce
			if (mode === 'validator') {
				const address = converter.addressBytesToBase58(r.read(16));
				const posHash = converter.bytesToHex(r.read(32));
				inputs.push(`${address}:${posHash}`);
			}
			const outputs = this.miniUTXOsArray(r.read(nbOfOutputs * lengths.miniUTXO));
			const data = dataLength ? r.read(dataLength) : undefined;

			if (!r.isReadingComplete) throw new Error('Transaction is not fully deserialized');
			return new Transaction(inputs, outputs, witnesses, undefined, undefined, version, data);
		},
		/** @param {Uint8Array} serializedBlock @param {'finalized' | 'candidate'} [mode] default: finalized */
		block(serializedBlock, mode = 'finalized') {
			const r = new BinaryReader(serializedBlock);
			const nbOfTxs = converter.bytes2ToNumber(r.read(2));
			const index = converter.bytes4ToNumber(r.read(4));
			const supply = converter.bytes8ToNumber(r.read(8));
			const coinBase = converter.bytes4ToNumber(r.read(4));
			const difficulty = converter.bytes4ToNumber(r.read(4));
			const legitimacy = converter.bytes2ToNumber(r.read(2));
			const prevHash = converter.bytesToHex(r.read(32));
			const posTimestamp = converter.bytes8ToNumber(r.read(8));

			let timestamp, powReward;
			if (mode === 'finalized') timestamp = converter.bytes8ToNumber(r.read(8));
			if (mode === 'candidate') powReward = converter.bytes8ToNumber(r.read(8));
			
			let hash, nonce;
			if (mode === 'finalized') {
				hash = converter.bytesToHex(r.read(32));
				nonce = converter.bytes4ToNumber(r.read(4));
			}

			// POINTERS & TXS -> This specific traitment offer better reading performance:
			// no need to deserialize the whole block to read the txs
			const txPointers = [];
			for (let i = 0; i < nbOfTxs; i++)
				txPointers.push(converter.bytes4ToNumber(r.read(4)));

			if (txPointers.length !== nbOfTxs) throw new Error('Invalid txs pointers');
			
			const txs = [];
			for (let i = 0; i < nbOfTxs; i++) {
				const start = txPointers[i];
				const end = i + 1 < nbOfTxs ? txPointers[i + 1] : serializedBlock.length;
				txs.push(this.transaction(r.read(end - start), serializer.specialMode[mode][i]));
			}

			if (!r.isReadingComplete) throw new Error('Block is not fully deserialized');
			return new BlockData(index, supply, coinBase, difficulty, legitimacy, prevHash, txs, posTimestamp, timestamp, hash, nonce, powReward);
		},
		/** @param {Uint8Array} serializedNodeSetting */
        nodeSetting(serializedNodeSetting) {
			const r = new BinaryReader(serializedNodeSetting);
			const privateKey = converter.bytesToHex(r.read(32));
			const validatorRewardAddress = converter.addressBytesToBase58(r.read(16));
			const minerAddress = converter.addressBytesToBase58(r.read(16));
			const minerThreads = r.read(1)[0];
            return { privateKey, validatorRewardAddress, minerAddress, minerThreads };
        }
    }
};