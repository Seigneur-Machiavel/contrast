import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { conditionnals } from '../../utils/conditionnals.mjs';
import { typeValidation } from '../../utils/type-validation.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { BlockUtils } from './block-classes.mjs';

/**
 * @typedef {import('./wallet.mjs').Account} Account
 * @typedef {import('./block-classes.mjs').BlockData} BlockData
 */

export class TxIO_Builder {
    /**
     * @param {number} amount
     * @param {string} address
     * @param {string} rule
     */
    static newOutput(amount, rule, address) {
        const txOutput = TxOutput(amount, rule, address);
        return txOutput;
    }
    /** @param {string} anchor */
    static newInput(anchor) {
        const txInput = TxInput(anchor);
        return txInput;
    }
    /**
     * @param {string} anchor
     * @param {number} amount
     * @param {string} rule
     * @param {string} address
     * @param {boolean} spent - default: false
     */
    static newUTXO(anchor, amount, rule, address, spent = false) {
        const newUtxo = UTXO(anchor, amount, rule, address, spent);
        return newUtxo;
    }
    /** @param {TxOutput | TxInput | UTXO | TxOutput[] | TxInput[] | UTXO[]} TxIO */
    static cloneTxIO(TxIO) {
        const TxIOJSON = JSON.stringify(TxIO);
        /** @type {TxOutput | TxInput | UTXO | TxOutput[] | TxInput[] | UTXO[]} */
        const clone = JSON.parse(TxIOJSON);
        return clone;
    }
}

/**
 * @typedef {Object} TxOutput
 * @property {string} address - output only
 * @property {number} amount - the amount of microConts
 * @property {string} rule - the unlocking rule
 */
/** Transaction Input/Output data structure
 * @param {string} address - output only
 * @param {number} amount - the amount of microConts
 * @param {string} rule - the unlocking rule
 * @returns {TxOutput}
 **/
export const TxOutput = (amount, rule, address) => {
    return {
        address,
        amount,
        rule
    };
}
/** @typedef {string} TxInput - the path to the UTXO blockHeight:txID:vout */
/** @param {string} anchor - the path to the UTXO blockHeight:txID:vout */
export const TxInput = (anchor) => { return anchor; }

/**
 * @typedef {Object} UTXO
 * @property {string} anchor - the path to the UTXO blockHeight:txID:vout
 * @property {number} amount - the amount of microConts
 * @property {string} rule - the unlocking rule
 * @property {string} address - the address of the recipient
 * @property {boolean} spent - if the UTXO has been spent
 * @returns {UTXO}
 */
/** Unspent Transaction Output data structure
 * @param {string} anchor - the path to the UTXO blockHeight:txID:vout
 * @param {number} amount - the amount of microConts
 * @param {string} rule - the unlocking rule
 * @param {string} address - the address of the recipient
 * @param {boolean} spent - if the UTXO has been spent (default: false)
 * @returns {UTXO}
 */
export const UTXO = (anchor, amount, rule, address, spent = false) => {
    return { anchor, amount, rule, address, spent };
}
export const utxoExtraction = {
    /** @param {UTXO[]} UTXOs */
    balances: (UTXOs) => {
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
    },
    /** @param {UTXO[]} UTXOs */
    byRules: (UTXOs) => {
        /** @type {Object<string, UTXO[]>} */
        const utxosByRule = {};
        for (let i = 0; i < UTXOs.length; i++) {
            const rule = UTXOs[i].rule;
            if (!utxosByRule[rule]) { utxosByRule[rule] = []; }
            utxosByRule[rule].push(UTXOs[i]);
        }
        return utxosByRule;
    },
};

/**
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {string[]} witnesses
 * @property {number} version
 * @property {TxInput[]} inputs
 * @property {TxOutput[]} outputs
 * @property {number | undefined} feePerByte - only in mempool
 * @property {number | undefined} byteWeight - only in mempool
 */
/** Transaction data structure
 * @param {TxInput[]} inputs
 * @param {TxOutput[]} outputs
 * @param {string} id
 * @param {string[]} witnesses
 * @param {number} version
 * @returns {Transaction}
 */
export const Transaction = (inputs, outputs, id = '', witnesses = [], version = 1) => {
    return {
        id,
        witnesses,
        version,
        inputs,
        outputs
    };
}

/**
 * @typedef {Object} TransactionWithDetails
 * @property {string} id
 * @property {string[]} witnesses
 * @property {number} version
 * @property {TxInput[]} inputs
 * @property {TxOutput[]} outputs
 * @property {number | undefined} feePerByte - only in mempool
 * @property {number | undefined} byteWeight - only in mempool
 * @property {number} balanceChange
 * @property {number} inAmount
 * @property {number} outAmount
 * @property {number} fee
 * @property {string} txReference
 */
