// @ts-check

import { ADDRESS } from './address.mjs';
import { Converter } from '../node/src/conCrypto.mjs';
import { SIZES } from '../utils/serializer-schema.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
import { BinaryReader, BinaryWriter, NonZeroUint16 } from '../utils/binary-helpers.mjs';

/**
 * @typedef {Object} UTXORule
 * @property {number} code 			- The code of the rule
 * @property {string} description 	- The description of the rule
 * @property {number} [withdrawLockBlocks] - Number of blocks to lock for 'sigOrSlash' rule
 * @property {number} [lockUntilBlock] - Block height until which the UTXO is locked for 'lockUntilBlock' rule
 * 
 * @typedef {string[]} Witness 	- A string array in the format [address, signature]
 * @typedef {Uint8Array} IdentityEntry - binary entry, e.g: [vout: 2b][threshold: 1b][pointers & pubkeys]
 *
 * @typedef {string} TxAnchor 	- The path to the UTXO, ex: blockHeight:txIndex:vout
 * @typedef {string} TxId 		- The path to the transaction, ex: blockHeight:txIndex
 * @typedef {string} VoutId 	- The path to the output, ex: txIndex:vout */

const VERSION = 1;
const converter = new Converter();
const nonZeroUint16 = new NonZeroUint16();

/** @type {Record<string, UTXORule>} */
export const UTXO_RULES_GLOSSARY = {
    sig: { code: 0, description: 'Simple signature verification' },
    sigOrSlash: { code: 1, description: "Open right to slash the UTXO if validator's fraud proof is provided", withdrawLockBlocks: 144 },
    lockUntilBlock: { code: 2, description: 'UTXO locked until block height', lockUntilBlock: 0 },
    multiSigCreate: { code: 3, description: 'Multi-signature creation' },
    p2pExchange: { code: 4, description: 'Peer-to-peer exchange' },
    lightHousePause: { code: 6, description: 'LightHouse pause' },
    lightHouseResume: { code: 7, description: 'LightHouse resume' },
};

/** @type {Record<number, string>} */
export const UTXO_RULESNAME_FROM_CODE = {
    0: 'sig',
    1: 'sigOrSlash',
    2: 'lockUntilBlock',
    3: 'multiSigCreate',
    4: 'p2pExchange'
};

export class TxOutput {
	/** @param {number} amount - the amount of microConts @param {string} rule - the unlocking rule @param {string} address - output only */
	constructor(amount, rule, address) {
		this.address = address;
		this.amount = amount;
		this.rule = rule;
	}
}

export class UTXO {
	/** @param {TxAnchor} anchor - the path to the UTXO blockHeight:txIndex:vout @param {number} amount - the amount of microConts @param {string} rule - the unlocking rule @param {string} address - the address of the recipient @param {boolean} [spent] - if the UTXO has been spent, default: false */
	constructor(anchor, amount, rule, address, spent = false) {
		this.address = address;
		this.amount = amount;
		this.anchor = anchor;
		this.rule =  rule;
		this.spent = spent;
	}

	/** @param {string} address @param {LedgerUtxo} ledgerUtxo */
	static fromLedgerUtxo(address, ledgerUtxo) {
		const ruleName = UTXO_RULESNAME_FROM_CODE[ledgerUtxo.ruleCode];
		return new UTXO(ledgerUtxo.anchor, ledgerUtxo.amount, ruleName, address, false);
	}
	/** @param {string} address @param {LedgerUtxo[]} ledgerUtxos @param {Set<number>} [ruleCodesToExclude] */
	static fromLedgerUtxos(address, ledgerUtxos, ruleCodesToExclude) {
		const UTXOs = [];
		for (const l of ledgerUtxos)
			if (ruleCodesToExclude?.has(l.ruleCode)) continue;
			else UTXOs.push(UTXO.fromLedgerUtxo(address, l));

		return UTXOs;
	}
}

/** Lightweight UTXO representation without address, unspent only */
export class LedgerUtxo {
	/** @param {TxAnchor} anchor @param {number} amount @param {number} ruleCode */
	constructor(anchor, amount, ruleCode) {
		this.anchor = anchor;
		this.amount = amount;
		this.ruleCode = ruleCode;
	}

