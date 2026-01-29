// @ts-check
// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { OutputCreationValidator } from './tx-rule-checkers.mjs';
import { UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").TxOutput} TxOutput
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger
 * @typedef {import("../workers/validation-worker-wrapper.mjs").ValidationWorker} ValidationWorker */

const miniLogger = new MiniLogger('validation');
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
		if (transaction.data && !(transaction.data instanceof Uint8Array)) throw new Error('Invalid transaction data');

        try { for (const witness of transaction.witnesses) this.#decomposeWitnessOrThrow(witness);
        } catch (/**@type {any}*/ error) { throw new Error('Invalid signature size'); }
        
		const remainingAmount = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, transaction);
        for (let i = 0; i < transaction.outputs.length; i++) {
            const output = transaction.outputs[i];
            this.isConformOutput(output);

			// CHECK OUTPUT CREATION RULE CONDITIONS, FNC THROWS IF INVALID
			OutputCreationValidator.validate(output.rule, involvedUTXOs, transaction, remainingAmount);
        }

        for (const input of transaction.inputs) {
            if (specialTx && typeof input !== 'string') throw new Error('Invalid coinbase/validator input type');
			if (specialTx && !IS_VALID.HEX(input)) throw new Error(`Invalid coinbase/validator input(not HEX): ${input}`);
			if (specialTx === 'validator' && input.length !== serializer.lengths.hash.str) throw new Error('Invalid validator input length');
			if (specialTx === 'miner' && input.length !== serializer.lengths.nonce.str) throw new Error('Invalid coinbase input length');
			if (specialTx) continue; // skip further checks for special txs

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
        if (!ADDRESS.checkConformity(txOutput.address)) throw new Error(`Invalid address: ${txOutput.address}`);
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

    /** @param {string} witness */
    static #decomposeWitnessOrThrow(witness) {
        if (typeof witness !== 'string') throw new Error(`Invalid witness: ${witness} !== string`);

		// commented code allows pubKey-less witness (future use case?)
        const witnessParts = witness.split(':');
		if (witnessParts.length !== 2) throw new Error('Invalid witness');
        //if (witnessParts.length === 0 || witnessParts.length > 2) throw new Error('Invalid witness');

        const signature = witnessParts[0];
        if (signature.length !== serializer.lengths.signature.str) throw new Error('Invalid signature size');
        if (!IS_VALID.HEX(signature)) throw new Error(`Invalid signature: ${signature} !== hex`);
		//if (witnessParts.length === 1) return { signature, pubKeyHex: null };

        const pubKeyHex = witnessParts[1];
        if (pubKeyHex.length !== serializer.lengths.pubKey.str) throw new Error('Invalid pubKey size');
        if (!IS_VALID.HEX(pubKeyHex)) throw new Error(`Invalid pubKey: ${pubKeyHex} !== hex`);

        return { signature, pubKeyHex };
    }

    /** ==> Fifth validation, low disk access cost. ~0.1ms per address + low cpu cost (xxHash32).
	 * - Control the inputAddresses/witnessesPubKeys correspondence
	 * - Control the derivation of addresses<>pubKeys
	 * - Throw if any problem found
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} tx @param {'miner' | 'validator'} [specialTx]
	 * Key: Address, Value: PubKeys @param {Map<string, Set<string>>} [involvedIdentities] Pass it for loop validation (avoid re-fetching) */
    static controlAddressesOwnership(node, involvedUTXOs, tx, specialTx, involvedIdentities = new Map()) {
		/** Key: PubKey, Value: Address @type {Map<string, string>} */
		const pkAddressToConfirm = new Map();
		/** Key: PubKey, Value: Signature @type {Map<string, string>} */
		const pkSignatureToConfirm = new Map();

		/** Temp object to store discovered address and pubKeys */
		const discovered = {
			/** @type {null | string} */ address: null,
			/** @type {Set<string>} */	 pubKeys: new Set(),
		};

		// MINER TX HAS NO ADDRESS OWNERSHIP TO CONFIRM
		if (specialTx) return; // No address & discovery to perform for special txs

		// EXTRACT DISCOVERED ADDRESS AND EXPECTED ( PUBKEY > ADDRESS )s FROM INPUTS
		for (let i = 0; i < tx.inputs.length; i++) {
			const addressToVerify = involvedUTXOs[tx.inputs[i]]?.address; // address is in the UTXO
			if (!addressToVerify) throw new Error(`Unable to find address to verify for input: ${tx.inputs[i]}`);

			const pks = involvedIdentities.get(addressToVerify) || node.blockchain.identityStore.get(addressToVerify);
			if (!pks) // NEW IDENTITY => DISCOVER
				if (discovered.address && discovered.address !== addressToVerify) throw new Error('Multiple addresses to discover in one transaction');
				else discovered.address = addressToVerify; // only one per transaction maximum
			
			else for (const pk of pks) // EXISTING => SET TO CONFIRM
				if (!pkAddressToConfirm.has(pk)) pkAddressToConfirm.set(pk, addressToVerify);
		}

		// CONTROL EXPECTED ADDRESSES IN WITNESSES PRESENCE, STORE DISCOVERED PUBKEY IF ANY
		for (const w of tx.witnesses) {
			const { pubKeyHex, signature } = this.#decomposeWitnessOrThrow(w);
			if (pkSignatureToConfirm.has(pubKeyHex)) throw new Error('Duplicate pubKey in witnesses');

			const isInToConfirmList = pkAddressToConfirm.has(pubKeyHex); 
			const address = isInToConfirmList ? pkAddressToConfirm.get(pubKeyHex) : discovered.address;
			if (!address) throw new Error('Witness pubKey has no corresponding address to confirm or discover');
			if (!ADDRESS.isDerivedFrom(address, pubKeyHex)) throw new Error(`Witness pubKey does not match address: ${address}`);
			
			// STORE AS CONFIRMED, THROW IF ENCOUNTERED AGAIN
			pkSignatureToConfirm.set(pubKeyHex, signature);
			pkAddressToConfirm.delete(pubKeyHex);
			
			// NEW IDENTITY => DISCOVER
			if (!isInToConfirmList) discovered.pubKeys.add(pubKeyHex);
			if (!involvedIdentities.has(address)) involvedIdentities.set(address, new Set());

			// @ts-ignore: We just checked that involvedIdentities has the address or we created it
			involvedIdentities.get(address).add(pubKeyHex);
		}

		// CHECK ALL PUBKEYS WERE CONFIRMED
		if (pkAddressToConfirm.size !== 0) throw new Error('Not all pubKey/address could be confirmed');
		if (!discovered.address) return involvedIdentities; // NO DISCOVERY TO PERFORM => EXIT

		// CHECK DISCOVERY CONSISTENCY
		const isMultiSig = ADDRESS.isMultiSigAddress(discovered.address);
		if (discovered.pubKeys.size === 0) throw new Error('No pubKey discovered for new address');
		if (!isMultiSig && discovered.pubKeys.size !== 1) throw new Error('Single-Sig address with multiple pubKeys to discover');
		if (isMultiSig && discovered.pubKeys.size < 2) throw new Error('Multi-Sig address with less than 2 pubKeys to discover');

		return involvedIdentities;
	}

	/** ==> Fourth validation, medium computation cost. - control the signature of the inputs
     * @param {Transaction} transaction */
    static controlAllWitnessesSignatures(transaction) {
        if (!Array.isArray(transaction.witnesses)) throw new Error(`Invalid witnesses: ${transaction.witnesses} !== array`);
        
		const toSign = Transaction_Builder.getTransactionSignableString(transaction);
        for (let i = 0; i < transaction.witnesses.length; i++) {
            let { signature, pubKeyHex } = this.#decomposeWitnessOrThrow(transaction.witnesses[i]);
			AsymetricFunctions.verifySignature(signature, toSign, pubKeyHex); // will throw an error if the signature is invalid
        }
    }

    /** ==> Sequencially call the set of validations
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} transaction @param {'miner' | 'validator'} [specialTx]
	 * @param {Map<string, Set<string>>} [involvedIdentities] Key: Address, Value: PubKey */
    static transactionValidation(node, involvedUTXOs, transaction, specialTx, involvedIdentities = new Map()) {
        this.isConformTransaction(involvedUTXOs, transaction, specialTx); // also check spendable UTXOs
        const fee = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, transaction);
		this.controlTransactionOutputsRulesConditions(transaction);
		this.controlAddressesOwnership(node, involvedUTXOs, transaction, specialTx, involvedIdentities);
        this.controlAllWitnessesSignatures(transaction);
		return { fee, success: true };
    }
}