/** Transaction with details data structure
 * @param {TxInput[]} inputs
 * @param {TxOutput[]} outputs
 * @param {string} id
 * @param {string[]} witnesses
 * @param {number} version
 * @param {number} balanceChange
 * @param {number} inAmount
 * @param {number} outAmount
 * @param {number} fee
 * @param {string} txReference
 * @returns {TransactionWithDetails}
 */
export const TransactionWithDetails = (txWithDetails) => {
    return {
        id: txWithDetails.id,
        witnesses: txWithDetails.witnesses,
        version: txWithDetails.version,
        inputs: txWithDetails.inputs,
        outputs: txWithDetails.outputs,
        feePerByte: txWithDetails.feePerByte,
        byteWeight: txWithDetails.byteWeight,
        balanceChange: txWithDetails.balanceChange,
        inAmount: txWithDetails.inAmount,
        outAmount: txWithDetails.outAmount,
        fee: txWithDetails.fee,
        txReference: txWithDetails.txReference
    };
}

export class Transaction_Builder {
    /** @param {UTXO[]} utxos */
    static checkMalformedAnchorsInUtxosArray(utxos) {
        for (const utxo of utxos) {
            if (!typeValidation.isConformAnchor(utxo.anchor)) { throw new Error(`UTXO anchor malformed in UTXO: ${utxo.anchor}`); }
        }
    }
    /** @param {UTXO[]} utxos */
    static checkDuplicateAnchorsInUtxosArray(utxos) {
        if (utxos.length === 0) { throw new Error('No UTXO to check'); }

        const anchors = utxos.map(utxo => utxo.anchor);
        if (conditionnals.arrayIncludeDuplicates(anchors)) { throw new Error('Duplicate UTXO anchors in UTXOs'); }
    }
    static createLighthouse(nodeVersion = 1) {
        const lighthouseOutput = TxIO_Builder.newOutput(0, 'lighthouse', 'Cv6XXKBTALRPSCzuU6k4');
        const inputs = ['00000000'];
        const outputs = [lighthouseOutput];

        const transaction = Transaction(inputs, outputs);
        transaction.id = Transaction_Builder.hashId(transaction);

        return transaction;
    }
    /** @param {string} nonceHex @param {string} address @param {number} amount */
    static async createCoinbase(nonceHex, address, amount) {
        if (typeof nonceHex !== 'string') { throw new Error('Invalid nonceHex'); }
        if (typeof address !== 'string') { throw new Error('Invalid address'); }
        if (typeof amount !== 'number') { throw new Error('Invalid amount'); }

        const coinbaseOutput = TxIO_Builder.newOutput(amount, 'sig', address);
        const inputs = [nonceHex];
        const outputs = [coinbaseOutput];

        const transaction = Transaction(inputs, outputs);
        transaction.id = Transaction_Builder.hashId(transaction);

        return transaction;
    }
    /**
     * @param {number} posReward
     * @param {BlockData} blockCandidate
     * @param {string} address - who will receive the reward
     * @param {string} posStakedAddress - who will be slashed if fraud proof is provided
     */
    static async createPosReward(posReward, blockCandidate, address, posStakedAddress) {
        if (typeof address !== 'string') { throw new Error('Invalid address'); }

        const posHashHex = await BlockUtils.getBlockSignature(blockCandidate, true);
        const posInput = `${posStakedAddress}:${posHashHex}`;
        const inputs = [posInput];
        const posOutput = TxIO_Builder.newOutput(posReward, 'sig', address);
        const outputs = [posOutput];

        const transaction = Transaction(inputs, outputs);
        transaction.id = Transaction_Builder.hashId(transaction);

        return transaction;
    }
    /**
     * @param {Account} senderAccount
     * @param {{recipientAddress: string, amount: number}[]} transfers
     * @param {number} feePerByte // RANDOM IS TEMPORARY
     */
    static async createTransfer(senderAccount, transfers, feePerByte = Math.round(Math.random() * 10) + 1) {
        const senderAddress = senderAccount.address;
        const UTXOs = senderAccount.UTXOs.filter(utxo => utxo.rule !== 'sigOrSlash');
        if (UTXOs.length === 0) throw new Error('No UTXO to spend');
        if (transfers.length === 0) throw new Error('No transfer to make');

        this.checkMalformedAnchorsInUtxosArray(UTXOs);
        this.checkDuplicateAnchorsInUtxosArray(UTXOs);

        const { outputs, totalSpent } = Transaction_Builder.buildOutputsFrom(transfers, 'sig', 1);
        const { utxos, changeOutput } = Transaction_Builder.#estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress);
        if (changeOutput) { outputs.push(changeOutput); }
        if (conditionnals.arrayIncludeDuplicates(outputs)) { throw new Error('Duplicate outputs'); }

        return await this.#newTransaction(utxos, outputs);
    }
    /** Create a transaction to stake new VSS - fee should be => amount to be staked
     * @param {Account} senderAccount
     * @param {string} stakingAddress
     * @param {number} amount
     * @param {number} feePerByte // RANDOM IS TEMPORARY
     * @param {boolean} useOnlyNecessaryUtxos - if true, the transaction will use only the necessary UTXOs to reach the amount
     */
    static async createStakingVss(senderAccount, stakingAddress, amount, feePerByte = Math.round(Math.random() * 10) + 1) {
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

        return await this.#newTransaction(utxos, outputs);
    }
    static #estimateFeeToOptimizeUtxos(UTXOs, outputs, totalSpent, feePerByte, senderAddress, feeSupplement = undefined) {
        const estimatedWeight = Transaction_Builder.simulateTxToEstimateWeight(UTXOs, outputs);
        const { fee } = Transaction_Builder.calculateFeeAndChange(UTXOs, totalSpent, estimatedWeight, feePerByte, feeSupplement);
        
