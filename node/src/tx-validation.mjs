// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible

import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { UTXO_RULES_GLOSSARY } from '../../utils/utxo-rules.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';

/**
 * @typedef {import("./mempool.mjs").MemPool} MemPool
 * @typedef {import("./utxo-cache.mjs").UtxoCache} UtxoCache
 * @typedef {import("../workers/workers-classes.mjs").ValidationWorker} ValidationWorker
 * 
 * @typedef {import("../../types/transaction.mjs").TxOutput} TxOutput
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 */

const validationMiniLogger = new MiniLogger('validation');
export class TxValidation {
    /** ==> First validation, low computation cost. - control format of : amount, address, rule, version, TxID, UTXOs spendable
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} transaction
     * @param {boolean} specialTx - 'miner' || 'validator' or false */
    static isConformTransaction(involvedUTXOs, transaction, specialTx) {
        if (!transaction) throw new Error(`missing transaction: ${transaction}`);
        if (typeof transaction.version !== 'number') throw new Error('Invalid version !== number');
        if (transaction.version <= 0) throw new Error('Invalid version value: <= 0');
        if (!Array.isArray(transaction.inputs)) throw new Error('Invalid transaction inputs');
        if (!Array.isArray(transaction.outputs)) throw new Error('Invalid transaction outputs');
        if (!Array.isArray(transaction.witnesses)) throw new Error('Invalid transaction witnesses');
        if (specialTx && transaction.inputs.length !== 1) throw new Error(`Invalid coinbase transaction: ${transaction.inputs.length} inputs`);
        if (specialTx && transaction.outputs.length !== 1) throw new Error(`Invalid coinbase transaction: ${transaction.outputs.length} outputs`);
        if (transaction.inputs.length === 0) throw new Error('Invalid transaction: no inputs');
        if (transaction.outputs.length === 0) throw new Error('Invalid transaction: no outputs');

        try { for (const witness of transaction.witnesses) this.#decomposeWitnessOrThrow(witness);
        } catch (/**@type {any}*/ error) { throw new Error('Invalid signature size'); }
        
        for (let i = 0; i < transaction.outputs.length; i++) {
            const output = transaction.outputs[i];
            this.isConformOutput(output);

            if (output.rule !== "sigOrSlash") continue;

			if (i !== 0) throw new Error('sig_Or_Slash must be the first output');
			if (output.amount < BLOCKCHAIN_SETTINGS.minStakeAmount) throw new Error(`sig_Or_Slash amount < ${BLOCKCHAIN_SETTINGS.minStakeAmount}`);

			const remainingAmount = this.calculateRemainingAmount(involvedUTXOs, transaction);
			if (remainingAmount < output.amount) throw new Error('Sig_Or_Slash requires fee > amount');
        }

        for (const input of transaction.inputs) {
            if (specialTx && typeof input !== 'string') throw new Error('Invalid coinbase input');
            if (specialTx) continue;

            const anchor = input;
            if (!IS_VALID.ANCHOR(anchor)) throw new Error('Invalid anchor');

            const utxo = involvedUTXOs[anchor];
            if (!utxo) throw new Error(`Invalid transaction: UTXO not found in involvedUTXOs: ${anchor}`);
            if (utxo.spent) throw new Error(`Invalid transaction: UTXO already spent: ${anchor}`);
            if (utxo.rule === 'sigOrSlash') throw new Error(`Invalid transaction: sigOrSlash UTXO cannot be spend: ${anchor}`);
        }
    }
    /** @param {TxOutput} txOutput */
    static isConformOutput(txOutput) {
        if (typeof txOutput.amount !== 'number') throw new Error('Invalid amount !== number');
        if (txOutput.amount <= 0) throw new Error('Invalid amount value: <= 0');
        if (txOutput.amount % 1 !== 0) throw new Error('Invalid amount value: not integer');
        if (typeof txOutput.rule !== 'string') throw new Error('Invalid rule !== string');
        if (UTXO_RULES_GLOSSARY[txOutput.rule] === undefined) throw new Error(`Invalid rule name: ${txOutput.rule}`);
        addressUtils.conformityCheck(txOutput.address);
    }

    /** ==> Second validation, low computation cost.
     * 
     * --- ONLY PASS CONFORM TRANSACTION ---
     * 
     * --- NO COINBASE OR FEE TRANSACTION ---
     * - control : input > output
     * - control the fee > 0 or = 0 for miner's txs
     * @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} transaction */
    static calculateRemainingAmount(involvedUTXOs, transaction) {
        // AT THIS STAGE WE HAVE ENSURED THAT THE TRANSACTION IS CONFORM

        let fee = 0;
        for (const output of transaction.outputs)
            if (output.amount < BLOCKCHAIN_SETTINGS.unspendableUtxoAmount) continue;
            else fee -= output.amount || 0;

        for (const anchor of transaction.inputs)
            if (!involvedUTXOs[anchor]) throw new Error(`UTXO: ${anchor} not found in involvedUTXOs, already spent?`);
            else fee += involvedUTXOs[anchor].amount;

        if (fee <= 0) throw new Error('Negative or zero fee transaction');
        if (fee % 1 !== 0) throw new Error('Invalid fee: not integer');

        return fee;
    }

