// @ts-check
import { ADDRESS } from '../types/address.mjs';
import { SIZES } from './serializer-schema.mjs';
import { BinaryReader, BinaryWriter } from './binary-helpers.mjs';
import { Transaction_Builder } from '../node/src/transaction.mjs';
import { BlockFinalized, BlockCandidate } from '../types/block.mjs';
import { Converter, QsafeSigner, QsafeHelper } from '../node/src/conCrypto.mjs';
import { Transaction, LedgerUtxo, TxOutput, UTXO_RULES_GLOSSARY, UTXO_RULESNAME_FROM_CODE } from '../types/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
export { SIZES, BinaryReader, BinaryWriter };

/**
* @typedef {import("../types/transaction.mjs").UTXO} UTXO
* @typedef {import("../types/transaction.mjs").TxId} TxId
* @typedef {import("../types/transaction.mjs").Witness} Witness
* @typedef {import("../types/transaction.mjs").TxAnchor} TxAnchor
* @typedef {import("../types/transaction.mjs").UtxoState} UtxoState
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

/** Two bytes (Uint16) encoder/decoder (values 0 and 1 are reserved)
 * - Shift the value by 2 to fit in the range 2-255 for each byte
 * - Use this method to optimize UTXO state search with indexOf() => No fake positive are allowed
 * - Also used by identity store to write the pointer of an address (blockIndex + txIndex) where txIndex is Uint16.
 * - Max value: 64516 */
export class NonZeroUint16 {
    #buffer = new ArrayBuffer(2);
    #bytes = new Uint8Array(this.#buffer);
    
	/** 0 - 64516 @param {number} value */
    encode(value) {
        this.#bytes[0] = Math.floor(value / 254) + 2;  	// MSB: 2-255
        this.#bytes[1] = (value % 254) + 2;             // LSB: 2-255
        return this.#bytes;
    }
    /** @param {Uint8Array} bytes */
    decode(bytes) {
        return (bytes[0] - 2) * 254 + (bytes[1] - 2);
    }
}

const dataPositions = { // specific helpers for partial block reading
	timestampInFinalizedBlock: SIZES.blockFinalizedHeader.bytes - SIZES.timestamp.bytes - SIZES.hash.bytes - SIZES.nonce.bytes,
}