        const utxos = Transaction_Builder.extractNecessaryUtxosForAmount(UTXOs, totalSpent + fee);
        const { change } = Transaction_Builder.calculateFeeAndChange(utxos, totalSpent, estimatedWeight, feePerByte, feeSupplement);

        const changeOutput = change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? TxIO_Builder.newOutput(change, 'sig', senderAddress) : undefined;
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
    static async #newTransaction(utxos, outputs) {
        const inputs = utxos.map(utxo => utxo.anchor);

        const transaction = Transaction(inputs, outputs);
        transaction.id = Transaction_Builder.hashId(transaction);

        return transaction;
    }
    /** @param {UTXO[]} utxos @param {TxOutput[]} outputs */
    static simulateTxToEstimateWeight(utxos, outputs, nbOfSigners = 1) {
        const change = 26_152_659_654_321;
        const changeOutput = TxIO_Builder.newOutput(change, 'sig', 'Cv6XXKBTALRPSCzuU6k4');
        const outputsClone = TxIO_Builder.cloneTxIO(outputs);
        outputsClone.push(changeOutput);

        const inputs = utxos.map(utxo => utxo.anchor);
        const witnesses = [];
        for (let i = 0; i < nbOfSigners; i++) { witnesses.push("6a6e432aaba4c7f241f9dcc9ea1c7df94e2533b53974182b86d3acd83029667cc940ce6eea166c97953789d169af562a54d6c96028a5ca7dba95047a15bfd20c:846a6a7c422c4b9a7e8600d3a14750c736b6ee6e7905a245eaa6c2c63ff93a5b"); }
        const transaction = Transaction(inputs, outputsClone, '0360bb18', witnesses);

        return Transaction_Builder.getTxWeight(transaction, false);
    }
    /** @param {Transaction} transaction */
    static getTxWeight(transaction, specialTx) {
        if (specialTx) {
            const serialized = serializer.serialize.specialTransaction(transaction);
            return serialized.byteLength;
        }

        const serialized = serializer.serialize.transaction(transaction);
        return serialized.byteLength;
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
            const output = TxIO_Builder.newOutput(amount, rule, recipientAddress);
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
    static hashId(transaction, hashHexLength = 8) {
        const inputsStr = JSON.stringify(transaction.inputs);
        const outputsStr = JSON.stringify(transaction.outputs);
        const versionStr = JSON.stringify(transaction.version);
        const idStr = `${inputsStr}${outputsStr}${versionStr}`;
        //console.log(`idStr: ${idStr}`);

        const hashHex = HashFunctions.xxHash32(idStr);
        return hashHex.slice(0, hashHexLength);
    }
    /** @param {Transaction} transaction */
    static isMinerOrValidatorTx(transaction) {
        if (transaction.inputs.length !== 1) { return false; }
        if (transaction.inputs[0].length === 8) { return 'miner'; } // nonce length is 8
        if (transaction.inputs[0].length === 20 + 1 + 64) { return 'validator'; } // address length 20 + : + posHash length is 64

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
        const outputs = TxIO_Builder.cloneTxIO(transaction.outputs);
        const witnesses = transaction.witnesses.slice();

        return Transaction(inputs, outputs, transaction.id, witnesses, transaction.version);
    }
    // Multi-functions methods
    /** @param {Account} senderAccount @param {number} amount @param {string} recipientAddress @param {number} [feePerByte] */
    static async createAndSignTransfer(senderAccount, amount, recipientAddress, feePerByte = undefined) {
        try {
            const transfer = { recipientAddress, amount };
            const transaction = await Transaction_Builder.createTransfer(senderAccount, [transfer], feePerByte);
            const signedTx = await senderAccount.signTransaction(transaction);

            return { signedTx, error: false };
        } catch (error) {
            return { signedTx: false, error };
        }
    }
}