	/** @param {UTXO} utxo */
	static fromUTXO(utxo) {
		const ruleCode = UTXO_RULES_GLOSSARY[utxo.rule].code;
		return new LedgerUtxo(utxo.anchor, utxo.amount, ruleCode);
	}
	/** @param {UTXO[]} utxos */
	static fromUTXOs(utxos) {
		return utxos.map(utxo => LedgerUtxo.fromUTXO(utxo));
	}
}

export class Transfer {
	/** @param {string} recipientAddress @param {number} amount */
	constructor(recipientAddress, amount) {
		this.recipientAddress = recipientAddress;
		this.amount = amount;
	}
}

export class Transaction {
	/**
	 * @param {TxAnchor[]} inputs @param {TxOutput[]} outputs @param {number} [lastValidHeight] default: max uint32 value
	 * @param {Witness[]} [witnesses]
	 * @param {IdentityEntry[]} [identities] The newly delaclared identities.
	 * @param {Uint8Array[]} [utxoParams]
	 * @param {Uint8Array | undefined} [data] Arbitrary data attached to the transaction
	 * @param {number} [version] @param {number | undefined} [feePerByte] @param {number | undefined} [byteWeight] @param {Record<string, number>} [inAmountByAddress] */
	constructor(inputs, outputs, lastValidHeight = 0xffffffff, witnesses = [], identities = [], utxoParams = [], data, version = VERSION, feePerByte, byteWeight, inAmountByAddress) {
		this.inputs = inputs;
		this.outputs = outputs;
		this.lastValidHeight = lastValidHeight;
		this.witnesses = witnesses;
		this.identities = identities;
		this.utxoParams = utxoParams;
		this.data = data;
		this.version = version;
		this.feePerByte = feePerByte;
		this.byteWeight = byteWeight;
		this.inAmountByAddress = inAmountByAddress;
	}

	/** @param {UTXO[]} utxos @param {TxOutput[]} outputs @param {number} [lastValidHeight] default: max uint32 value @param {Uint8Array[] | undefined} [identities] @param {Uint8Array | undefined} [data] */
	static fromUTXOs(utxos, outputs, lastValidHeight = 0xffffffff, identities, data) {
		/** @type {Record<string, number>} */
		const inAmountByAddress = {};
		const inputs = utxos.map(utxo => utxo.anchor);
		for (const utxo of utxos)
			if (!inAmountByAddress[utxo.address]) inAmountByAddress[utxo.address] = utxo.amount;
			else inAmountByAddress[utxo.address] += utxo.amount;

		return new Transaction(inputs, outputs, lastValidHeight, [], identities, undefined, data, VERSION, undefined, undefined, inAmountByAddress);
	}
}

export class TransactionWriter {
	/** The BinaryWriter initialized. Set cursor before external use */
	w; tx;
	type;
	witnessesSize;
	identitiesSize;
	inputsSize;
	outputsSize;
	utxoParamsSize;
	dataSize;

