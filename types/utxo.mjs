// @ts-check


/**
 * @typedef {Object} UTXORule
 * @property {number} code 			- The code of the rule
 * @property {string} description 	- The description of the rule
 * @property {string} [paramsDesc] 	- The description of associated utxoParams section
 * @property {number} [activationHeight] - The block height where the rule is activated
 * 
 * @typedef {string} TxAnchor 		- The path to the UTXO, ex: blockHeight:txIndex:vout */


/** @type {Record<string, UTXORule>} */
export const UTXO_RULES_GLOSSARY = {
    sig: { code: 0, description: 'Simple signature verification', activationHeight: 0 },
    sLock: { code: 1, description: "Staking -> Lock for a delay specified in blockchain-settings.mjs. Open right to slash the UTXO if validator's fraud proof is provided", activationHeight: 0 },
    nLock: { code: 2, description: 'UTXO locked until block height or UNIX timestamp if value > 1_000_000_000', paramsDesc: 'blockIndex or UNIX timestamp (4b)', activationHeight: 0 },
    hLock: { code: 3, description: 'Hash lock, useful for HTLC protocol', paramsDesc: 'algoCode(2b) + hash(Xb)', activationHeight: 0 },
	deadManSwitch: { code: 4, description: '<Send to self only> Window (nBlock) without tx sig who open access to a successor. accessType: 0 = this Wallet | 1 = this address | 2 = this UTXO.', paramsDesc: 'numberOfBlock(4b) + accessType(1b) + successorWalletId(5b)', activationHeight: 0 }
};

export const UTXO_RULESNAME_FROM_CODE = Object.keys(UTXO_RULES_GLOSSARY);

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