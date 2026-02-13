// @ts-check
import { BlockUtils } from './block.mjs';
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { conditionnals } from '../../utils/conditionals.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
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
    /** @param {string} nonceHex @param {string} address @param {number} amount */
    static async createCoinbase(nonceHex, address, amount) {
        if (typeof nonceHex !== 'string') throw new Error('Invalid nonceHex');
        if (typeof address !== 'string') throw new Error('Invalid address');
        if (typeof amount !== 'number') throw new Error('Invalid amount');

        const coinbaseOutput = new TxOutput(amount, 'sig', address);
		return new Transaction([nonceHex], [coinbaseOutput]);
    }
    /** @param {number} posReward @param {BlockCandidate} blockCandidate @param {string} rewardAddress 	- who will receive the reward */
    static async createPosReward(posReward, blockCandidate, rewardAddress) {
        if (typeof rewardAddress !== 'string') throw new Error('Invalid rewardAddress');

        const posHashHex = await BlockUtils.getBlockSignature(blockCandidate, true);
        const posInput = posHashHex;
        const posOutput = new TxOutput(posReward, 'sig', rewardAddress);
		return new Transaction([posInput], [posOutput]);
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
        const { utxos, changeOutput, finalFee } = Transaction_Builder.#estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress, dataLength);
        if (changeOutput) outputs.push(changeOutput);
        if (conditionnals.arrayIncludeDuplicates(outputs)) throw new Error('Duplicate outputs');

		return { tx: Transaction.fromUTXOs(utxos, outputs, data), finalFee, totalConsumed: totalSpent + finalFee };
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
		const utxos = Transaction_Builder.extractNecessaryUtxosForAmount(availableUTXOs, totalStake + fee);
		const inAmount = utxos.reduce((a, b) => a + b.amount, 0);
		const change = inAmount - totalStake - fee;
		if (change) outputs.push(new TxOutput(change, 'sig', senderAddress));

		// SET THE AUTHORIZED VALIDATOR PUBKEY IN TX DATA
        const tx = Transaction.fromUTXOs(utxos, outputs);
		tx.data = serializer.converter.hexToBytes(authorizedPubkey);
		return { tx, finalFee: fee, totalConsumed: totalStake + fee };
    }
	/** @param {UTXO[]} UTXOs @param {TxOutput[]} outputs @param {number} totalSpent @param {number} feePerByte @param {string} senderAddress */
    static #estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress, dataLength = 0) {
        const estWeight 	= Transaction_Builder.simulateTxToEstimateWeight(UTXOs, outputs) + dataLength;
        const { fee } 		= Transaction_Builder.calculateFeeAndChange(UTXOs, totalSpent, estWeight, feePerByte);
        const utxos 		= Transaction_Builder.extractNecessaryUtxosForAmount(UTXOs, totalSpent + fee);
        const { fee: finalFee, change } = Transaction_Builder.calculateFeeAndChange(utxos, totalSpent, estWeight, feePerByte);
        const changeOutput 	= change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? new TxOutput(change, 'sig', senderAddress) : undefined;
        return { utxos, changeOutput, finalFee };
    }
    /** @param {UTXO[]} utxos @param {number} amount */
    static extractNecessaryUtxosForAmount(utxos, amount) {
        const necessaryUtxos = [];
        let remainingAmount = amount;
        for (const utxo of utxos) {
            if (remainingAmount <= 0) { break; }

            necessaryUtxos.push(utxo);
            remainingAmount -= utxo.amount;
        }

        return necessaryUtxos;
    }
    /** @param {UTXO[]} utxos @param {TxOutput[]} outputs @param {number} [nbOfSigners] defulat: 1 */
    static simulateTxToEstimateWeight(utxos, outputs, nbOfSigners = 1) {
        const change = 26_152_659_654_321;
        const changeOutput = new TxOutput(change, 'sig', ADDRESS.SAMPLE);
        const outputsClone = JSON.parse(JSON.stringify(outputs));
        outputsClone.push(changeOutput);

        const inputs = utxos.map(utxo => utxo.anchor);
        const witnesses = [];
        for (let i = 0; i < nbOfSigners; i++) witnesses.push("6a6e432aaba4c7f241f9dcc9ea1c7df94e2533b53974182b86d3acd83029667cc940ce6eea166c97953789d169af562a54d6c96028a5ca7dba95047a15bfd20c:846a6a7c422c4b9a7e8600d3a14750c736b6ee6e7905a245eaa6c2c63ff93a5b");
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
    /** @param {Transaction} transaction */
    static isMinerOrValidatorTx(transaction) {
        if (transaction.inputs.length !== 1) return;
        if (transaction.inputs[0].length === serializer.lengths.nonce.str) return 'miner'; // nonce length is 8
        if (transaction.inputs[0].length === serializer.lengths.hash.str) return 'validator'; // address length 20 + : + posHash length is 64
    }
    /** @param {Transaction} transaction */
    static isIncriptionTx(transaction) {
        if (transaction.outputs.length !== 1) { return false; }
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
    // Multi-functions methods
    /** @param {Account} senderAccount @param {number} amount @param {string} recipientAddress @param {number} [feePerByte] */
    static createAndSignTransaction(senderAccount, amount, recipientAddress, feePerByte) {
        try {
            const transfer = { recipientAddress, amount };
            const { tx, finalFee } = Transaction_Builder.createTransaction(senderAccount, [transfer], feePerByte);
            senderAccount.signTransaction(tx);
            return { signedTx: tx, finalFee, error: false };
        } catch (/**@type {any}*/ error) { return { signedTx: null, error }; }
    }
	/** @param {Transaction} transaction */
	static getTransactionSignableString(transaction) {
		const i = JSON.stringify(transaction.inputs);
		const o = JSON.stringify(transaction.outputs);
		const v = transaction.version.toString();
		return i + o + v;
	}
}