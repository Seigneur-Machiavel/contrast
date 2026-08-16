// @ts-check


/**
 * @typedef {Object} UTXORule
 * @property {number} code 			- The code of the rule
 * @property {string} description 	- The description of the rule 
 * 
 * @typedef {string} TxAnchor 		- The path to the UTXO, ex: blockHeight:txIndex:vout */


/** @type {Record<string, UTXORule>} */
export const UTXO_RULES_GLOSSARY = {
    sig: { code: 0, description: 'Simple signature verification' },
    sigOrSlash: { code: 1, description: "Open right to slash the UTXO if validator's fraud proof is provided" },
    lockUntilBlock: { code: 2, description: 'UTXO locked until block height' },
    p2pExchange: { code: 3, description: 'Peer-to-peer exchange' },
    lightHousePause: { code: 4, description: 'LightHouse pause' },
    lightHouseResume: { code: 5, description: 'LightHouse resume' },
	// deadManSwitch?
};

/** @type {Record<number, string>} */
export const UTXO_RULESNAME_FROM_CODE = {
    0: 'sig',
    1: 'sigOrSlash',
    2: 'lockUntilBlock',
    3: 'p2pExchange'
};

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
	static fromUTXO(utxo) { return new LedgerUtxo(utxo.anchor, utxo.amount, UTXO_RULES_GLOSSARY[utxo.rule].code); }
	/** @param {UTXO[]} utxos */
	static fromUTXOs(utxos) { return utxos.map(utxo => LedgerUtxo.fromUTXO(utxo)); }
}