	/** @param {Transaction} tx @param {'tx' | 'solver' | 'validator'} [type] default: 'tx' */
	constructor(tx, type = 'tx') {
		if (type === 'solver' && tx.witnesses.length !== 0) throw new Error('Invalid coinbase transaction: should not have witnesses');
		if (type === 'solver' && (tx.inputs.length !== 1 || tx.inputs[0].length !== SIZES.nonce.str)) throw new Error('Invalid coinbase transaction');
        if (type === 'validator' && (tx.inputs.length !== 1 || tx.inputs[0].length !== SIZES.validatorInput.str)) throw new Error('Invalid transaction: validator input must be posHash');
		if (tx.data && !(tx.data instanceof Uint8Array)) throw new Error('Transaction data must be a Uint8Array');

		this.tx = tx;
		this.type = type;
		this.witnessesSize 	= this.#calculateWitnessesSize();
		this.identitiesSize = this.#calculateIdentitiesSize();
		this.utxoParamsSize = this.#calculateUtxoParamsSize();
		this.dataSize 		= tx.data?.length || 0;
		this.outputsSize 	= this.tx.outputs.length * SIZES.miniUTXO.bytes;
		this.inputsSize 	= this.type === 'tx' ? this.tx.inputs.length * SIZES.anchor.bytes
							: this.type === 'solver' ? SIZES.nonce.bytes // nonce
							: SIZES.validatorInput.bytes 				 // posHash

		// header (18) => version(2) + lastValidHeight(4) + witnessesSize(2) + identitiesSize(2) + utxoParamsSize(2) + inputsCount(2) + outputsCount(2) + dataSize(2)
		const totalSize = SIZES.txHeader.bytes + this.witnessesSize + this.identitiesSize + this.utxoParamsSize + this.inputsSize + this.outputsSize + this.dataSize;
		if (totalSize > BLOCKCHAIN_SETTINGS.maxTransactionSize) throw new Error(`Transaction size ${totalSize} exceeds maximum allowed size of ${BLOCKCHAIN_SETTINGS.maxTransactionSize} bytes`);
		else this.w = new BinaryWriter(totalSize);
	}
	#calculateWitnessesSize() {
		if (!this.tx.witnesses.length) return 0;
		const pointersSize = BinaryWriter.calculatePointersSize(this.tx.witnesses.length);
		const addressesSize = this.tx.witnesses.length * ADDRESS.CRITERIA.BYTES_LENGTH;
		const signaturesSize = this.tx.witnesses.length * this.tx.witnesses.reduce((sum, w) => sum + (w[1].length / 2), 0);
		return pointersSize + addressesSize + signaturesSize;
	}
	#calculateIdentitiesSize() {
		if (!this.tx.identities.length) return 0;
		const pointersSize = BinaryWriter.calculatePointersSize(this.tx.identities.length);
		const identitiesSize = this.tx.identities.reduce((sum, i) => sum + i.length, 0);
		return pointersSize + identitiesSize;
	}
	#calculateUtxoParamsSize() {
		if (!this.tx.utxoParams.length) return 0;
		const pointersSize = BinaryWriter.calculatePointersSize(this.tx.utxoParams.length);
		const identitiesSize = this.tx.utxoParams.reduce((sum, i) => sum + i.length, 0);
		return pointersSize + identitiesSize;
	}
	/** Set the reader cursor to start position of the section.
	 * @param {'witnesses' | 'identities' | 'utxoParams' | 'inputs' | 'outputs' | 'data'} section */
	#setCursorStartOf(section) {
		this.w.cursor = SIZES.txHeader.bytes;
		if (section === 'witnesses') return;
		this.w.cursor += this.witnessesSize;
		if (section === 'identities') return;
		this.w.cursor += this.identitiesSize;
		if (section === 'utxoParams') return;
		this.w.cursor += this.utxoParamsSize;
		if (section === 'inputs') return;
		this.w.cursor += this.inputsSize;
		if (section === 'outputs') return;
		this.w.cursor += this.outputsSize; // last section is 'data'
	}
	writeHeader() {
		this.w.writeBytes(converter.numberTo2Bytes(this.tx.version)); 			// version
		this.w.writeBytes(converter.numberTo4Bytes(this.tx.lastValidHeight)); 	// lastValidHeight
		this.w.writeBytes(converter.numberTo2Bytes(this.witnessesSize)); 		// witnessesSize
		this.w.writeBytes(converter.numberTo2Bytes(this.identitiesSize)); 		// identitiesSize
		this.w.writeBytes(converter.numberTo2Bytes(this.utxoParamsSize));		// utxoParamsSize
		this.w.writeBytes(converter.numberTo2Bytes(this.tx.inputs.length)); 	// nb of inputs
		this.w.writeBytes(converter.numberTo2Bytes(this.tx.outputs.length));	// nb of outputs
		this.w.writeBytes(converter.numberTo2Bytes(this.tx.data?.length || 0)); // data: bytes
	}
	writeWitnesses() {
		if (!this.witnessesSize) return;
		this.#setCursorStartOf('witnesses');
		const r = [];
		for (const witness of this.tx.witnesses) {
			if (witness.length !== 2) throw new Error(`Invalid witness: should be an array of 3 elements [address, signature], got ${witness.length} elements`);
			
			const signatureBytes = converter.hexToBytes(witness[1]);
			const w = new BinaryWriter(SIZES.address.bytes + signatureBytes.length);
			w.writeBytes(ADDRESS.addressToBytes(witness[0])); // address
			w.writeBytes(signatureBytes); // signature
			r.push(w.getBytesOrThrow(`Witness serialization incomplete: wrote ${w.cursor} of ${w.view.length} bytes`));
		}
		
		this.w.writePointersAndDataChunks(r);
	}
	writeIdentities() {
		if (!this.identitiesSize) return;
		this.#setCursorStartOf('identities');
		this.w.writePointersAndDataChunks(this.tx.identities);
	}
	writeUtxoParams() {
		if (!this.utxoParamsSize) return;
		this.#setCursorStartOf('utxoParams');
		this.w.writePointersAndDataChunks(this.tx.utxoParams);
	}
	writeInputs() {
		if (!this.inputsSize) return;
		this.#setCursorStartOf('inputs');
		if (this.type === 'solver') this.w.writeBytes(converter.hexToBytes(this.tx.inputs[0])); // nonce | posHash (hex)
		else if (this.type === 'tx') {
			for (const input of this.tx.inputs) { // -> anchors, ex: "3:2:0"
				const s = input.split(':');
				if (s.length !== 3) throw new Error(`Invalid validator input format: ${this.tx.inputs[0]}`);
				this.w.writeBytes(converter.numberTo4Bytes(parseInt(s[0], 10))); 	// height
				this.w.writeBytes(nonZeroUint16.encode(parseInt(s[1], 10)));		// txIndex
				this.w.writeBytes(nonZeroUint16.encode(parseInt(s[2], 10))); 		// vout
			}
		} else if (this.type === 'validator') { // validator input: <address:hash>
			const s = this.tx.inputs[0].split(':');
			if (s.length !== 2) throw new Error(`Invalid validator input format: ${this.tx.inputs[0]}`);
			this.w.writeBytes(ADDRESS.addressToBytes(s[0]));
			this.w.writeBytes(converter.hexToBytes(s[1]));
		}
	}
	writeOutputs() {
		if (!this.outputsSize) return;
		this.#setCursorStartOf('outputs');
		for (const utxo of this.tx.outputs) {
			const rule = UTXO_RULES_GLOSSARY[utxo.rule];
			if (!rule) throw new Error(`Unknown UTXO rule: ${utxo.rule}`);
			this.w.writeBytes(ADDRESS.addressToBytes(utxo.address));
			this.w.writeBytes(converter.numberTo6Bytes(utxo.amount));
			this.w.writeByte(rule.code);
		}
	}
	writeData() {
		if (!this.dataSize) return;
		this.#setCursorStartOf('data');
		if (this.tx.data) this.w.writeBytes(this.tx.data);
	}
}

