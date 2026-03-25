// @ts-check
// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { conditionnals } from '../../utils/conditionals.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { OutputCreationValidator } from './tx-rule-checkers.mjs';
import { UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").TxOutput} TxOutput
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger
 * @typedef {import("../workers/validation-worker-wrapper.mjs").ValidationWorker} ValidationWorker */

export class IdentitiesCache {
	/** @type {Map<string, { address: string, pubKeysHex: string[], threshold: number }>} */
	identities = new Map();

	/** @param {string} address @param {string[]} pubKeysHex @param {number} threshold */
	set(address, pubKeysHex, threshold) {
		if (this.identities.has(address)) throw new Error(`Identity for address ${address} already exists in cache`);
		this.identities.set(address, { address, pubKeysHex, threshold });
	}

	/** @param {string} address */
	has(address) { return this.identities.has(address); }

	/** @param {string} address */
	get(address) { return this.identities.get(address); }
}

const miniLogger = new MiniLogger('validation');
export class TxValidation {
    /** ==> First validation, low computation cost. - control format of : amount, address, rule, version, TxID, UTXOs spendable
     * @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} transaction @param {'solver' | 'validator'} [specialTx] */
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
			if (specialTx === 'solver' && input.length !== serializer.lengths.nonce.str) throw new Error('Invalid coinbase input length');
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
     * - control the fee > 0 or = 0 for solver's txs
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

        if (fee < 0) throw new Error('Negative transaction fee');
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

        const witnessParts = witness.split(':');
		if (witnessParts.length !== 2) throw new Error('Invalid witness');

        const p1 = witnessParts[0];
        if (!IS_VALID.HEX(p1)) throw new Error(`Invalid signature: ${p1} !== hex`);
        if (p1.length !== serializer.lengths.signature.str) throw new Error('Invalid p1 size: not signature');
		//if (witnessParts.length === 1) return { signature, pubKeyHex: null };

        const p2 = witnessParts[1];
        if (!IS_VALID.HEX(p2)) throw new Error(`Invalid pubKeyHash: ${p2} !== hex`);
        const isPubKeyHash = p2.length === serializer.lengths.pubKeyHash.str;
		const isPubKey = p2.length === serializer.lengths.pubKey.str;
		if (!isPubKeyHash && !isPubKey) throw new Error('Invalid p2 size: neither pubKeyHash nor pubKey');

        return { signature: p1, pubKeyHash: isPubKeyHash ? p2 : null, pubKey: isPubKey ? p2 : null };
    }

	/** ==> Fourth validation, low disk access cost. - control the discovery of new identities through outputs with unknown addresses
	 * - Control that outputs with unknown addresses have pubKey in data for reservation
	 * - Control that only one output with unknown address exist in the transaction (one reservation at a time)
	 * - Store the discovered identity in identitiesCache map for loop optimization (avoid re-fetching in store)
	 * @param {ContrastNode} node @param {Transaction} tx @param {IdentitiesCache} [identitiesCache] */
	static controlOutputsIdentities(node, tx, identitiesCache = new IdentitiesCache()) {
		// PRE-CHECK: OUTPUTS WITH UNKNOWN ADDRESSES MUST HAVE VALID DATA FOR RESERVATION
		const discoveredAddressesInThisTx = new Set();
		for (const output of tx.outputs) {
			if (discoveredAddressesInThisTx.has(output.address)) continue; // Already discovered in this loop, no need to check again
			
			// EXTRACT ENTRY FROM DATA AND VERIFY (IF ANY)
			const entry = node.blockchain.identityStore.findAndParseEntry(tx.data, output.address, false);
			if (entry) this.#discoveryEntryCheck(entry.address, entry.pubKeysHex, entry.threshold);
			
			// GET IDENTITY FROM CACHE OR STORE
			const identity = identitiesCache.get(output.address) || node.blockchain.identityStore.getIdentity(output.address);
			if (identity && !identitiesCache.has(output.address)) // FROM DISK => CACHE IT.
				identitiesCache.set(identity.address, identity.pubKeysHex, identity.threshold);

			if (!identity) // NO IDENTITY FOUND IN CACHE OR STORE -> SET ENTRY AS NEW IDENTITY
				if (!entry) throw new Error(`Output with unknown address ${output.address} must have a reservation entry in data field of the transaction`);
				else identitiesCache.set(entry.address, entry.pubKeysHex, entry.threshold); // cache the discovered identity for next iterations
			else if (entry) { // IDENTITY FOUND IN CACHE OR STORE -> IF ENTRY THEN CHECK CONSISTENCY WITH CACHED IDENTITY
				if (identity.threshold !== entry.threshold) throw new Error(`Identity reservation conflict for address ${output.address} has threshold mismatch with cached identity in loop`);
				if (identity.pubKeysHex.length !== entry.pubKeysHex.length) throw new Error(`Identity reservation conflict for address ${output.address} has pubKey length mismatch with cached identity in loop`);
				for (const pk of entry.pubKeysHex) if (!identity.pubKeysHex.includes(pk)) throw new Error(`Identity reservation conflict for address ${output.address} has pubKey mismatch with cached identity in loop`);
			}

			discoveredAddressesInThisTx.add(output.address); // avoid re-checking the same address in the tx -> identity-store will only take first reservation it encounters
		}
	}
	/** @param {string} address @param {string[]} pubKeysHex @param {number} threshold */
	static #discoveryEntryCheck(address, pubKeysHex, threshold) {
		const isMultiSig = ADDRESS.isMultiSigAddress(address);
		if (!isMultiSig && pubKeysHex.length !== 1) throw new Error(`Single-Sig address ${address} reservation must have exactly 1 pubKey in data field`);
		if (isMultiSig)
			if (threshold < 1) throw new Error(`Multi-Sig address ${address} reservation must have a threshold of at least 1`);
			else if (pubKeysHex.length < 2) throw new Error(`Multi-Sig address ${address} reservation must have at least 2 pubKeys in data field`);
			else if (pubKeysHex.length < threshold) throw new Error(`Multi-Sig address ${address} reservation must have at least as many pubKeys in data field as the threshold`);
	}

    /** ==> Fifth validation, low disk access cost. ~0.1ms per address + low cpu cost (xxHash32).
	 * - VALIDATOR/PROVER'S TX CAN'T SPEND UTXOS => NO OWNERSHIP TO CONTROL
	 * - Control the inputAddresses/witnessesPubKeys correspondence
	 * - Control the derivation of addresses<>pubKeys
	 * - Throw if any problem found
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} tx */
    static extractInputsIdentities(node, involvedUTXOs, tx, involvedIdentities = new IdentitiesCache()) {
		// EXTRACT IDENTITIES ( PUBKEY > ADDRESS )s FROM INPUTS

		/** Key: Hash, Value: PubKey @type {Record<string, string>} */
		const pubKeysByHashes = {};
		/** Key: PubKey, Value: Address @type {Record<string, Set<string>>} */
		const addressesToConfirmByPubKey = {};
		for (let i = 0; i < tx.inputs.length; i++) {
			const addressToVerify = involvedUTXOs[tx.inputs[i]]?.address; // address is in the UTXO
			if (!addressToVerify) throw new Error(`Unable to find address to verify for input: ${tx.inputs[i]}`);

			const identity = involvedIdentities.get(addressToVerify) || node.blockchain.identityStore.getIdentity(addressToVerify);
			if (!identity) throw new Error(`Unable to find pubKey for address: ${addressToVerify}`);
			for (const pk of identity.pubKeysHex) {
				const pubKeyHash = HashFunctions.xxHash32(pk, 8);
				const existingPkForHash = pubKeysByHashes[pubKeyHash];
				if (!existingPkForHash) pubKeysByHashes[pubKeyHash] = pk; // cache for lookup during witness confirmation
				else if (existingPkForHash !== pk) throw new Error(`Hash collision detected for pubKey: ${pk} and existing pubKey: ${existingPkForHash}, this is extremely unlikely and should not be a problem for security, but consider changing the hash function if you encounter this warning frequently`);

				if (!addressesToConfirmByPubKey[pk]) addressesToConfirmByPubKey[pk] = new Set([addressToVerify]);
				else if (addressesToConfirmByPubKey[pk].has(addressToVerify)) continue; // already added, no need to add again
				else addressesToConfirmByPubKey[pk].add(addressToVerify);
			}
		}

		// CONTROL DERIVATION (VERY LOW COST, XXHASH32 ON PUBKEYS + DERIVATION CONTROL)
		for (const pk in addressesToConfirmByPubKey)
			for (const address of addressesToConfirmByPubKey[pk])
				if (ADDRESS.isMultiSigAddress(address)) continue; // skip derivation control for multi-sig addresses.
				else if (!ADDRESS.isDerivedFrom(address, pk)) throw new Error(`PubKey ${pk} is not valid for address ${address}`);

		return { pubKeysByHashes, addressesToConfirmByPubKey }; // to verify for the next step (associated witness confirmation)
	}
	
	/** ==> Sixth validation, low computation cost. - control the presence of witnesses associated to the input addresses and pubKeys
	 * - Control that all the addresses associated to the pubKeys in witnesses are effectively confirmed by witnesses
	 * - Throw if any problem found
	 * @param {Transaction} tx @param {Record<string, string>} [pubKeysByHashes] Key: Hash, Value: PubKey @param {Record<string, Set<string>>} [addressesToConfirmByPubKey] Key: PubKey, Value: Set of associated addresses to confirm */
	static controlAddressesHasAssociatedWitnesses(tx, pubKeysByHashes = {}, addressesToConfirmByPubKey = {}) {
		/** Key: PubKey, Value: Signature @type {Set<string>} */
		const seenPubKeys = new Set();
		for (const w of tx.witnesses) {
			const { signature, pubKeyHash, pubKey } = this.#decomposeWitnessOrThrow(w);
			const pubKeyHex = pubKeyHash ? pubKeysByHashes[pubKeyHash] : pubKey;
			if (!pubKeyHex) throw new Error(`No pubKey found for witness with pubKeyHash: ${pubKeyHash}`);
			if (seenPubKeys.has(pubKeyHex)) throw new Error('Duplicate pubKey in witnesses');
			seenPubKeys.add(pubKeyHex);

			// REMOVE ASSOCIATED ADDRESSES FROM THE CONFIRMATION LIST
			const addresses = addressesToConfirmByPubKey[pubKeyHex];
			if (addresses) for (const address of addresses) addressesToConfirmByPubKey[pubKeyHex].delete(address);
		}

		// CHECK ALL PUBKEYS HAVE THEIR ADDRESSES CONFIRMED BY WITNESSES
		for (const pk in addressesToConfirmByPubKey)
			if (addressesToConfirmByPubKey[pk].size > 0) throw new Error(`Not all addresses associated to pubKey ${pk} have been confirmed by witnesses: ${[...addressesToConfirmByPubKey[pk]].join(', ')}`);
	}

	/** ==> Seventh validation, medium computation cost. - control the signature of the inputs
     * @param {Transaction} transaction @param {Record<string, string>} [pubKeysByHashes] Key: Hash, Value: PubKey */
    static controlAllWitnessesSignatures(transaction, pubKeysByHashes = {}) {
        if (!Array.isArray(transaction.witnesses)) throw new Error(`Invalid witnesses: ${transaction.witnesses} !== array`);
        
		const toSign = Transaction_Builder.getTransactionSignableString(transaction);
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const { signature, pubKeyHash, pubKey } = this.#decomposeWitnessOrThrow(transaction.witnesses[i]);
			const pubKeyHex = pubKeyHash ? pubKeysByHashes[pubKeyHash] : pubKey;
			if (!pubKeyHex) throw new Error(`No pubKey found for witness with pubKeyHash: ${pubKeyHash}`);
			AsymetricFunctions.verifySignature(signature, toSign, pubKeyHex); // will throw an error if the signature is invalid
        }
    }

    /** ==> Sequentially call the set of validations (DON'T give a specialTx to this function)
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} tx @param {'solver' | 'validator'} [specialTx] */
    static transactionValidation(node, involvedUTXOs, tx, specialTx, involvedIdentities = new IdentitiesCache()) {
        this.isConformTransaction(involvedUTXOs, tx, specialTx); // also check spendable UTXOs
        const fee = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, tx);
		this.controlTransactionOutputsRulesConditions(tx);
		this.controlOutputsIdentities(node, tx, involvedIdentities);

		const ext = specialTx ? null : this.extractInputsIdentities(node, involvedUTXOs, tx, involvedIdentities);
		this.controlAddressesHasAssociatedWitnesses(tx, ext?.pubKeysByHashes, ext?.addressesToConfirmByPubKey);
		if (specialTx === 'solver') return { fee, success: true }; // solver's txs don't have to respect ownership rules, so we skip signature verification

		this.controlAllWitnessesSignatures(tx, ext?.pubKeysByHashes);
		return { fee, success: true };
    }
}