    /** ==> Fourth validation, low computation cost. - control the right to create outputs using the rule
     * @param {Transaction} transaction */
    static controlTransactionOutputsRulesConditions(transaction) { //TODO: NOT SURE IF WE CONSERVE THIS
        for (let i = 0; i < transaction.outputs.length; i++) {
            const inRule = transaction.inputs[i] ? transaction.inputs[i].rule : undefined;
            const inAmount = transaction.inputs[i] ? transaction.inputs[i].amount : undefined;
            const inAddress = transaction.inputs[i] ? transaction.inputs[i].address : undefined;
            const outRule = transaction.outputs[i] ? transaction.outputs[i].rule : undefined;
            const outAmount = transaction.outputs[i] ? transaction.outputs[i].amount : undefined;
            const outAddress = transaction.outputs[i] ? transaction.outputs[i].address : undefined;
        }
    } // NOT SURE IF WE CONSERVE THIS

    /** ==> Fifth validation, medium computation cost. - control the signature of the inputs
     * @param {MemPool} memPool @param {Transaction} transaction */
    static controlAllWitnessesSignatures(memPool, transaction) {
        if (!Array.isArray(transaction.witnesses)) throw new Error(`Invalid witnesses: ${transaction.witnesses} !== array`);
        
        /** @type {Object<string, string>} */
        const impliedKnownPubkeysAddresses = {};
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const { signature, pubKeyHex } = this.#decomposeWitnessOrThrow(transaction.witnesses[i]);
            const toSign = Transaction_Builder.getTransactionSignableString(transaction);
			AsymetricFunctions.verifySignature(signature, toSign, pubKeyHex); // will throw an error if the signature is invalid
            
            const pubKeyAddress = memPool.knownPubKeysAddresses[pubKeyHex];
            if (pubKeyAddress) impliedKnownPubkeysAddresses[pubKeyHex] = pubKeyAddress;
        }

