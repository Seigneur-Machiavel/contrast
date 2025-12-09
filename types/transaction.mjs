/**
 * @typedef {string} TxAnchor - The path to the UTXO, ex: blockHeight:txIndex:vout
 * @typedef {string} TxReference - The path to the transaction, ex: blockHeight:txIndex
 */

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

	/** @param {UTXO[]} UTXOs */
	static EXTRACT_BALANCES(UTXOs) {
		let totalBalance = 0;
        let spendableBalance = 0;
        let stakedBalance = 0;
        let lockedBalance = 0;
        let p2pExchangeBalance = 0;

        for (let i = 0; i < UTXOs.length; i++) {
            const rule = UTXOs[i].rule;
            const amount = UTXOs[i].amount;

            totalBalance += amount;
            switch (rule) {
                case 'sigOrSlash':
                    stakedBalance += amount;
                    break;
                case 'lockUntilBlock':
                    lockedBalance += amount;
                    break;
                case 'p2pExchange':
                    p2pExchangeBalance += amount;
                    break;
                default:
                    spendableBalance += amount;
                    break;
            }
        }

        return { totalBalance, stakedBalance, spendableBalance, lockedBalance, p2pExchangeBalance };
	}
	/** @param {UTXO[]} UTXOs */
	static BY_RULES(UTXOs) {
		/** @type {Object<string, UTXO[]>} */
		const utxosByRule = {};
		for (let i = 0; i < UTXOs.length; i++) {
			const rule = UTXOs[i].rule;
			if (!utxosByRule[rule]) { utxosByRule[rule] = []; }
			utxosByRule[rule].push(UTXOs[i]);
		}
		return utxosByRule;
	}
}

export class Transaction {
	/** @param {TxAnchor[]} inputs @param {TxOutput[]} outputs @param {string[]} [witnesses] @param {number | undefined} [feePerByte] @param {number | undefined} [byteWeight] @param {number} [version] @param {Uint8Array | undefined} [data] Arbitrary data attached to the transaction */
	constructor(inputs, outputs, witnesses = [], feePerByte, byteWeight, version = TRANSACTION.VERSION, data) {
		this.inputs = inputs;
		this.outputs = outputs;
		this.witnesses = witnesses;
		this.feePerByte = feePerByte;
		this.byteWeight = byteWeight;
		this.version = version;
		this.data = data;
	}

	/** @param {UTXO[]} utxos @param {TxOutput[]} outputs */
	static fromUTXOs(utxos, outputs) {
		const inputs = utxos.map(utxo => utxo.anchor);
		return new TRANSACTION.Transaction(inputs, outputs);
	}
}

export class TransactionWithDetails extends Transaction {
	/** @param {TxAnchor[]} inputs @param {TxOutput[]} outputs @param {number} balanceChange @param {number} inAmount @param {number} outAmount @param {number} fee @param {string} txReference @param {string[]} [witnesses] @param {number | undefined} [feePerByte] @param {number | undefined} [byteWeight] @param {number} [version] */
	constructor(inputs, outputs, balanceChange, inAmount, outAmount, fee, txReference, witnesses = [], feePerByte, byteWeight, version = TRANSACTION.VERSION) {
		super(inputs, outputs, witnesses, feePerByte, byteWeight, version);
		this.balanceChange = balanceChange;
		this.inAmount = inAmount;
		this.outAmount = outAmount;
		this.fee = fee;
		this.txReference = txReference;
	}
}

export const TRANSACTION = {
	VERSION: 1,
	TxOutput,
	UTXO,
	Transaction,
	TransactionWithDetails
};