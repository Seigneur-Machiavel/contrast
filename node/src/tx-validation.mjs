// @ts-check
// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { hybridKeyHint } from '../../utils/common.mjs';
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
 * @typedef {import("../../storage/identity-store.mjs").IdentityStore} IdentityStore
 * @typedef {import("../workers/validation-worker-wrapper.mjs").ValidationWorker} ValidationWorker */

export class IdentitiesCache {
	/** key: addres, value: Identity @type {Map<string, Identity>} */
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
/** Cache of the tx identity entries in a block to detect collision */
export class EntriesCache {
	/** @type {Uint8Array[]} */
	#cache = [];

	/** @param {Uint8Array} serializedEntry */
	set(serializedEntry) {
		this.#cache.push(serializedEntry);
	}
	/** @param {Uint8Array} serializedEntry */
	has(serializedEntry) {
		for (const s of this.#cache) {
			if (s.length !== serializedEntry.length) continue;
			if (s.every((byte, index) => byte === serializedEntry[index])) return true;
		}
		return false;
	}
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
        if (specialTx === 'validator' && transaction.identities.length > 2) throw new Error(`Invalid validator transaction: more than 2 identity entry`);
		if (specialTx === 'solver' && transaction.identities.length > 1) throw new Error(`Invalid coinbase transaction: more than 1 identity entry`);
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

    /** ==> Third validation, low computation cost. - control the right to create outputs using the rule @param {Transaction} tx */
    static controlTransactionOutputsRulesConditions(tx) { //TODO: NOT SURE IF WE CONSERVE THIS
        const outRules = new Set();
		for (const output of tx.outputs)
			if (!outRules.has(output.rule)) outRules.add(output.rule);
		
		if (outRules.has('sigOrSlash'))
			if (!tx.data) throw new Error('Transactions creating sigOrSlash outputs must have data field with the authorized validators addresses');
			else if (tx.data.length % SIZES.address.bytes !== 0) throw new Error('Invalid data field for sigOrSlash output, must be a multiple of address size');
    }
	
	/** ===> Fifth validation. Control that outputs's addresses has identity in the disk (known identity).
	 * - Not for specialTx! @param {ContrastNode} node @param {Transaction} tx */
	static controlOutputsHasIdentities(node, tx) {
		for (const output of tx.outputs)
			if (!node.blockchain.identityStore.hasIdentity(output.address))
				throw new Error(`Output address ${output.address} has no associated identity, it must be reserved before being used in a transaction`);
	}

	/** ==> Sixth validation, low disk access cost. Control the discovery of new identities
	 * - Not for specialTx!
	 * - Store the discovered identity in involvedIDs map for loop optimization (avoid re-fetching in store)
	 * @param {ContrastNode} node @param {Transaction} tx @param {IdentitiesCache} involvedIDs */
	static controlIdentitiesReservation(node, tx, involvedIDs, entriesCache = new EntriesCache()) {
		for (const entry of tx.identities) {
			if (entriesCache.has(entry)) throw new Error('Identity reservation collision detected!');
			//if (involvedIDs.hasEntry(entry)) continue; // Already discovered in this loop, no need to check again

			const parsed = serializer.deserialize.identityEntry(entry);
			if (!parsed.threshold) throw new Error(`Identity entry must have a threshold of at least 1`);
			if (parsed.threshold > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`Identity entry cannot have a threshold higher than ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig}`);
			if (parsed.pubKeysHex.length === 0) throw new Error(`Identity entry must have at least one pubKey in data field`);
			if (parsed.pubKeysHex.length > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`Identity entry cannot have more than ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig} pubKeys in data field`);
			
			// TODO: check if identity already exist : ledgerStore.hasLedger(pubKeyHash) -> CAN'T REDECLARE IDENTITY!!!
			entriesCache.set(entry);
		}
	}