/** The position of each pointers/cursor in the #cursors array. Sorry for the complexity, needs for good performance in here */
const CUR = {
	witnesses: 			{ start: 0, size: 1},
	identities:			{ start: 2, size: 3},
	inputs:				{ start: 4, size: 5},
	outputs:			{ start: 6, size: 7},
	utxoParams:			{ start: 8, size: 9},
	data: 				{ start: 10, size: 11}
};
export class TransactionReader {
	/** The BinaryReader initialized with serializedTx. Set cursor before external use */
	r; #cursors = new Uint16Array(12);
	type;
	version;
	inputsCount;
	outputsCount;
	lastValidHeight;

	/** @param {Uint8Array} serializedTx @param {'tx' | 'solver' | 'validator'} [type] default: 'tx' */
	constructor(serializedTx, type = 'tx') {
		this.r = new BinaryReader(serializedTx);
		this.type = type;
		this.r.cursor = 0; // ensure cursor is at the beginning of the transaction bytes
		this.version 						= converter.bytes2ToNumber(this.r.read(2));
		this.lastValidHeight				= converter.bytes4ToNumber(this.r.read(4));
		this.#cursors[CUR.witnesses.size] 	= converter.bytes2ToNumber(this.r.read(2));
		this.#cursors[CUR.identities.size] 	= converter.bytes2ToNumber(this.r.read(2));
		this.#cursors[CUR.utxoParams.size]	= converter.bytes2ToNumber(this.r.read(2));
		this.inputsCount 					= converter.bytes2ToNumber(this.r.read(2));
		this.outputsCount 					= converter.bytes2ToNumber(this.r.read(2));
		this.#cursors[CUR.data.size]		= converter.bytes2ToNumber(this.r.read(2));

		this.#cursors[CUR.witnesses.start] 	= SIZES.txHeader.bytes; // witnesses section always start at the same position, right after the header
		this.#cursors[CUR.identities.start]	= this.#cursors[CUR.witnesses.start] + this.#cursors[CUR.witnesses.size];
		this.#cursors[CUR.utxoParams.start] = this.#cursors[CUR.identities.start] + this.#cursors[CUR.identities.size]
		this.#cursors[CUR.inputs.start]		= this.#cursors[CUR.utxoParams.start] + this.#cursors[CUR.utxoParams.size];
		this.#cursors[CUR.inputs.size]		= type === 'tx' ? this.inputsCount * SIZES.anchor.bytes
								: type === 'solver' ? SIZES.nonce.bytes : SIZES.validatorInput.bytes;
		this.#cursors[CUR.outputs.start]	= this.#cursors[CUR.inputs.start] + this.#cursors[CUR.inputs.size];
		this.#cursors[CUR.outputs.size]		= this.outputsCount * SIZES.miniUTXO.bytes;
		this.#cursors[CUR.data.start]		= this.#cursors[CUR.outputs.start] + this.#cursors[CUR.outputs.size];
	}

