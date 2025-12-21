// @ts-check
// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible
import { IS_VALID } from '../../types/validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").TxOutput} TxOutput
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger
 * @typedef {import("../workers/workers-classes.mjs").ValidationWorker} ValidationWorker */

const validationMiniLogger = new MiniLogger('validation');
export class TxValidation {
    /** ==> First validation, low computation cost. - control format of : amount, address, rule, version, TxID, UTXOs spendable
     * @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} transaction @param {'miner' | 'validator'} [specialTx] */
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

    /** ==> Third validation, low computation cost. - control the right to create outputs using the rule
     * @param {Transaction} transaction */
    static controlTransactionOutputsRulesConditions(transaction) { //TODO: NOT SURE IF WE CONSERVE THIS
        return;
		/*for (let i = 0; i < transaction.outputs.length; i++) {
            const inRule = transaction.inputs[i] ? transaction.inputs[i].rule : undefined;
            const inAmount = transaction.inputs[i] ? transaction.inputs[i].amount : undefined;
            const inAddress = transaction.inputs[i] ? transaction.inputs[i].address : undefined;
            const outRule = transaction.outputs[i] ? transaction.outputs[i].rule : undefined;
            const outAmount = transaction.outputs[i] ? transaction.outputs[i].amount : undefined;
            const outAddress = transaction.outputs[i] ? transaction.outputs[i].address : undefined;
        }*/
    } // NOT SURE IF WE CONSERVE THIS

    /** ==> Fourth validation, medium computation cost. - control the signature of the inputs
     * @param {ContrastNode} node @param {Transaction} transaction */
    static #controlAllWitnessesSignatures(node, transaction) {
        if (!Array.isArray(transaction.witnesses)) throw new Error(`Invalid witnesses: ${transaction.witnesses} !== array`);
        
		const toSign = Transaction_Builder.getTransactionSignableString(transaction);
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const { signature, pubKeyHex } = this.#decomposeWitnessOrThrow(transaction.witnesses[i]);
			AsymetricFunctions.verifySignature(signature, toSign, pubKeyHex); // will throw an error if the signature is invalid
        }
    }
    /** @param {string} witness */
    static #decomposeWitnessOrThrow(witness) {
        if (typeof witness !== 'string') throw new Error(`Invalid witness: ${witness} !== string`);

        const witnessParts = witness.split(':');
        if (witnessParts.length !== 2) throw new Error('Invalid witness');

        /*const signature = witnessParts[0];
        const pubKeyHex = witnessParts[1];*/
		const [signature, pubKeyHex] = witnessParts;
        if (signature.length !== 128) throw new Error('Invalid signature size');
        if (pubKeyHex.length !== 64) throw new Error('Invalid pubKey size');
        if (!IS_VALID.HEX(signature)) throw new Error(`Invalid signature: ${signature} !== hex`);
        if (!IS_VALID.HEX(pubKeyHex)) throw new Error(`Invalid pubKey: ${pubKeyHex} !== hex`);

        return { signature, pubKeyHex };
    }

    /** ==> Fifth validation, medium disk access cost. ~0.5ms per address.
	 * - Control the inputAddresses/witnessesPubKeys correspondence
	 * - Return the discoveredLink if any. (One only)
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} tx @param {'miner' | 'validator'} [specialTx]
	 * @param {Object<string, AddressLedger>} [involvedLedgers] Pass it for loop validation (avoid re-fetching) */
    static #controlKnownAddressesOwnership(node, involvedUTXOs, tx, specialTx, involvedLedgers = {}) {
		/** @type {Map<string, string>} */
		const addressPubKeyToConfirm = new Map();
		const discovered = { 
			/** @type {null | string} */ address: null,
			/** @type {null | string} */ pubKey: null
		};

		// MINER TX HAS NO ADDRESS OWNERSHIP TO CONFIRM
		if (specialTx === 'miner') return discovered;

		// EXTRACT EXPECTED ( PUBKEY > ADDRESS )s FROM INPUTS
		for (let i = 0; i < tx.inputs.length; i++) {
			const addressToVerify = specialTx === 'validator'
				? tx.inputs[i].split(':')[0] // Validator: address is in the input
				: involvedUTXOs[tx.inputs[i]]?.address; // Normal tx: address is in the UTXO
			if (!addressToVerify) throw new Error(`Unable to find address to verify for input: ${tx.inputs[i]}`);

			const ledger = involvedLedgers[addressToVerify] || node.blockchain.ledgersStorage.getAddressLedger(addressToVerify, false);
			if (addressPubKeyToConfirm.has(ledger.pubKey)) continue;
			if (ledger.pubKey === '0000000000000000000000000000000000000000000000000000000000000000') {
				if (discovered.address && discovered.address !== addressToVerify) throw new Error('Multiple addresses to discover in one transaction');
				else discovered.address = addressToVerify; // only one per transaction maximum
			} else addressPubKeyToConfirm.set(ledger.pubKey, addressToVerify);

			if (involvedLedgers[addressToVerify]) continue;
				involvedLedgers[addressToVerify] = ledger; // STORE FOR LATER USE
		}

		// CONTROL EXPECTED ADDRESSES IN WITNESSES PRESENCE, STORE DISCOVERED PUBKEY IF ANY
		for (const w of tx.witnesses) {
			const { pubKeyHex } = this.#decomposeWitnessOrThrow(w);
			if (pubKeyHex === '0000000000000000000000000000000000000000000000000000000000000000') throw new Error('Invalid pubKey: all zeroes');
			if (addressPubKeyToConfirm.has(pubKeyHex)) addressPubKeyToConfirm.delete(pubKeyHex);
			else if (discovered.pubKey) throw new Error('Multiple pubKeys to discover in one transaction');
			else discovered.pubKey = pubKeyHex; // only one per transaction maximum
		}

		if (discovered.address && !discovered.pubKey) throw new Error('Discovered address without corresponding pubKey');
		if (discovered.pubKey && !discovered.address) throw new Error('Discovered pubKey without corresponding address');
		return discovered;
    }

	/** ==> Seventh validation, high cpu/ram cost (argon2) @param {string} address @param {string} pubKeyHex */
	static async controlAddressDerivation(address, pubKeyHex) {
		const derivedAddressBase58 = await addressUtils.deriveAddress(HashFunctions.Argon2, pubKeyHex);
		if (!derivedAddressBase58) throw new Error(`Invalid address derivation for pubKey: ${pubKeyHex}`);
		if (derivedAddressBase58 !== address) throw new Error('Derived address does not match the provided address');
        await addressUtils.securityCheck(derivedAddressBase58, pubKeyHex);
	}

    /** ==> Sequencially call the set of validations - One discovered link can result
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} transaction @param {'miner' | 'validator'} [specialTx]
	 * @param {Object<string, AddressLedger>} [involvedLedgers] Pass it for chained validation (avoid re-fetching) */
    static async transactionValidation(node, involvedUTXOs, transaction, specialTx, involvedLedgers = {}) {
        this.isConformTransaction(involvedUTXOs, transaction, specialTx); // also check spendable UTXOs
        const fee = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, transaction);
		this.controlTransactionOutputsRulesConditions(transaction);
        this.#controlAllWitnessesSignatures(node, transaction);
		const discovered = this.#controlKnownAddressesOwnership(node, involvedUTXOs, transaction, specialTx, involvedLedgers);
		return { discovered, fee, success: true };
    }
}