	/** ==> Seventh validation, low computation cost. - control the validity of specialTx self reservation
	 * @param {IdentityStore} identityStore @param {Transaction} tx @param {Record<string, Identity>} [idenditiesToConfirmByAddress] Key: Address, Value: Identity */
	static extractSpecialTxIdentities(identityStore, tx, idenditiesToConfirmByAddress = {}, entriesCache = new EntriesCache()) {
		let identityEntryIndex = 0;
		const nextIdentityEntry = () => tx.identities[identityEntryIndex++];
		const nextRootAddresses = identityStore.nextRootAddressToCreate('C', 3);

		/** @param {string} address */
		const handleAddressEntry = (address) => {
			if (identityStore.hasIdentity(address)) {
				const identity = identityStore.getIdentity(address);
				if (!identity) throw new Error(`Identity ${address} does not exist in the store`);
				return idenditiesToConfirmByAddress[address] = identity;
			}
			if (!nextRootAddresses.includes(address)) throw new Error(`Transaction address ${address} is not the expected next root address for identity reservation`);
			
			const entry = nextIdentityEntry();
			if (!entry)
				if (idenditiesToConfirmByAddress[address]) return;
				else throw new Error('Missing identity entry for reserved address: ' + address);
			if (entriesCache.has(entry)) throw new Error('Identity reservation collision detected!');
			
			const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(entry);
			if (pubKeysHex.length !== 1) throw new Error('Invalid identity entry for solver transaction, must contain exactly 1 pubKey');
			if (threshold !== 1) throw new Error('Invalid identity entry for solver transaction, threshold must be 1');
			
			// TODO: check if identity already exist : ledgerStore.hasLedger(pubKeyHash) -> CAN'T REDECLARE IDENTITY!!!
			entriesCache.set(entry); // cache it to make collision check.
			idenditiesToConfirmByAddress[address] = { address, pubKeysHex, threshold }; // cache the reserved identity for later confirmation in the signature verification step
		}
		
		// SOLVER CHECK
		if (tx.inputs[0].length === SIZES.nonce.str) {
			handleAddressEntry(tx.outputs[0].address);
			if (nextIdentityEntry()) throw new Error('Ghost identity entry found in solver transaction');
			return idenditiesToConfirmByAddress;
		}

		// VALIDATOR CHECK
		if (tx.inputs[0].length === SIZES.validatorInput.str) {
			handleAddressEntry(tx.inputs[0].split(":")[0]);
			handleAddressEntry(tx.outputs[0].address);
			if (nextIdentityEntry()) throw new Error('Ghost identity entry found in validator transaction');
			return idenditiesToConfirmByAddress;
		}

		throw new Error('Invalid special transaction input format');
	}
    /** ==> Seventh validation, low disk access cost. ~0.1ms per address.
	 * - Not for specialTx!
	 * - Control the inputAddresses/witnessesPubKeys correspondence
	 * - Control the derivation of addresses<>pubKeys
	 * - Throw if any problem found
	 * @param {IdentityStore} identityStore @param {Object<string, UTXO>} involvedUTXOs @param {Transaction} tx
	 * @param {Record<string, Identity>} [idenditiesToConfirmByAddress] Key: Address, Value: Identity */
    static extractRegularTxIdentities(identityStore, involvedUTXOs, tx, idenditiesToConfirmByAddress = {}, involvedIDs = new IdentitiesCache()) {
		// SET THE ADDRESSES TO CONTROL.
		// EXTRACT MISSING IDENTITIES FROM DISK (WHEN NOT ALREADY IN CACHE)
		/** @type {Set<string>} - Local to this function */
		const involvedAddresses = new Set();
		for (const input of tx.inputs) {
			const addressToVerify = involvedUTXOs[input]?.address;
			if (!addressToVerify) throw new Error(`Unable to find address to verify for input: ${input}`);

			if (involvedAddresses.has(addressToVerify)) continue; // already in loop, no need to add again
			else involvedAddresses.add(addressToVerify);
			
			if (involvedIDs.has(addressToVerify)) continue; // already in cache, no need to fetch or check again

			const identity = identityStore.getIdentity(addressToVerify);
			if (!identity) throw new Error(`Unable to find pubKey for address: ${addressToVerify}`);
			involvedIDs.set(addressToVerify, identity.pubKeysHex, identity.threshold); // cache for next iterations
		}

		// EXTRACT ADDRESSES<>PUBKEYS CORRESPONDENCE
		/** Local for each tx, Key: Address, Value: Identity @type {Record<string, Identity>} */
		for (const address of involvedAddresses) {
			const identity = involvedIDs.get(address);
			if (!identity) throw new Error(`Identity not found in cache for address ${address}, this should not happen as we fetched all identities for involved addresses in the previous step`);
			else idenditiesToConfirmByAddress[address] = identity;
		}

		return idenditiesToConfirmByAddress; // to verify for the next step (associated witness confirmation)
	}
	
	/** ==> Eighth validation, low computation cost. - control the presence of witnesses associated to the input addresses and pubKeys
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
			WCPA[address] ??= 0; // init counter for this address if not already
			for (const pk of idenditiesToConfirmByAddress[address].pubKeysHex) {
				if (hint !== hybridKeyHint(pk)) continue; // compare hint.
				qsafeVerifyTasks.push({ signable, signature, hybridKey: pk });
				WCPA[address]++;
			}
		}

		// CHECK IF ALL THRESHOLD ARE MET FOR ALL ADDRESSES, AND IF ALL ADDRESSES HAVE THEIR WITNESSES
		for (const address in idenditiesToConfirmByAddress)
			if ((WCPA[address] || 0) < idenditiesToConfirmByAddress[address].threshold)
				throw new Error(`Not enough witnesses for address ${address}`);

		return qsafeVerifyTasks; // to verify for the next step (signature verification)
	}

	/** ==> Ninth validation, medium computation cost. ~8ms/task @param {qsafeVerifyTask[]} [qsafeVerifyTasks] */
    static async controlAllWitnessesSignatures(qsafeVerifyTasks = []) {
		for (const task of qsafeVerifyTasks) // will throw an error if the signature is invalid
			await AsymetricFunctions.qsafeVerify(task.signable, task.signature, task.hybridKey);
    }

    /** ==> Sequentially call the set of validations (DON'T give a specialTx to this function)
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} tx @param {'solver' | 'validator'} [specialTx]
	 * @param {IdentitiesCache} [involvedIDs] */
    static async transactionValidation(node, involvedUTXOs, tx, specialTx, involvedIDs = new IdentitiesCache()) {
		const identityStore = node.blockchain.identityStore;
        this.isConformTransaction(involvedUTXOs, tx, specialTx); // also check spendable UTXOs
       
		let idenditiesToConfirmByAddress;
		const fee = specialTx ? 0 : this.calculateRemainingAmount(involvedUTXOs, tx);
		this.controlTransactionOutputsRulesConditions(tx);
		if (!specialTx) {
			this.controlOutputsHasIdentities(node, tx);
			this.controlIdentitiesReservation(node, tx, involvedIDs);
			idenditiesToConfirmByAddress = this.extractRegularTxIdentities(identityStore, involvedUTXOs, tx, undefined, involvedIDs);
		} else idenditiesToConfirmByAddress = this.extractSpecialTxIdentities(identityStore, tx);
		
		if (specialTx === 'solver') return { fee, success: true }; // solver's txs don't have to respect ownership rules, so we skip signature verification

		const qsafeVerifyTasks = this.controlAddressesHasAssociatedWitnesses(tx, idenditiesToConfirmByAddress);
		await this.controlAllWitnessesSignatures(qsafeVerifyTasks);
		return { fee, success: true };
    }
}