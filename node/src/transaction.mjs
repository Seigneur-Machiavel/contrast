// @ts-check
import { BlockUtils } from './block.mjs';
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { conditionnals } from '../../utils/conditionals.mjs';
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
    static createLighthouse() { // DEPRECATED
        const lighthouseOutput = new TxOutput(0, 'lighthouse', ADDRESS.SAMPLE);
        const inputs = ['00000000'];
        const outputs = [lighthouseOutput];
		return new Transaction(inputs, outputs);
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
    static createTransaction(senderAccount, transfers, feePerByte = 1, data) {
        const senderAddress = senderAccount.address;
		const ruleCodesToExclude = new Set([UTXO_RULES_GLOSSARY['sigOrSlash'].code]);
        const UTXOs = UTXO.fromLedgerUtxos(senderAddress, senderAccount.ledgerUtxos, ruleCodesToExclude);
		if (UTXOs.length === 0) throw new Error('No UTXO to spend');

        this.checkMalformedAnchorsInUtxosArray(UTXOs);
        this.checkDuplicateAnchorsInUtxosArray(UTXOs);

		const dataLength = data ? data.length : 0;
        const { outputs, totalSpent } = Transaction_Builder.buildOutputsFrom(transfers, 'sig');
		
		// SIMPLIFIED FEE ESTIMATION WITHOUT OPTIMIZATION (USE ALL UTXOs, IF EXCEEDS MAX SIZE THEN THROW)
		const result = Transaction_Builder.#addUtxoUntilAmount(UTXOs, totalSpent, outputs.length, feePerByte, dataLength);
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
		let finalFee = 0;
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
			// SERIALIZE FOR REAL TO COMPARE WITH ESTIMATION -> looks great!
			/*const tx = Transaction.fromUTXOs(selectedUtxos, Array(nbOutputs).fill(new TxOutput(1, 'sig', ADDRESS.SAMPLE)));
			tx.data = new Uint8Array(dataWeight);
			tx.witnesses = Array(nbOfSigners).fill("6a6e432aaba4c7f241f9dcc9ea1c7df94e2533b53974182b86d3acd83029667cc940ce6eea166c97953789d169af562a54d6c96028a5ca7dba95047a15bfd20c:846a6a7c");
			const s = serializer.serialize.transaction(tx);
			console.log(`est1: ${s.byteLength} bytes, est2: ${w} bytes`);*/

			finalFee = Math.ceil(weight * feePerByte);
			if (totalIn < amount + finalFee) continue; // keep adding UTXOs until we reach the amount needed
		}

		if (totalIn < amount + finalFee) throw new Error(`Not enough funds: total UTXOs amount ${totalIn} is less than total needed ${amount + finalFee}`);
		const change = totalIn - amount - finalFee;
		const changeOutput = change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? new TxOutput(change, 'sig', utxos[0].address) : undefined;
		return { selectedUtxos, changeOutput, finalFee, weight };
	}
	/** @param {number} utxoCount @param {number} outputCount */
	static #calculateTransactionWeight(utxoCount, outputCount, dataWeight = 0, nbOfSigners = 1) {
		const headerWeight = serializer.lengths.txHeader.bytes;
		const inputsWeight = utxoCount * serializer.lengths.anchor.bytes;
		const outputsWeight = outputCount * serializer.lengths.miniUTXO.bytes;
		const witnessesWeight = nbOfSigners * serializer.lengths.witness.bytes;
		return headerWeight + inputsWeight + outputsWeight + witnessesWeight + dataWeight;
	}
	/** @param {number} estWeight @param {UTXO[]} UTXOs @param {number} totalSpent @param {number} feePerByte @param {string} senderAddress */
    static #estimateFeeToOptimizeUtxos(estWeight, UTXOs, totalSpent, feePerByte, senderAddress) { // DEPRECATED
        const { fee } 		= Transaction_Builder.calculateFeeAndChange(UTXOs, totalSpent, estWeight, feePerByte);
        const utxos 		= Transaction_Builder.#extractNecessaryUtxosForAmount(UTXOs, totalSpent + fee);
        const { fee: finalFee, change } = Transaction_Builder.calculateFeeAndChange(utxos, totalSpent, estWeight, feePerByte);
        const changeOutput 	= change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? new TxOutput(change, 'sig', senderAddress) : undefined;
        return { utxos, changeOutput, finalFee };
    }
    /** @param {UTXO[]} utxos @param {TxOutput[]} outputs @param {number} [nbOfSigners] default: 1 */
    static simulateTxToEstimateWeight(utxos, outputs, nbOfSigners = 1) { // DEPRECATED
        const change = 26_152_659_654_321;
        const changeOutput = new TxOutput(change, 'sig', ADDRESS.SAMPLE);
        const outputsClone = JSON.parse(JSON.stringify(outputs));
        outputsClone.push(changeOutput);

        const inputs = utxos.map(utxo => utxo.anchor);
        const witnesses = []; // add fake witness (signature:pubKeyHash) for each signer to simulate the weight of a real transaction with signatures
        for (let i = 0; i < nbOfSigners; i++) witnesses.push("6a6e432aaba4c7f241f9dcc9ea1c7df94e2533b53974182b86d3acd83029667cc940ce6eea166c97953789d169af562a54d6c96028a5ca7dba95047a15bfd20c:846a6a7c");
		
		const tx = new Transaction(inputs, outputsClone, witnesses);
		return serializer.serialize.transaction(tx).length;
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
    /** @param {UTXO[]} utxos @param {number} totalSpent @param {number} estimatedWeight @param {number} feePerByte */
    static calculateFeeAndChange(utxos, totalSpent, estimatedWeight, feePerByte) {
        if (feePerByte < BLOCKCHAIN_SETTINGS.minTransactionFeePerByte) throw new Error(`Invalid feePerByte: ${feePerByte}`);
        const inAmount = utxos.reduce((a, b) => a + b.amount, 0);
        const remainingAmount = inAmount - totalSpent;
        if (remainingAmount < 0) throw new Error(`Not enough funds: ${inAmount} - ${totalSpent} = ${remainingAmount}`);

        const fee = Math.ceil(feePerByte * estimatedWeight);
        if (fee % 1 !== 0) throw new Error(`Invalid fee: not integer (${fee})`);
        if (fee < 0) throw new Error(`Negative transaction fee (${fee})`);

        const change = remainingAmount - fee;
		if (change < 0) throw new Error(`Not enough funds to cover the fee: ${remainingAmount} - ${fee} = ${change}`);
        if (change === 0) return { fee: remainingAmount, change: 0 };
        else return { fee, change };
    }
    /** @param {Transaction} tx */
    static isSolverOrValidatorTx(tx) {
        if (tx.inputs.length !== 1 || tx.outputs.length !== 1) return;

        if (tx.inputs[0].length === serializer.lengths.nonce.str) 		// SOLVER nonce lenght is 8
			if (tx.witnesses.length === 0) return 'solver'; 			// and no witness

		if (tx.witnesses.length !== 1) return; 							// VALIDATOR should have exactly 1 witness
        if (tx.inputs[0].length !== serializer.lengths.hash.str) return; // VALIDATOR hash length is 64
		const expectedWitnessLen = serializer.lengths.signature.str + 1 + serializer.lengths.pubKey.str;
		if (tx.witnesses[0].length !== expectedWitnessLen) return; // VALIDATOR witness should be signature:pubKey
		return 'validator';
    }
    /** @param {Transaction} transaction */
    static isIncriptionTx(transaction) {
        if (transaction.outputs.length !== 1) return false;
        return typeof transaction.outputs[0] === 'string';
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
    /** @param {Account} senderAccount @param {number} amount @param {string} recipientAddress @param {number} [feePerByte] @param {Uint8Array} [data] */
    static createAndSignTransaction(senderAccount, amount, recipientAddress, feePerByte, data) {
        try {
            const transfer = { recipientAddress, amount };
            const { tx, finalFee } = Transaction_Builder.createTransaction(senderAccount, [transfer], feePerByte, data);
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