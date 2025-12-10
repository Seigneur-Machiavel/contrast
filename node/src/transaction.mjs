import { BlockUtils } from './block.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { conditionnals } from '../../utils/conditionnals.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { Transaction, TxOutput, UTXO } from '../../types/transaction.mjs';

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
        const lighthouseOutput = new TxOutput(0, 'lighthouse', 'Cv6XXKBTALRPSCzuU6k4');
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
        const inputs = [nonceHex];
        const outputs = [coinbaseOutput];
		return new Transaction(inputs, outputs);
    }
    /** @param {number} posReward @param {BlockCandidate} blockCandidate @param {string} address - who will receive the reward @param {string} posStakedAddress - who will be slashed if fraud proof is provided */
    static async createPosReward(posReward, blockCandidate, address, posStakedAddress) {
        if (typeof address !== 'string') throw new Error('Invalid address');

        const posHashHex = await BlockUtils.getBlockSignature(blockCandidate, true);
        const posInput = `${posStakedAddress}:${posHashHex}`;
        const inputs = [posInput];
        const posOutput = new TxOutput(posReward, 'sig', address);
        const outputs = [posOutput];
		return new Transaction(inputs, outputs);
    }
    /** @param {Account} senderAccount @param {{recipientAddress: string, amount: number}[]} transfers @param {number} feePerByte // RANDOM IS TEMPORARY */
    static createTransfer(senderAccount, transfers, feePerByte = Math.round(Math.random() * 10) + 1) {
        const senderAddress = senderAccount.address;
        const UTXOs = senderAccount.UTXOs.filter(utxo => utxo.rule !== 'sigOrSlash');
        if (UTXOs.length === 0) throw new Error('No UTXO to spend');
        if (transfers.length === 0) throw new Error('No transfer to make');

        this.checkMalformedAnchorsInUtxosArray(UTXOs);
        this.checkDuplicateAnchorsInUtxosArray(UTXOs);

        const { outputs, totalSpent } = Transaction_Builder.buildOutputsFrom(transfers, 'sig', 1);
        const { utxos, changeOutput } = Transaction_Builder.#estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress);
        if (changeOutput) { outputs.push(changeOutput); }
        if (conditionnals.arrayIncludeDuplicates(outputs)) throw new Error('Duplicate outputs');

		return Transaction.fromUTXOs(utxos, outputs);
    }
    /** Create a transaction to stake new VSS - fee should be => amount to be staked
     * @param {Account} senderAccount @param {string} stakingAddress @param {number} amount
     * @param {number} feePerByte // RANDOM IS TEMPORARY
     * @param {boolean} useOnlyNecessaryUtxos - if true, the transaction will use only the necessary UTXOs to reach the amount */
    static createStakingVss(senderAccount, stakingAddress, amount, feePerByte = Math.round(Math.random() * 10) + 1) {
        if (amount < BLOCKCHAIN_SETTINGS.minStakeAmount) throw new Error(`Amount too low: ${amount} < ${BLOCKCHAIN_SETTINGS.minStakeAmount}`);
        const senderAddress = senderAccount.address;
        const UTXOs = senderAccount.UTXOs.filter(utxo => utxo.rule !== 'sigOrSlash');
        if (UTXOs.length === 0) throw new Error('No UTXO to spend');

        this.checkMalformedAnchorsInUtxosArray(UTXOs);
        this.checkDuplicateAnchorsInUtxosArray(UTXOs);

        const availableAmount = UTXOs.reduce((a, b) => a + b.amount, 0);
        if (availableAmount < amount * 2) throw new Error(`Not enough funds: ${availableAmount} < ${amount * 2}`);

        const { outputs, totalSpent } = Transaction_Builder.buildOutputsFrom([{ recipientAddress: stakingAddress, amount }], 'sigOrSlash', 1);
        const { utxos, changeOutput } = Transaction_Builder.#estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress, amount);
        if (changeOutput) { outputs.push(changeOutput); }
        if (conditionnals.arrayIncludeDuplicates(outputs)) throw new Error('Duplicate outputs');

        return Transaction.fromUTXOs(utxos, outputs);
		
    }
    static #estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress, feeSupplement) {
        const estimatedWeight = Transaction_Builder.simulateTxToEstimateWeight(UTXOs, outputs);
        const { fee } = Transaction_Builder.calculateFeeAndChange(UTXOs, totalSpent, estimatedWeight, feePerByte, feeSupplement);
        
        const utxos = Transaction_Builder.extractNecessaryUtxosForAmount(UTXOs, totalSpent + fee);
        const { change } = Transaction_Builder.calculateFeeAndChange(utxos, totalSpent, estimatedWeight, feePerByte, feeSupplement);

        const changeOutput = change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? new TxOutput(change, 'sig', senderAddress) : undefined;
        return { utxos, changeOutput };
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
    /** @param {UTXO[]} utxos @param {TxOutput[]} outputs */
    static simulateTxToEstimateWeight(utxos, outputs, nbOfSigners = 1) {
        const change = 26_152_659_654_321;
        const changeOutput = new TxOutput(change, 'sig', 'Cv6XXKBTALRPSCzuU6k4');
        const outputsClone = JSON.parse(JSON.stringify(outputs));
        outputsClone.push(changeOutput);

        const inputs = utxos.map(utxo => utxo.anchor);
        const witnesses = [];
        for (let i = 0; i < nbOfSigners; i++) witnesses.push("6a6e432aaba4c7f241f9dcc9ea1c7df94e2533b53974182b86d3acd83029667cc940ce6eea166c97953789d169af562a54d6c96028a5ca7dba95047a15bfd20c:846a6a7c422c4b9a7e8600d3a14750c736b6ee6e7905a245eaa6c2c63ff93a5b");
		const tx = new Transaction(inputs, outputsClone, witnesses);
		return serializer.serialize.transaction(tx).length;
    }
    /**
     * @param {{recipientAddress: string, amount: number}[]} transfers
     * @param {string} rule
     * @param {number} version
     */
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
    /**
     * @param {UTXO[]} utxos
     * @param {number} totalSpent
     * @param {number} estimatedWeight
     * @param {number} feePerByte
     * @param {number} feeSupplement
     */
    static calculateFeeAndChange(utxos, totalSpent, estimatedWeight, feePerByte, feeSupplement = 0) {
        if (feePerByte < BLOCKCHAIN_SETTINGS.minTransactionFeePerByte) { throw new Error(`Invalid feePerByte: ${feePerByte}`); }
        const totalInputAmount = utxos.reduce((a, b) => a + b.amount, 0);

        const remainingAmount = totalInputAmount - totalSpent;
        if (remainingAmount <= 0) { throw new Error(`Not enough funds: ${totalInputAmount} - ${totalSpent} = ${remainingAmount}`); }

        const fee = (feePerByte * estimatedWeight) + feeSupplement;
        if (fee % 1 !== 0) { throw new Error('Invalid fee: not integer'); }
        if (fee <= 0) { throw new Error(`Invalid fee: ${fee} <= 0`); }

        const change = remainingAmount - fee;

        // Tx will consume all funds, then fee is the remaining amount, and change is 0
        if (change <= 0) { return { fee: remainingAmount, change: 0 }; }
        //if (change <= 0) { throw new Error('(change <= 0) not enough funds'); }

        return { fee, change };
    }
    /** @param {Transaction} transaction */
    static isMinerOrValidatorTx(transaction) {
        if (transaction.inputs.length !== 1) return false;
        if (transaction.inputs[0].length === 8) return 'miner'; // nonce length is 8
        if (transaction.inputs[0].length === 20 + 1 + 64) return 'validator'; // address length 20 + : + posHash length is 64
        return false;
    }
    /** @param {Transaction} transaction */
    static isIncriptionTx(transaction) {
        if (transaction.outputs.length !== 1) { return false; }
        return typeof transaction.outputs[0] === 'string';
    }
    /** @param {Transaction} transaction */
    static clone(transaction) {
        const inputs = transaction.inputs.slice();
        const outputs = JSON.parse(JSON.stringify(transaction.outputs));
        const witnesses = transaction.witnesses.slice();
		return new Transaction(inputs, outputs, witnesses, transaction.feePerByte, transaction.byteWeight, transaction.version);
    }
    // Multi-functions methods
    /** @param {Account} senderAccount @param {number} amount @param {string} recipientAddress @param {number} [feePerByte] */
    static createAndSignTransfer(senderAccount, amount, recipientAddress, feePerByte) {
        try {
            const transfer = { recipientAddress, amount };
            const transaction = Transaction_Builder.createTransfer(senderAccount, [transfer], feePerByte);
            senderAccount.signTransaction(transaction);
            return { signedTx: transaction, error: false };
        } catch (error) { return { signedTx: false, error }; }
    }
	/** @param {Transaction} transaction */
	static getTransactionSignableString(transaction) {
		const i = JSON.stringify(transaction.inputs);
		const o = JSON.stringify(transaction.outputs);
		const v = transaction.version.toString();
		return i + o + v;
	}
}