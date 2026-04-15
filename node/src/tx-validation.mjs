// @ts-check
// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { conditionnals } from '../../utils/conditionals.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { serializer, SIZES } from '../../utils/serializer.mjs';
import { OutputCreationValidator } from './tx-rule-checkers.mjs';
import { UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';
import { AsymetricFunctions } from './conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';

/**
 * @typedef {Object} Identity
 * @property {string} address
 * @property {string[]} pubKeysHex
 * @property {number} threshold
 * 
 * @typedef {Object} qsafeVerifyTask
 * @property {string | Uint8Array} signable
 * @property {string | Uint8Array} signature
 * @property {string | Uint8Array} hybridKey
 * 
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").TxOutput} TxOutput
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger
 * @typedef {import("../workers/validation-worker-wrapper.mjs").ValidationWorker} ValidationWorker */

export class IdentitiesCache {
	/** @type {Map<string, Identity>} */
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
        if (!Array.isArray(transaction.identities)) throw new Error('Invalid transaction identities');
		for (const identity of transaction.identities)
			if (!(identity instanceof Uint8Array)) throw new Error('Invalid transaction identity entry, must be bytes');

		if (specialTx && transaction.inputs.length !== 1) throw new Error(`Invalid coinbase transaction: ${transaction.inputs.length} inputs`);
        if (specialTx && transaction.outputs.length !== 1) throw new Error(`Invalid coinbase transaction: ${transaction.outputs.length} outputs`);
        if (transaction.inputs.length === 0) throw new Error('Invalid transaction: no inputs');
        if (transaction.outputs.length === 0) throw new Error('Invalid transaction: no outputs');
		if (transaction.data && !(transaction.data instanceof Uint8Array)) throw new Error('Invalid transaction data');
        
		const remainingAmount = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, transaction);
        for (let i = 0; i < transaction.outputs.length; i++) {
            const output = transaction.outputs[i];
            this.isConformOutput(output);

			// CHECK OUTPUT CREATION RULE CONDITIONS, FNC THROWS IF INVALID
			OutputCreationValidator.validate(output.rule, involvedUTXOs, transaction, remainingAmount);
        }

        for (const input of transaction.inputs) {
            if (specialTx && typeof input !== 'string') throw new Error('Invalid coinbase/validator input type');
			if (specialTx === 'validator' && !IS_VALID.VALIDATOR_INPUT(input)) throw new Error('Invalid validator input format');
			if (specialTx === 'solver' && !IS_VALID.SOLVER_INPUT(input)) throw new Error('Invalid coinbase input format');
			if (specialTx) continue; // skip further checks for special txs

            if (!IS_VALID.ANCHOR(input)) throw new Error('Invalid anchor');

            const utxo = involvedUTXOs[input];
            if (!utxo) throw new Error(`Invalid transaction: UTXO not found in involvedUTXOs: ${input}`);
            if (utxo.spent) throw new Error(`Invalid transaction: UTXO already spent: ${input}`);
            if (utxo.rule === 'sigOrSlash') throw new Error(`Invalid transaction: sigOrSlash UTXO cannot be spend: ${input}`);
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

	/** ==> Fourth validation, low disk access cost. - control the discovery of new identities
	 * - Store the discovered identity in involvedIdentities map for loop optimization (avoid re-fetching in store)
	 * @param {ContrastNode} node @param {Transaction} tx @param {IdentitiesCache} [involvedIdentities] */
	static controlIdentitiesReservation(node, tx, involvedIdentities = new IdentitiesCache()) {
		for (const entry of tx.identities) {
			const parsed = serializer.deserialize.identityEntry(entry);
			this.#discoveryEntryCheck(parsed.address, parsed.pubKeysHex, parsed.threshold);
			
			const identity = involvedIdentities.get(parsed.address) || node.blockchain.identityStore.getIdentity(parsed.address);
			if (!identity) involvedIdentities.set(parsed.address, parsed.pubKeysHex, parsed.threshold); // cache the discovered identity for next iterations
			else { // IDENTITY FOUND IN CACHE OR STORE -> CHECK CONSISTENCY
				if (identity.threshold !== parsed.threshold) throw new Error(`Identity reservation conflict for address ${parsed.address} has threshold mismatch with cached identity in loop`);
				if (identity.pubKeysHex.length !== parsed.pubKeysHex.length) throw new Error(`Identity reservation conflict for address ${parsed.address} has pubKey length mismatch with cached identity in loop`);
				for (const pk of parsed.pubKeysHex) if (!identity.pubKeysHex.includes(pk)) throw new Error(`Identity reservation conflict for address ${parsed.address} has pubKey mismatch with cached identity in loop`);
			}
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

	/** Fifth validation. - control that outputs's addresses has identity in the cache or disk (reservation or known identity).
	 * @param {ContrastNode} node @param {Transaction} tx @param {IdentitiesCache} involvedIdentities */
	static extractOutputsIdentities(node, tx, involvedIdentities) {
		for (const output of tx.outputs) {
			if (involvedIdentities.has(output.address)) continue; // Already discovered in this loop, no need to check again
		
			const identity = node.blockchain.identityStore.getIdentity(output.address);
			if (!identity) throw new Error(`Output with unknown address ${output.address} must have a reservation entry (reservation or known idendity)`);
			else involvedIdentities.set(output.address, identity.pubKeysHex, identity.threshold);
		}
	}

    /** ==> Sixth validation, low disk access cost. ~0.1ms per address.
	 * - SOLVER'S TX CAN'T SPEND UTXOS => NO OWNERSHIP TO CONTROL
	 * - VALIDATOR'S TX HAS TO BE CONTROLLED
	 * - Control the inputAddresses/witnessesPubKeys correspondence
	 * - Control the derivation of addresses<>pubKeys
	 * - Throw if any problem found
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} tx */
    static extractInputsIdentities(node, involvedUTXOs, tx, involvedIdentities = new IdentitiesCache()) {
		// SET THE ADDRESSES TO CONTROL.
		// EXTRACT MISSING IDENTITIES FROM DISK (WHEN NOT ALREADY IN CACHE)
		/** @type {Set<string>} - Local to this function */
		const involvedAddresses = new Set();
		for (let i = 0; i < tx.inputs.length; i++) {
			const input = tx.inputs[i];
			const isValidatorInput = input.length === SIZES.validatorInput.str;
			const addressToVerify = isValidatorInput ? input.split(":")[0] : involvedUTXOs[input]?.address; // address is either in the validator input or in the UTXO
			if (!addressToVerify) throw new Error(`Unable to find address to verify for input: ${tx.inputs[i]}`);
			
			if (involvedAddresses.has(addressToVerify)) continue; // already in loop, no need to add again
			else involvedAddresses.add(addressToVerify);
			
			if (involvedIdentities.has(addressToVerify)) continue; // already in cache, no need to fetch or check again

			const identity = node.blockchain.identityStore.getIdentity(addressToVerify);
			if (!identity) throw new Error(`Unable to find pubKey for address: ${addressToVerify}`);
			involvedIdentities.set(addressToVerify, identity.pubKeysHex, identity.threshold); // cache for next iterations
		}

		// EXTRACT ADDRESSES<>PUBKEYS CORRESPONDENCE
		/** Local for each tx, Key: Address, Value: Identity @type {Record<string, Identity>} */
		const idenditiesToConfirmByAddress = {};
		for (const address of involvedAddresses) {
			const identity = involvedIdentities.get(address);
			if (!identity) throw new Error(`Identity not found in cache for address ${address}, this should not happen as we fetched all identities for involved addresses in the previous step`);
			else idenditiesToConfirmByAddress[address] = identity;
		}

		return idenditiesToConfirmByAddress; // to verify for the next step (associated witness confirmation)
	}
	
	/** ==> Seventh validation, low computation cost. - control the presence of witnesses associated to the input addresses and pubKeys
	 * - Control that all the addresses associated to the pubKeys in witnesses are effectively confirmed by witnesses
	 * - Throw if any problem found
	 * @param {Transaction} tx @param {Record<string, Identity>} [idenditiesToConfirmByAddress] Key: Address, Value: Identity */
	static controlAddressesHasAssociatedWitnesses(tx, idenditiesToConfirmByAddress = {}) {
		/** witnessesCountPerAddress
		 * - Key: Address, Value: Number of associated witnesses found in the transaction for this address
		 * @type {Record<string, number>} */
		const WCPA = {};
		/** Key: PubKey, Value: Signature @type {Set<string>} */
		const seenPubKeys = new Set();
		const qsafeVerifyTasks = [];
		const signable = Transaction_Builder.getTransactionSignable(tx).hashBytes;
		for (const w of tx.witnesses) {
			const [address, hint, signature] = w;
			if (!idenditiesToConfirmByAddress[address]) throw new Error(`Witness address ${address} not found in identities to confirm, this should not happen as we fetched all identities for involved addresses in the previous step`);
			if (seenPubKeys.has(hint)) throw new Error('Duplicate pubKey hint in witnesses');
			else seenPubKeys.add(hint);
			
			// COUNT THE NUMBER OF WITNESSES PER ADDRESS, AND PREPARE THE QSAGE VERIFY TASKS
			if (!WCPA[address]) WCPA[address] = 0; // init counter for this address if not already
			for (const pk of idenditiesToConfirmByAddress[address].pubKeysHex)
				if (hint !== pk.slice(3, 13)) continue; // compare hint.
				else { WCPA[address]++; qsafeVerifyTasks.push({ signable, signature, hybridKey: pk }) };
		}

		// CHECK IF ALL THRESHOLD ARE MET FOR ALL ADDRESSES, AND IF ALL ADDRESSES HAVE THEIR WITNESSES
		for (const address in idenditiesToConfirmByAddress)
			if ((WCPA[address] || 0) >= idenditiesToConfirmByAddress[address].threshold) continue;
			else throw new Error(`Not enough witnesses for address ${address}`);

		return qsafeVerifyTasks; // to verify for the next step (signature verification)
	}

	/** ==> Eighth validation, medium computation cost. - control the signature of the inputs
     * @param {qsafeVerifyTask[]} [qsafeVerifyTasks] */
    static async controlAllWitnessesSignatures(qsafeVerifyTasks = []) {
		for (const task of qsafeVerifyTasks) // will throw an error if the signature is invalid
			await AsymetricFunctions.qsafeVerify(task.signable, task.signature, task.hybridKey);
    }

    /** ==> Sequentially call the set of validations (DON'T give a specialTx to this function)
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} tx @param {'solver' | 'validator'} [specialTx] */
    static async transactionValidation(node, involvedUTXOs, tx, specialTx, involvedIdentities = new IdentitiesCache()) {
        this.isConformTransaction(involvedUTXOs, tx, specialTx); // also check spendable UTXOs
        const fee = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, tx);
		this.controlTransactionOutputsRulesConditions(tx);
		this.controlIdentitiesReservation(node, tx, involvedIdentities);
		this.extractOutputsIdentities(node, tx, involvedIdentities);
		if (specialTx === 'solver') return { fee, success: true }; // solver's txs don't have to respect ownership rules, so we skip signature verification
		
		const idenditiesToConfirmByAddress = this.extractInputsIdentities(node, involvedUTXOs, tx, involvedIdentities);
		const qsafeVerifyTasks = this.controlAddressesHasAssociatedWitnesses(tx, idenditiesToConfirmByAddress);
		await this.controlAllWitnessesSignatures(qsafeVerifyTasks);
		return { fee, success: true };
    }
}