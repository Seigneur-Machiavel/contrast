// @ts-check
import { BlockUtils } from './block.mjs';
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { conditionnals } from '../../utils/conditionals.mjs';
import { serializer, SIZES } from '../../utils/serializer.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';
import { Transaction, TxOutput, UTXO, UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';

/**
 * @typedef {import('./wallet.mjs').Account} Account
 * @typedef {import('../../types/block.mjs').BlockCandidate} BlockCandidate */

export class Transaction_Builder {
    /** @param {UTXO[]} utxos */
    static checkMalformedAnchorsInUtxosArray(utxos) {
        for (const utxo of utxos)
            if (IS_VALID.ANCHOR(utxo.anchor)) continue;
			else throw new Error(`UTXO anchor malformed in UTXO: ${utxo.anchor}`);
    }
    /** @param {UTXO[]} utxos */
    static checkDuplicateAnchorsInUtxosArray(utxos) {
        if (utxos.length === 0) throw new Error('No UTXO to check');

        const anchors = utxos.map(utxo => utxo.anchor);
        if (conditionnals.arrayIncludeDuplicates(anchors)) throw new Error('Duplicate UTXO anchors in UTXOs');
    }
    /** @param {string} nonceHex @param {string} address @param {number} amount @param {Uint8Array | undefined} [data] */
    static async createSolverReward(nonceHex, address, amount, data) {
        if (typeof nonceHex !== 'string') throw new Error('Invalid nonceHex');
        if (typeof address !== 'string') throw new Error('Invalid address');
        if (typeof amount !== 'number') throw new Error('Invalid amount');
		if (data && !(data instanceof Uint8Array)) throw new Error('Invalid data');

        const coinbaseOutput = new TxOutput(amount, 'sig', address);
		return new Transaction([nonceHex], [coinbaseOutput], undefined, data);
    }
    /** @param {number} posReward @param {BlockCandidate} blockCandidate @param {string} address - who will receive the reward @param {Uint8Array | undefined} [data] */
    static async createValidatorReward(posReward, blockCandidate, address, data) {
        if (typeof address !== 'string') throw new Error('Invalid address');
        if (data && !(data instanceof Uint8Array)) throw new Error('Invalid data');

        const posHashHex = await BlockUtils.getBlockSignature(blockCandidate, true);
        const posInput = posHashHex;
        const posOutput = new TxOutput(posReward, 'sig', address);
		return new Transaction([posInput], [posOutput], undefined, data);
    }
    /** @param {Account} senderAccount @param {{recipientAddress: string, amount: number}[]} transfers @param {number} feePerByte @param {Uint8Array | undefined} [data] */
    static createTransaction(senderAccount, transfers, feePerByte = 1, data, inMaxAmount = false) {
        const senderAddress = senderAccount.address;
		const ruleCodesToExclude = new Set([UTXO_RULES_GLOSSARY['sigOrSlash'].code]);
        const UTXOs = UTXO.fromLedgerUtxos(senderAddress, senderAccount.ledgerUtxos, ruleCodesToExclude);
		if (UTXOs.length === 0) throw new Error('No UTXO to spend');

        this.checkMalformedAnchorsInUtxosArray(UTXOs);
        this.checkDuplicateAnchorsInUtxosArray(UTXOs);

		const dataLength = data ? data.length : 0;
        const { outputs, totalSpent } = Transaction_Builder.buildOutputsFrom(transfers, 'sig');
		
		// SIMPLIFIED FEE ESTIMATION WITHOUT OPTIMIZATION (USE ALL UTXOs, IF EXCEEDS MAX SIZE THEN THROW)
		const result = inMaxAmount ? Transaction_Builder.#countAllSpent(UTXOs, totalSpent, outputs.length, feePerByte, dataLength)
			: Transaction_Builder.#addUtxoUntilAmount(UTXOs, totalSpent, outputs.length, feePerByte, dataLength);
		
		const { selectedUtxos, changeOutput, finalFee, weight } = result;
		if (weight > BLOCKCHAIN_SETTINGS.maxTransactionSize) throw new Error(`Estimated transaction weight (${weight} bytes) exceeds maximum allowed (${BLOCKCHAIN_SETTINGS.maxTransactionSize} bytes)`);

		if (changeOutput) outputs.push(changeOutput);
        if (conditionnals.arrayIncludeDuplicates(outputs)) throw new Error('Duplicate outputs');

		return { tx: Transaction.fromUTXOs(selectedUtxos, outputs, data), finalFee, totalConsumed: totalSpent + finalFee, weight };
    }
	/** Create a transaction to stake new VSS - fee should be => amount to be staked
     * @param {Account} senderAccount - the account who is staking the VSS
	 * @param {number} qty The quanity of stakes to create
	 * @param {string} [authorizedPubkey] - the pubkey of the validator authorized to sign for this stake (default: the senderAccount pubkey)
     * @param {boolean} useOnlyNecessaryUtxos - if true, the transaction will use only the necessary UTXOs to reach the amount */
    static createStakingVss(senderAccount, qty, authorizedPubkey = senderAccount.pubKey, useOnlyNecessaryUtxos = true) {
		if (typeof qty !== 'number' || qty <= 0) throw new Error('Invalid quantity to stake');
		if (typeof authorizedPubkey !== 'string' || authorizedPubkey.length !== 64)
			throw new Error('Invalid authorized validator pubkey');

		const senderAddress = senderAccount.address;
		const ruleCodesToExclude = new Set([UTXO_RULES_GLOSSARY['sigOrSlash'].code]);
		const availableUTXOs = UTXO.fromLedgerUtxos(senderAddress, senderAccount.ledgerUtxos, ruleCodesToExclude);
        if (availableUTXOs.length === 0) throw new Error('No UTXO to spend');

        this.checkMalformedAnchorsInUtxosArray(availableUTXOs);
        this.checkDuplicateAnchorsInUtxosArray(availableUTXOs);
		const transfers = [];
		for (let i = 0; i < qty; i++) transfers.push({ recipientAddress: senderAddress, amount: BLOCKCHAIN_SETTINGS.stakeAmount });
        const { outputs, totalSpent: totalStake } = Transaction_Builder.buildOutputsFrom(transfers, 'sigOrSlash');
        const availableAmount = availableUTXOs.reduce((a, b) => a + b.amount, 0);
        if (availableAmount < totalStake) throw new Error(`Not enough funds: ${availableAmount} < ${totalStake}`);
		
        // NO NEEDS FOR ESTIMATION HERE, FEE = AMOUNT STAKED
		const fee = totalStake; // STAKING REQUIRES FEE >= AMOUNT STAKED
		const utxos = Transaction_Builder.#extractNecessaryUtxosForAmount(availableUTXOs, totalStake + fee);
		const inAmount = utxos.reduce((a, b) => a + b.amount, 0);
		const change = inAmount - totalStake - fee;
		if (change) outputs.push(new TxOutput(change, 'sig', senderAddress));

		// SET THE AUTHORIZED VALIDATOR PUBKEY IN TX DATA
        const tx = Transaction.fromUTXOs(utxos, outputs);
		tx.data = serializer.converter.hexToBytes(authorizedPubkey);
		return { tx, finalFee: fee, totalConsumed: totalStake + fee };
    }
	/** @param {UTXO[]} utxos @param {number} amount */
    static #extractNecessaryUtxosForAmount(utxos, amount) {
        const necessaryUtxos = [];
        let remainingAmount = amount;
        for (const utxo of utxos) {
            if (remainingAmount <= 0) break; // stop if we've already covered the amount needed
            necessaryUtxos.push(utxo);
            remainingAmount -= utxo.amount;
        }

        return necessaryUtxos;
    }
	static createUnstakingVss() { throw new Error('Not implemented yet'); }
	static createSlashing() { throw new Error('Not implemented yet'); }
	/** @param {UTXO[]} utxos @param {number} amount @param {number} outputCount @param {number} feePerByte */
	static #addUtxoUntilAmount(utxos, amount, outputCount, feePerByte, dataWeight = 0, nbOfSigners = 1) {
		let finalFee = Transaction_Builder.#calculateTransactionWeight(1, outputCount, dataWeight, 1); // start with 1 input and 1 output to get a baseline fee, then we will add UTXOs until we reach the amount needed with the fee
		let totalIn = 0;
		let weight = 0;
		const selectedUtxos = [];
		for (const utxo of utxos) {
			if (totalIn >= amount + finalFee) break; // stop if we've already reached the amount needed with the fee

			selectedUtxos.push(utxo);
			totalIn += utxo.amount;
			
			const needsChangeOutput = totalIn > amount + finalFee;
			const nbOutputs = outputCount + (needsChangeOutput ? 1 : 0);
			weight = this.#calculateTransactionWeight(selectedUtxos.length, nbOutputs, dataWeight, nbOfSigners);
			finalFee = Math.ceil(weight * feePerByte);
			if (totalIn < amount + finalFee) continue; // keep adding UTXOs until we reach the amount needed
		}

		if (totalIn < amount + finalFee) throw new Error(`Not enough funds: total UTXOs amount ${totalIn} is less than total needed ${amount + finalFee}`);
		const change = totalIn - amount - finalFee;
		const changeOutput = change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? new TxOutput(change, 'sig', utxos[0].address) : undefined;
		return { selectedUtxos, changeOutput, finalFee, weight };
	}
	/** @param {UTXO[]} utxos @param {number} amount @param {number} outputCount @param {number} feePerByte */
	static #countAllSpent(utxos, amount, outputCount, feePerByte, dataWeight = 0, nbOfSigners = 1) {
		const weight = Transaction_Builder.#calculateTransactionWeight(utxos.length, outputCount, dataWeight, nbOfSigners);
		return { selectedUtxos: utxos, changeOutput: undefined, finalFee: weight * feePerByte, weight };
	}
	/** @param {number} inputCount @param {number} outputCount */
	static #calculateTransactionWeight(inputCount, outputCount, dataWeight = 0, nbOfSigners = 1) {
		const headerWeight = SIZES.txHeader.bytes;
		const inputsWeight = inputCount * SIZES.anchor.bytes;
		const outputsWeight = outputCount * SIZES.miniUTXO.bytes;
		const witnessesWeight = nbOfSigners * SIZES.witness.bytes;
		return headerWeight + inputsWeight + outputsWeight + witnessesWeight + dataWeight;
	}
	/** @param {Account} account @param {number} feePerByte @param {Uint8Array} [data] */
	static calculateMaxSendableAmount(account, feePerByte = 1, data) {
		if (account.ledgerUtxos.length === 0) throw new Error('No UTXO to spend');
		const nbIn = account.ledgerUtxos.length;
		const txWeight = Transaction_Builder.#calculateTransactionWeight(nbIn, 1, data?.length || 0, 1); // estimate weight with 1 input and 1 output
		const estimatedFee = txWeight * feePerByte;
		const availableUTXOs = UTXO.fromLedgerUtxos(account.address, account.ledgerUtxos);
		const totalAvailable = availableUTXOs.reduce((a, b) => a + b.amount, 0);
		if (totalAvailable <= estimatedFee) throw new Error(`Not enough funds to cover fee: available ${totalAvailable}, estimated fee ${estimatedFee}`);
		return totalAvailable - estimatedFee;
	}
    /** @param {{recipientAddress: string, amount: number}[]} transfers @param {string} rule */
    static buildOutputsFrom(transfers = [{ recipientAddress: 'recipientAddress', amount: 1 }], rule = 'sig') {
        const outputs = [];
        let totalSpent = 0;

        for (let i = 0; i < transfers.length; i++) {
            const { recipientAddress, amount } = transfers[i];
            const output = new TxOutput(amount, rule, recipientAddress);
            outputs.push(output);
            totalSpent += amount;
        }

        return { outputs, totalSpent };
    }
    /** @param {Transaction} tx */
    static isSolverOrValidatorTx(tx) {
        if (tx.inputs.length !== 1 || tx.outputs.length !== 1) return;

        if (tx.inputs[0].length === SIZES.nonce.str) 		// SOLVER nonce lenght is 8
			if (tx.witnesses.length === 0) return 'solver'; 			// and no witness

		if (tx.witnesses.length !== 1) return; 							// VALIDATOR should have exactly 1 witness
        if (tx.inputs[0].length !== SIZES.hash.str) return; // VALIDATOR hash length is 64
		const expectedWitnessLen = SIZES.signature.str + 1 + SIZES.pubKey.str;
		if (tx.witnesses[0].length !== expectedWitnessLen) return; // VALIDATOR witness should be signature:pubKey
		return 'validator';
    }
	/** @param {Transaction} tx */
	static extractInvolvedAnchors(tx, abortOnDoubles = true) {
		/** @type {Object<string, boolean>} */
		const control = {};
		const involvedAnchors = [];
		let repeatedAnchorsCount = 0;
		for (const input of tx.inputs)
			if (control[input]) {
				repeatedAnchorsCount++;
				if (abortOnDoubles) break;
			} else {
				control[input] = true;
				involvedAnchors.push(input);
			}

		return { involvedAnchors, repeatedAnchorsCount };
	}
	/** @param {Uint8Array} d1 @param {Uint8Array} [d2] */
	static mergeIdentityData(d1, d2) {
		if (!d2) return d1;
		if (d1.length + d2.length > BLOCKCHAIN_SETTINGS.maxTransactionDataSize) throw new Error('Merged data exceeds maximum allowed size in transaction (65,535 bytes)');
		
		const mergedData = new Uint8Array(d1.length + d2.length);
		mergedData.set(d1, 0);
		mergedData.set(d2, d1.length);
		return mergedData;
	}

    // Multi-functions methods
    /** Fast method to create & sign a transaction in on call. (Only works with 1 signature, for more complex transactions use createTransaction + account.signTransaction separately)
	 * @param {Account} senderAccount @param {number | 'max'} amount @param {string} recipientAddress @param {number} [feePerByte] @param {Uint8Array} [data] */
    static createAndSignTransaction(senderAccount, amount, recipientAddress, feePerByte = 1, data) {
		if (amount !== 'max' && (typeof amount !== 'number' || amount <= 0)) throw new Error('Invalid amount');
        
		try {
			const inMaxAmount = amount === 'max';
			const amountToSend = !inMaxAmount ? amount : Transaction_Builder.calculateMaxSendableAmount(senderAccount, feePerByte, data);
			const transfer = { recipientAddress, amount: amountToSend };
			const { tx, finalFee } = Transaction_Builder.createTransaction(senderAccount, [transfer], feePerByte, data, inMaxAmount);
			senderAccount.signTransaction(tx);
			return { signedTx: tx, finalFee, error: false };
        } catch (/**@type {any}*/ error) { return { signedTx: null, error }; }
    }
	/** @param {Transaction} transaction */
	static getTransactionSignableString(transaction) {
		const i = JSON.stringify(transaction.inputs);
		const o = JSON.stringify(transaction.outputs);
		const d = JSON.stringify((transaction.data || []).join());
		const v = transaction.version.toString();
		return i + o + d + v;
	}
}