        return impliedKnownPubkeysAddresses;
    }
    /** @param {string} witness */
    static #decomposeWitnessOrThrow(witness) {
        if (typeof witness !== 'string') throw new Error(`Invalid witness: ${witness} !== string`);

        const witnessParts = witness.split(':');
        if (witnessParts.length !== 2) throw new Error('Invalid witness');

        const signature = witnessParts[0];
        const pubKeyHex = witnessParts[1];
        if (signature.length !== 128) throw new Error('Invalid signature size');
        if (pubKeyHex.length !== 64) throw new Error('Invalid pubKey size');
        if (!IS_VALID.HEX(signature)) throw new Error(`Invalid signature: ${signature} !== hex`);
        if (!IS_VALID.HEX(pubKeyHex)) throw new Error(`Invalid pubKey: ${pubKeyHex} !== hex`);

        return { signature, pubKeyHex };
    }

    /** ==> Sixth validation, high computation cost.
     * 
     * - control the inputAddresses/witnessesPubKeys correspondence
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} transaction
     * @param {Object<string, string>} impliedKnownPubkeysAddresses
     * @param {'miner' | 'validator' | false} [specialTx] */
    static async addressOwnershipConfirmation(involvedUTXOs, transaction, impliedKnownPubkeysAddresses = {}, specialTx = false) {
        const transactionWitnessesPubKey = [];
        const transactionWitnessesAddresses = [];
        const discoveredPubKeysAddresses = {};

        // derive witnesses addresses
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const witnessParts = transaction.witnesses[i].split(':');
            const pubKeyHex = witnessParts[1];
            
            if (transactionWitnessesPubKey.includes(pubKeyHex)) throw new Error('Duplicate witness');
            transactionWitnessesPubKey.push(pubKeyHex);

            if (impliedKnownPubkeysAddresses[pubKeyHex]) { // If the address derivation is known, use it and skip the derivation
                transactionWitnessesAddresses.push(impliedKnownPubkeysAddresses[pubKeyHex]);
                continue;
            }
            
            const derivedAddressBase58 = await addressUtils.deriveAddress(HashFunctions.Argon2, pubKeyHex);
            if (!derivedAddressBase58) throw new Error('Invalid derived address');

            await addressUtils.securityCheck(derivedAddressBase58, pubKeyHex);
            
            transactionWitnessesAddresses.push(derivedAddressBase58);
            discoveredPubKeysAddresses[pubKeyHex] = derivedAddressBase58; // store the derived address for future use
        }

        if (specialTx === 'miner') return discoveredPubKeysAddresses;

        // control the input's(UTXOs) addresses presence in the witnesses
        for (let i = 0; i < transaction.inputs.length; i++) {
            let addressToVerify;
            if (specialTx === 'validator') addressToVerify = transaction.inputs[i].split(':')[0];
            else {
                const anchor = transaction.inputs[i];
                const utxo = involvedUTXOs[anchor];
                if (!utxo) throw new Error(`UTXO not found in involvedUTXOs: ${anchor}`);
                addressToVerify = utxo.address;
            }
            
            if (!addressToVerify) throw new Error('addressToVerify not found');
            if (!transactionWitnessesAddresses.includes(addressToVerify)) {
                validationMiniLogger.log(`UTXO address: ${addressUtils.formatAddress(addressToVerify)}`, (m, c) => console.info(m, c));
                throw new Error(`Witness missing for address: ${addressToVerify}, witnesses: ${transactionWitnessesAddresses.join(', ')}`);
            }
        }

		return discoveredPubKeysAddresses;
    }
    /** This function is used to optimize the verification while using multi threading */
    static async addressOwnershipConfirmationOnlyIfKownPubKey(involvedUTXOs, transaction, impliedKnownPubkeysAddresses = {}, specialTx) {
        const transactionWitnessesPubKey = [];
        const transactionWitnessesAddresses = [];

        // derive witnesses addresses
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const witnessParts = transaction.witnesses[i].split(':');
            const pubKeyHex = witnessParts[1];
            
            if (transactionWitnessesPubKey.includes(pubKeyHex)) throw new Error('Duplicate witness');
            transactionWitnessesPubKey.push(pubKeyHex);

			// proceed fast confirmation only if the pubKey is known
            if (!impliedKnownPubkeysAddresses[pubKeyHex]) return false;
            transactionWitnessesAddresses.push(impliedKnownPubkeysAddresses[pubKeyHex]);
        }

        if (specialTx === 'miner') return true;

        for (let i = 0; i < transaction.inputs.length; i++) {
            let addressToVerify;
            if (specialTx === 'validator') addressToVerify = transaction.inputs[i].split(':')[0];
            else {
                const anchor = transaction.inputs[i];
                const utxo = involvedUTXOs[anchor];
                if (!utxo) throw new Error(`UTXO not found in involvedUTXOs: ${anchor}`);
                addressToVerify = utxo.address;
            }
            
            if (!addressToVerify) throw new Error('addressToVerify not found');
            if (!transactionWitnessesAddresses.includes(addressToVerify)) {
                validationMiniLogger.log(`UTXO address: ${addressUtils.formatAddress(addressToVerify)}`, (m, c) => console.info(m, c));
                throw new Error(`Witness missing for address: ${addressToVerify}, witnesses: ${transactionWitnessesAddresses.join(', ')}`);
            }
        }

        return true
    }
    /** @param {MemPool} memPool @param {Transaction} transaction */
    static extractImpliedKnownPubkeysAddresses(memPool, transaction) {
        const impliedKnownPubkeysAddresses = {};
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const { pubKeyHex } = this.#decomposeWitnessOrThrow(transaction.witnesses[i]);
            const pubKeyAddress = memPool.knownPubKeysAddresses[pubKeyHex];
            if (pubKeyAddress) impliedKnownPubkeysAddresses[pubKeyHex] = pubKeyAddress;
        }
        return impliedKnownPubkeysAddresses;
    }
    /** ==> Sequencially call the full set of validations
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {MemPool} memPool
     * @param {Transaction} transaction
     * @param {'miner' | 'validator' | false} specialTx */
    static async fullTransactionValidation(involvedUTXOs, memPool, transaction, specialTx) {
        const result = {
			/** @type {Object<string, string>} */
			discoveredPubKeysAddresses: {},
			fee: 0, success: false
		};
        this.isConformTransaction(involvedUTXOs, transaction, specialTx); // also check spendable UTXOs
        
        const impliedKnownPubkeysAddresses = this.controlAllWitnessesSignatures(memPool, transaction);
        if (specialTx === 'miner') { result.success = true; return result; }
        if (!specialTx) { result.fee = this.calculateRemainingAmount(involvedUTXOs, transaction); }
        const discoveredPubKeysAddresses = await this.addressOwnershipConfirmation(involvedUTXOs, transaction, impliedKnownPubkeysAddresses, specialTx);
        result.discoveredPubKeysAddresses = discoveredPubKeysAddresses;
        result.success = true;
        return result;
    }
    /** ==> Sequencially call the partial set of validations (no address ownership confirmation)
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {MemPool} memPool
     * @param {Transaction} transaction
     * @param {string | false} specialTx - 'miner' || 'validator' or false */
    static async partialTransactionValidation(involvedUTXOs, memPool, transaction, specialTx) {
        const result = {
			/** @type {Object<string, string>} */
			impliedKnownPubkeysAddresses: {},
			fee: 0, success: false
		};
        this.isConformTransaction(involvedUTXOs, transaction, specialTx); // also check spendable UTXOs
        
        const impliedKnownPubkeysAddresses = this.controlAllWitnessesSignatures(memPool, transaction);
        result.impliedKnownPubkeysAddresses = impliedKnownPubkeysAddresses;
        if (specialTx === 'miner') { result.success = true; return result; }
        if (!specialTx) result.fee = this.calculateRemainingAmount(involvedUTXOs, transaction);

        result.success = true;
        return result;
    }
}