/**
 * @typedef {Object} UTXORule
 * @property {number} code - The code of the rule
 * @property {string} description - The description of the rule
 * @property {number} [withdrawLockBlocks] - Number of blocks to lock for 'sigOrSlash' rule
 * @property {number} [lockUntilBlock] - Block height until which the UTXO is locked for 'lockUntilBlock' rule
 *
 * @typedef {string} TxAnchor 	- The path to the UTXO, ex: blockHeight:txIndex:vout
 * @typedef {string} TxId 		- The path to the transaction, ex: blockHeight:txIndex
 * @typedef {string} VoutId 	- The path to the output, ex: txIndex:vout */

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

export class UtxoState {
	/** @param {number} txIndex @param {number} vout @param {boolean} [spent] default: false */
	constructor(txIndex, vout, spent = false) {
		this.txIndex = txIndex;
		this.vout = vout;
		this.spent = spent;
	}
}

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

export class LedgerUtxo { // lightweight UTXO representation without address, unspent only
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
	/** @param {TxAnchor[]} inputs @param {TxOutput[]} outputs @param {string[]} [witnesses] @param {Uint8Array | undefined} [data] @param {number} [version] Arbitrary data attached to the transaction @param {number | undefined} [feePerByte] @param {number | undefined} [byteWeight] */
	constructor(inputs, outputs, witnesses = [], data, version = TRANSACTION.VERSION, feePerByte, byteWeight) {
		this.inputs = inputs;
		this.outputs = outputs;
		this.witnesses = witnesses;
		this.data = data;
		this.version = version;
		this.feePerByte = feePerByte;
		this.byteWeight = byteWeight;
	}

	/** @param {UTXO[]} utxos @param {TxOutput[]} outputs @param {Uint8Array | undefined} [data] */
	static fromUTXOs(utxos, outputs, data) {
		const inputs = utxos.map(utxo => utxo.anchor);
		return new TRANSACTION.Transaction(inputs, outputs, [], data);
	}
}

export const TRANSACTION = {
	VERSION: 1,
	TxOutput,
	UTXO,
	Transaction
};