/** Theses functions are used to serialize and deserialize the data of the blockchain.
 * 
 * - functions do not check the input data.
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
        /** @param {TxAnchor} anchor ex: blockHeight:txIndex:vout */
        anchor(anchor) {
			const w = new BinaryWriter(SIZES.anchor.bytes);
			const { height, txIndex, vout } = serializer.parseAnchor(anchor);
			w.writeBytes(converter.numberTo4Bytes(height));
			w.writeBytes(serializer.nonZeroUint16.encode(txIndex));
			w.writeBytes(serializer.nonZeroUint16.encode(vout));
			return w.getBytesOrThrow(`Anchor serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
        /** @param {TxAnchor[]} anchors */
        anchorsArray(anchors) {
			const w = new BinaryWriter(SIZES.anchor.bytes * anchors.length);
            for (let j = 0; j < anchors.length; j++) { // -> anchor ex: "3:2:0"
				const { height, txIndex, vout } = serializer.parseAnchor(anchors[j]);
				w.writeBytes(converter.numberTo4Bytes(height));
				w.writeBytes(serializer.nonZeroUint16.encode(txIndex));
				w.writeBytes(serializer.nonZeroUint16.encode(vout));
            };
			return w.getBytesOrThrow(`Anchors array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
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
        /** serialize the UTXO as a miniUTXO: {address, amount, rule} @param {UTXO | TxOutput} utxo */
        miniUTXO(utxo) {
			const rule = UTXO_RULES_GLOSSARY[utxo.rule];
			if (!rule) throw new Error(`Unknown UTXO rule: ${utxo.rule}`);

			const w = new BinaryWriter(SIZES.miniUTXO.bytes);
			w.writeBytes(ADDRESS.B58_TO_BYTES(utxo.address));
			w.writeBytes(converter.numberTo6Bytes(utxo.amount));
			w.writeByte(rule.code);
			return w.getBytesOrThrow(`miniUTXO serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {UTXO[] | TxOutput[]} utxos */
        miniUTXOsArray(utxos) {
			const w = new BinaryWriter(SIZES.miniUTXO.bytes * utxos.length);
			for (let i = 0; i < utxos.length; i++) {
				const rule = UTXO_RULES_GLOSSARY[utxos[i].rule];
				if (!rule) throw new Error(`Unknown UTXO rule: ${utxos[i].rule}`);
				w.writeBytes(ADDRESS.B58_TO_BYTES(utxos[i].address));
				w.writeBytes(converter.numberTo6Bytes(utxos[i].amount));
				w.writeByte(rule.code);
			}
			return w.getBytesOrThrow(`miniUTXOs array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
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
				w.writeBytes(ADDRESS.B58_TO_BYTES(utxo.address));
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
		/** @param {UtxoState[]} utxoStates */
		utxosStatesArray(utxoStates) {
			const w = new BinaryWriter(utxoStates.length * SIZES.utxoState.bytes);
			for (const utxoState of utxoStates) {
				w.writeBytes(serializer.nonZeroUint16.encode(utxoState.txIndex));
				w.writeBytes(serializer.nonZeroUint16.encode(utxoState.vout));
				w.writeByte(utxoState.spent ? 1 : 0);
			}
			return w.getBytesOrThrow(`UTXO states array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {ADDRESS} address @param {number} threshold @param {string[]} pubKeysHex */
		identityEntry(address, threshold, pubKeysHex) {
			const pks = pubKeysHex.map(hybridKeyHex => converter.hexToBytes(hybridKeyHex));
			const pointersSize = BinaryWriter.calculatePointersSize(pks.length);
			const totalPksSize = pks.reduce((sum, pk) => sum + pk.length, 0);
			const w = new BinaryWriter(address.bytes.length + 1 + pointersSize + totalPksSize);
			w.writeBytes(address.bytes);    	// 5b
			w.writeByte(threshold);		  		// 1b
			w.writePointersAndDataChunks(pks);  // unspecified.
			return w.getBytesOrThrow(`Identity entry serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
		/** @param {Witness} witness 	ex: [address, hint, signature] */
		witness(witness) {
			if (witness.length !== 3) throw new Error(`Invalid witness: should be an array of 3 elements [address, hint, signature], got ${witness.length} elements`);

			const signatureBytes = converter.hexToBytes(witness[2]);
			const w = new BinaryWriter(SIZES.address.bytes + SIZES.hint.bytes + signatureBytes.length);
			w.writeBytes(ADDRESS.B58_TO_BYTES(witness[0])); // address
			w.writeBytes(converter.hexToBytes(witness[1])); // hint
			w.writeBytes(signatureBytes); // signature
			return w.getBytesOrThrow(`Witness serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
        /** @param {Witness[]} witnesses ex: [ [address, hint, signature], ...] */
        witnessesArray(witnesses) {
			const witnessesAsArrays = [];
			for (const w of witnesses) witnessesAsArrays.push(this.witness(w));

			const pointersSize = BinaryWriter.calculatePointersSize(witnessesAsArrays.length);
			const totalWitnessesSize = witnessesAsArrays.reduce((sum, w) => sum + w.length, 0);
			const w = new BinaryWriter(pointersSize + totalWitnessesSize);
			w.writePointersAndDataChunks(witnessesAsArrays);
			return w.getBytesOrThrow(`Witnesses array serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
		},
        /** @param {Transaction} tx @param {'tx' | 'validator' | 'solver'} [mode] default: tx */
        transaction(tx, mode = 'tx') {
			if (mode === 'solver' && tx.witnesses.length !== 0) throw new Error('Invalid coinbase transaction: should not have witnesses');
			if (mode === 'solver' && (tx.inputs.length !== 1 || tx.inputs[0].length !== SIZES.nonce.str)) throw new Error('Invalid coinbase transaction');
            if (mode === 'validator' && (tx.inputs.length !== 1 || tx.inputs[0].length !== SIZES.validatorInput.str)) throw new Error('Invalid transaction: validator input must be posHash');
			if (tx.data && !(tx.data instanceof Uint8Array)) throw new Error('Transaction data must be a Uint8Array');

			// Calculate the size of each part of the transaction for efficient serialization
			const witnessesBytes = tx.witnesses.length ? this.witnessesArray(tx.witnesses) : null;
			const witnessesSize = witnessesBytes ? witnessesBytes.length : 0;

			const identitiesPointersSize = tx.identities.length ? BinaryWriter.calculatePointersSize(tx.identities.length) : 0;
			const identitiesSumSize = tx.identities.length ? tx.identities.reduce((sum, identity) => sum + identity.length, 0) : 0;
			const identitiesSize = identitiesPointersSize + identitiesSumSize;

			let inputSize = SIZES.anchor.bytes;
			if (mode === 'solver') inputSize = 4; 					 // input = nonce
			if (mode === 'validator') inputSize = SIZES.validatorInput.bytes; // input = posHash
			const inputsSize = tx.inputs.length * inputSize;
			const outputsSize = tx.outputs.length * SIZES.miniUTXO.bytes;
			const dataSize = tx.data?.length || 0;	// arbitrary data

			// header (12) => version(2) + witnesses(2) + identities(2) + inputs(2) + outputs(2) + dataLength(2)
			const totalSize = SIZES.txHeader.bytes + witnessesSize + identitiesSize + inputsSize + outputsSize + dataSize;
			if (totalSize > BLOCKCHAIN_SETTINGS.maxTransactionSize) throw new Error(`Transaction size ${totalSize} exceeds maximum allowed size of ${BLOCKCHAIN_SETTINGS.maxTransactionSize} bytes`);
			
			const w = new BinaryWriter(totalSize);
			w.writeBytes(converter.numberTo2Bytes(tx.version)); 				// version
			w.writeBytes(converter.numberTo2Bytes(tx.witnesses?.length || 0)); 	// nb of witnesses
			w.writeBytes(converter.numberTo2Bytes(tx.identities?.length || 0)); // nb of identities
			w.writeBytes(converter.numberTo2Bytes(tx.inputs.length)); 			// nb of inputs
			w.writeBytes(converter.numberTo2Bytes(tx.outputs.length));			// nb of outputs
			w.writeBytes(converter.numberTo2Bytes(tx.data?.length || 0)); 		// data: bytes
			if (witnessesBytes) w.writeBytes(witnessesBytes);					// witnesses
			if (tx.identities.length) w.writePointersAndDataChunks(tx.identities); // identities
			if (mode === 'tx') w.writeBytes(this.anchorsArray(tx.inputs));		// inputs
			else if (mode === 'solver') w.writeBytes(converter.hexToBytes(tx.inputs[0])); 				// nonce | posHash (hex)
			else if (mode === 'validator') { // validator input: <address:hash>
				const s = tx.inputs[0].split(':');
				if (s.length !== 2) throw new Error(`Invalid validator input format: ${tx.inputs[0]}`);
				w.writeBytes(ADDRESS.B58_TO_BYTES(s[0]));
				w.writeBytes(converter.hexToBytes(s[1]));
			}
			w.writeBytes(this.miniUTXOsArray(tx.outputs));						// outputs
			if (tx.data) w.writeBytes(tx.data);									// data
			
			return w.getBytesOrThrow(`Transaction serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`);
        },
		/** @param {Transaction[]} txs - Validator or solver tx excluded. */
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
		/** @param {NodeSetting} nodeSetting */
        nodeSetting(nodeSetting) {
			const w = new BinaryWriter(32 + SIZES.address.bytes + SIZES.address.bytes + 1);
			w.writeBytes(converter.hexToBytes(nodeSetting.privateKey));
			w.writeBytes(ADDRESS.B58_TO_BYTES(nodeSetting.validatorRewardAddress));
			w.writeBytes(ADDRESS.B58_TO_BYTES(nodeSetting.solverAddress));
			w.writeByte(nodeSetting.solverThreads);
            return w.getBytes();
        },
		/** @param {number} fromHeight @param {number} toHeight */
		blocksTimestampsRequest(fromHeight, toHeight) {
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
		/** @param {Array<{address: string, pubkeys: Set<string>}>} roundsLegitimacies */
		roundsLegitimaciesResponse(roundsLegitimacies) {
			let entries = [];
			for (const entry of roundsLegitimacies) {
				let pubKeysBytes = [];
				for (const pubkey of entry.pubkeys) pubKeysBytes.push(converter.hexToBytes(pubkey));
				
				const pointersSize = BinaryWriter.calculatePointersSize(pubKeysBytes.length);
				const w = new BinaryWriter(SIZES.address.bytes + pointersSize + pubKeysBytes.reduce((sum, bytes) => sum + bytes.length, 0));
				w.writeBytes(ADDRESS.B58_TO_BYTES(entry.address));
				w.writePointersAndDataChunks(pubKeysBytes);
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
        /** @param {Uint8Array} serializedAnchor */
        anchor(serializedAnchor) {
			const r = new BinaryReader(serializedAnchor);
			const blockHeight = converter.bytes4ToNumber(r.read(4));
			const txIndex = serializer.nonZeroUint16.decode(r.read(2));
			const inputIndex = serializer.nonZeroUint16.decode(r.read(2));
			if (r.isReadingComplete) return `${blockHeight}:${txIndex}:${inputIndex}`;
			else throw new Error(`Anchor is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
        /** @param {Uint8Array} serializedAnchorsArray */
        anchorsArray(serializedAnchorsArray) {
			/** @type {TxAnchor[]} */
            const anchors = [];
			const r = new BinaryReader(serializedAnchorsArray);
			for (let i = 0; i < serializedAnchorsArray.length; i += SIZES.anchor.bytes) {
				const blockHeight = converter.bytes4ToNumber(r.read(4));
				const txIndex = serializer.nonZeroUint16.decode(r.read(2));
				const inputIndex = serializer.nonZeroUint16.decode(r.read(2));
				anchors.push(`${blockHeight}:${txIndex}:${inputIndex}`);
			}
			if (r.isReadingComplete) return anchors;
			else throw new Error(`Anchors array is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
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
		/** Deserialize a miniUTXO: { address, amount, rule } @param {Uint8Array} serializedMiniUTXO */
        miniUTXO(serializedMiniUTXO) {
			const r = new BinaryReader(serializedMiniUTXO);
			const address = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
			const amount = converter.bytes6ToNumber(r.read(6));
			const rule = UTXO_RULESNAME_FROM_CODE[r.read(1)[0]];
			if (r.isReadingComplete) return { address, amount, rule };
			else throw new Error(`miniUTXO is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
        /** @param {Uint8Array} serializedMiniUTXOs */
        miniUTXOsArray(serializedMiniUTXOs) {
			const miniUTXOs = [];
			const r = new BinaryReader(serializedMiniUTXOs);
			for (let i = 0; i < serializedMiniUTXOs.length; i += SIZES.miniUTXO.bytes) {
				const address = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
				const amount = converter.bytes6ToNumber(r.read(6));
				const rule = UTXO_RULESNAME_FROM_CODE[r.read(1)[0]];
				miniUTXOs.push({ address, amount, rule });
			}
			if (r.isReadingComplete) return miniUTXOs;
			else throw new Error(`miniUTXOs array is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
        },
		/** @param {Uint8Array} serializedMiniUTXOsObj */
		miniUTXOsObj(serializedMiniUTXOsObj) {
			/** @type {Record<TxAnchor, { address: string, amount: number, rule: string }>} */
			const miniUTXOsObj = {};
			const r = new BinaryReader(serializedMiniUTXOsObj);
			for (let i = 0; i < serializedMiniUTXOsObj.length; i += (SIZES.anchor.bytes + SIZES.miniUTXO.bytes)) {
				const anchor = this.anchor(r.read(SIZES.anchor.bytes));
				const address = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
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
		/** @param {Uint8Array} txData */
		identityEntry(txData) {
			const r = new BinaryReader(txData);
			const address = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
			const threshold = r.read(1)[0];
			const pubKeysHex = [];
			const pks = r.readPointersAndExtractDataChunks();
			for (const pk of pks) pubKeysHex.push(converter.bytesToHex(pk));
			return { address, pubKeysHex, threshold };
		},
		/** @param {Uint8Array} serializedWitness */
		witness(serializedWitness) {
			if (serializedWitness.length < SIZES.address.bytes + SIZES.hint.bytes) throw new Error('Serialized witness is too short to contain required fields');
			const r = new BinaryReader(serializedWitness);
			const address = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
			const hint = converter.bytesToHex(r.read(SIZES.hint.bytes));
			const signature = converter.bytesToHex(r.read(r.view.length - r.cursor));
			if (r.isReadingComplete) return [address, hint, signature];
			else throw new Error(`Witness is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
		},
		/** @param {BinaryReader} r BinaryReader with cursor set at start of witnesses array */
		witnessesArray(r) {
			const witnesses = [];
			const witnessAsArrays = r.readPointersAndExtractDataChunks();
			for (const witnessAsArray of witnessAsArrays) witnesses.push(this.witness(witnessAsArray));
			return witnesses;
		},
		/** @param {Uint8Array} serializedTx @param {'tx' | 'validator' | 'solver'} [mode] default: normal */
		transaction(serializedTx, mode = 'tx') {
			if (serializedTx.length > BLOCKCHAIN_SETTINGS.maxTransactionSize) throw new Error('Serialized transaction exceeds maximum allowed size');

			const r = new BinaryReader(serializedTx);
			const version = converter.bytes2ToNumber(r.read(2));
			const nbOfWitnesses = converter.bytes2ToNumber(r.read(2));
			const nbOfIdentities = converter.bytes2ToNumber(r.read(2));
			const nbOfInputs = converter.bytes2ToNumber(r.read(2));
			const nbOfOutputs = converter.bytes2ToNumber(r.read(2));
			const dataLength = converter.bytes2ToNumber(r.read(2));

			if (nbOfWitnesses && mode === 'solver') throw new Error('Invalid transaction: coinbase transaction should not have witnesses');
			const witnesses = nbOfWitnesses ? this.witnessesArray(r) : [];
			if (nbOfWitnesses !== witnesses.length) throw new Error('Number of witnesses does not match the expected count in transaction header');

			const identities = nbOfIdentities ? r.readPointersAndExtractDataChunks() : [];
			if (nbOfIdentities !== identities.length) throw new Error('Number of identities does not match the expected count in transaction header');

			const inputs = mode === 'tx' ? this.anchorsArray(r.read(nbOfInputs * SIZES.anchor.bytes)) : [];
			if (mode === 'solver') inputs.push(converter.bytesToHex(r.read(4), 4)); // nonce
			if (mode === 'validator') { // validator input format: <address:hash>
				const address = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
				const posHash = converter.bytesToHex(r.read(SIZES.hash.bytes));
				inputs.push(`${address}:${posHash}`);
			}

			const outputs = this.miniUTXOsArray(r.read(nbOfOutputs * SIZES.miniUTXO.bytes));
			const data = dataLength ? r.read(dataLength) : undefined;

			if (!r.isReadingComplete) throw new Error('Transaction is not fully deserialized');
			return new Transaction(inputs, outputs, witnesses, identities, data, version);
		},
		/** @param {Uint8Array} serializedTxs - Validator and solver txs should be excluded */
		transactions(serializedTxs) {
			const r = new BinaryReader(serializedTxs);
			const txs = r.readPointersAndExtractDataChunks('pointer32');
			const transactions = [];
			for (const tx of txs) transactions.push(this.transaction(tx));
			if (!r.isReadingComplete) throw new Error('Transactions are not fully deserialized');
			return transactions;
		},
		/** @param {Uint8Array} serializedBlock @param {'finalized' | 'candidate'} [mode] default: finalized */
		blockData(serializedBlock, mode = 'finalized') { // local use only
			const r = new BinaryReader(serializedBlock);
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
			const validatorRewardAddress = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
			const solverAddress = ADDRESS.BYTES_TO_B58(r.read(SIZES.address.bytes));
			const solverThreads = r.read(1)[0];
            return { privateKey, validatorRewardAddress, solverAddress, solverThreads };
        },
		/** @param {Uint8Array} serializedRequest */
		blocksTimestampsRequest(serializedRequest) {
			const r = new BinaryReader(serializedRequest);
			const fromHeight = converter.bytes4ToNumber(r.read(4));
			const toHeight = converter.bytes4ToNumber(r.read(4));
			if (r.isReadingComplete) return { fromHeight, toHeight };
			else throw new Error(`BlocksTimestampsRequest is not fully deserialized: read ${r.cursor} of ${r.view.length} bytes`);
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
				const address = ADDRESS.BYTES_TO_B58(entryReader.read(SIZES.address.bytes));
				const pubKeys = new Set();
				const pubKeysBytes = entryReader.readPointersAndExtractDataChunks();
				for (const pubKeyBytes of pubKeysBytes) pubKeys.add(converter.bytesToHex(pubKeyBytes));
				roundsLegitimacies.push({ address, pubKeys });
			}
			return roundsLegitimacies;
		},
		/** @param {Uint8Array} serializedResponse */
		transactionsResponse(serializedResponse) {
			/** @type {Record<TxId, Transaction>} */
			const txs = {};
			const r = new BinaryReader(serializedResponse);

			/* @type {Record<TxAnchor, { address: string, amount: number, rule: string }>} */
			/*const impliedUtxos = {};
			const nbOfImpliedUtxos = converter.bytes4ToNumber(r.read(4));
			for (let i = 0; i < nbOfImpliedUtxos; i++) {
				const anchor = this.anchor(r.read(SIZES.anchor.bytes));
				const miniUtxo = this.miniUTXO(r.read(SIZES.miniUTXO.bytes));
				impliedUtxos[anchor] = miniUtxo;
			}*/

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