	/** Set the reader cursor to start position of the section, return the length of the readable section.
	 * @param {'witnesses' | 'identities' | 'utxoParams' | 'inputs' | 'outputs' | 'data'} section */
	setCursorStartOf(section) 	{ this.r.cursor = this.#cursors[CUR[section].start]; return this.#cursors[CUR[section].size]; }
	/** Copy buffer of the section. @param {'witnesses' | 'identities' | 'utxoParams' | 'inputs' | 'outputs' | 'data'} section */
	getSerializedSection(section) {
		if (!this.#cursors[CUR[section].size]) return undefined
		return this.r.read(this.#cursors[CUR[section].size], this.#cursors[CUR[section].start]);
	}

	getWitnesses() {
		if (!this.#cursors[CUR.witnesses.size])
			if (this.type === 'solver') return [];
			else throw new Error('Invalid transaction: coinbase transaction should not have witnesses');

		this.r.cursor = this.#cursors[CUR.witnesses.start];
		const { pointers, endOfLastDataChunk } = this.r.readPointers();
		const witnesses = [];
		for (let i = 0; i < pointers.length; i++) {
			if (this.r.cursor !== pointers[i]) throw new Error('Reading: fatal error, cursor at wrong place!');

			const walletId = ADDRESS.bytesToAddress(this.r.read(SIZES.address.bytes));

			const sigSize = (pointers[i + 1] || endOfLastDataChunk) - this.r.cursor;
			const signature = converter.bytesToHex(this.r.read(sigSize));
			witnesses.push([walletId, signature]);
		}

		return witnesses;
	}
	getIdentities() {
		if (!this.#cursors[CUR.identities.size]) return []; else this.setCursorStartOf('identities');
		return this.r.readPointersAndExtractDataChunks();
	}
	getUtxoParams() {
		if (!this.#cursors[CUR.utxoParams.size]) return []; else this.setCursorStartOf('utxoParams');
		return this.r.readPointersAndExtractDataChunks();
	}
	getInputs() {
		const intputsSize = this.setCursorStartOf('inputs'); // set cursor position
		if (this.type === 'solver') return [converter.bytesToHex(this.r.read(4), 4)]; // nonce
		else if (this.type === 'validator') { // <address:posHash>
			const address = ADDRESS.bytesToAddress(this.r.read(SIZES.address.bytes));
			const posHash = converter.bytesToHex(this.r.read(SIZES.hash.bytes));
			return [`${address}:${posHash}`];
		} else if (this.type !== 'tx') throw new Error('Wrong tx type!');
		
		/** @type {string[]} */
		const inputs = [];
		for (let i = 0; i < intputsSize; i += SIZES.anchor.bytes) {
			const blockHeight = converter.bytes4ToNumber(this.r.read(4));
			const txIndex = nonZeroUint16.decode(this.r.read(2));
			const inputIndex = nonZeroUint16.decode(this.r.read(2));
			inputs.push(`${blockHeight}:${txIndex}:${inputIndex}`);
		}
		return inputs;
	}
	getOutputs() {
		const miniUTXOs = [];
		const outputsSize = this.setCursorStartOf('outputs');
		for (let i = 0; i < outputsSize; i += SIZES.miniUTXO.bytes)
			miniUTXOs.push({
				address: ADDRESS.bytesToAddress(this.r.read(SIZES.address.bytes)),
				amount: converter.bytes6ToNumber(this.r.read(6)),
				rule: UTXO_RULESNAME_FROM_CODE[this.r.read(1)[0]]
			})

		return miniUTXOs;
	}
}