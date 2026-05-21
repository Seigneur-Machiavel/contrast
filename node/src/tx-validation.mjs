// @ts-check
// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible
import { ADDRESS } from '../../types/address.mjs';
import { AsymetricFunctions } from './conCrypto.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { serializer, SIZES } from '../../utils/serializer.mjs';
import { OutputCreationValidator } from './tx-rule-checkers.mjs';
import { UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';
import { Identity, EntriesCache, IdentitiesCache, QsafeVerifyTask } from '../../types/identity.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/transaction.mjs").TxOutput} TxOutput
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../storage/identity-store.mjs").IdentityStore} IdentityStore
 * @typedef {import("../workers/validation-worker-wrapper.mjs").ValidationWorker} ValidationWorker */

const miniLogger = new MiniLogger('validation');
export class TxValidation {
    /** ==> First validation, low computation cost.
	 * - control format of : amount, address, rule, version, TxID, UTXOs spendable
	 * - return the fee amount
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

		return remainingAmount;
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
	 * @param {ContrastNode} node @param {Transaction} tx @param {EntriesCache} entriesCache */
	static controlIdentitiesReservation(node, tx, entriesCache) {
		for (const entry of tx.identities) {
			if (entriesCache.has(entry)) throw new Error('Identity reservation collision detected!');

			const parsed = serializer.deserialize.identityEntry(entry);
			if (!parsed.threshold) throw new Error(`Identity entry must have a threshold of at least 1`);
			if (parsed.threshold > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`Identity entry cannot have a threshold higher than ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig}`);
			if (parsed.pubKeysHex.length === 0) throw new Error(`Identity entry must have at least one pubKey in data field`);
			if (parsed.pubKeysHex.length > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`Identity entry cannot have more than ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig} pubKeys in data field`);
			
			const isWalletOwner = node.blockchain.ownershipStorage.getOwnedRootAddress(parsed.pubKeysHex);
			if (parsed.pubKeysHex.length !== 1) throw new Error("MULTISIG ISN'T IMPLEMENTED YET");
			if (isWalletOwner) throw new Error("pubKey already own a wallet, can't declare a new one");
			entriesCache.set(entry);
		}
	}

	/** ==> Seventh validation, low computation cost. - control the validity of specialTx self reservation
	 * @param {ContrastNode} node @param {Transaction} tx @param {IdentitiesCache} identitiesCache @param {EntriesCache} entriesCache */
	static extractSpecialTxIdentities(node, tx, identitiesCache, entriesCache) {
		let identityEntryIndex = 0;
		const { identityStore } = node.blockchain;
		const nextIdentityEntry = () => tx.identities[identityEntryIndex++];
		const nextRootAddresses = identityStore.nextRootAddressToCreate('C', 3);

		/** @param {string} walletId */
		const handleAddressEntry = (walletId) => {
			if (identityStore.hasIdentity(walletId)) {
				if (identitiesCache.get(walletId)) return; // already in cache -> just return
				const id = identityStore.getIdentity(walletId);
				if (!id) throw new Error(`Identity ${walletId} does not exist in the store`);
				return identitiesCache.set(walletId, id.pubKeysHex, id.threshold); // set in cache and return
			}
			if (!nextRootAddresses.includes(walletId)) throw new Error(`Transaction address ${walletId} is not the expected next root address for identity reservation`);
			
			const entry = nextIdentityEntry();
			if (!entry)
				if (identitiesCache.get(walletId)) return;
				else throw new Error('Missing identity entry for reserved address: ' + walletId);
			if (entriesCache.has(entry)) throw new Error('Identity reservation collision detected!');
			
			const { pubKeysHex, threshold } = serializer.deserialize.identityEntry(entry);
			if (pubKeysHex.length !== 1) throw new Error('Invalid identity entry for solver transaction, must contain exactly 1 pubKey');
			if (threshold !== 1) throw new Error('Invalid identity entry for solver transaction, threshold must be 1');
			
			// TODO: check if identity already exist : ledgerStore.hasLedger(pubKeyHash) -> CAN'T REDECLARE IDENTITY!!!
			const isWalletOwner = node.blockchain.ownershipStorage.getOwnedRootAddress(pubKeysHex);
			if (isWalletOwner) throw new Error("pubKey already own a wallet, can't declare a new one");
			entriesCache.set(entry); // cache it to make collision check.
			identitiesCache.set(walletId, pubKeysHex, threshold, true); // set as self declared
		}
		
		// SOLVER CHECK
		if (tx.inputs[0].length === SIZES.nonce.str) {
			const rewardWalletId = ADDRESS.getAddressRoot(tx.outputs[0].address).walletId;
			handleAddressEntry(rewardWalletId);
			if (nextIdentityEntry()) throw new Error('Ghost identity entry found in solver transaction');
			return;
		}

		// VALIDATOR CHECK
		if (tx.inputs[0].length === SIZES.validatorInput.str) {
			const validatorWalletId = ADDRESS.getAddressRoot(tx.inputs[0].split(":")[0]).walletId;
    		const rewardWalletId = ADDRESS.getAddressRoot(tx.outputs[0].address).walletId;
			handleAddressEntry(validatorWalletId);
			handleAddressEntry(rewardWalletId);
			identitiesCache.requiredWitnesses.add(validatorWalletId); // validator must sign
			if (nextIdentityEntry()) throw new Error('Ghost identity entry found in validator transaction');
			return;
		}

		throw new Error('Invalid special transaction input format');
	}
    /** ==> Seventh validation, low disk access cost. ~0.1ms per address.
	 * - Not for specialTx!
	 * - Control the inputAddresses/witnessesPubKeys correspondence
	 * - Control the derivation of addresses<>pubKeys
	 * - Throw if any problem found
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
	 * @param {Transaction} tx @param {IdentitiesCache} identitiesCache */
    static extractRegularTxIdentities(node, involvedUTXOs, tx, identitiesCache) {
		// SET THE ADDRESSES TO CONTROL.
		// EXTRACT MISSING IDENTITIES FROM DISK (WHEN NOT ALREADY IN CACHE)
		/** @type {Set<string>} - Local to this function */
		const involvedWalletId = new Set();
		const { identityStore } = node.blockchain;
		for (const input of tx.inputs) {
			const addressToVerify = involvedUTXOs[input]?.address;
			if (!addressToVerify) throw new Error(`Unable to find address to verify for input: ${input}`);

			const walletId = ADDRESS.getAddressRoot(addressToVerify).walletId;
			if (involvedWalletId.has(walletId)) continue; // already in loop, no need to add again
			else involvedWalletId.add(walletId);
			
			const cachedId = identitiesCache.get(walletId);
			if (cachedId) { // IF ALREADY IN CACHE, NO NEED TO FETCH/CHECK AGAIN
				if (!identitiesCache.requiredWitnesses.has(walletId)) throw new Error('requiredWitnesses should includes walletId!!');
				if (cachedId.selfDeclared) throw new Error('Unable to spend UTXO from a self declared ID');
				continue; // CORRECT
			}

			const identity = identityStore.getIdentity(walletId);
			if (!identity) throw new Error(`Unable to find pubKey for walletId: ${walletId}`);
			if (identity.pubKeysHex.length !== 1) throw new Error("MULTISIG ISN'T IMPLEMENTED YET");
			identitiesCache.set(walletId, identity.pubKeysHex, identity.threshold); // cache for next iterations
			identitiesCache.requiredWitnesses.add(walletId);
		}
	}
	
	/** ==> Eighth validation, low computation cost. - control the presence of witnesses associated to the input addresses and pubKeys
	 * - Control that all the addresses associated to the pubKeys in witnesses are effectively confirmed by witnesses
	 * - Throw if any problem found
	 * @param {Transaction} tx @param {IdentitiesCache} identitiesCache */
	static controlAddressesHasAssociatedWitnesses(tx, identitiesCache) {
		/** key: walletId @type {Record<string, Set<string>>} */
		const signatures = {};
		const signable = Transaction_Builder.getTransactionSignable(tx).hashBytes;
		for (const w of tx.witnesses) {
			const [address, signature] = w;
			const walletId = ADDRESS.getAddressRoot(address).walletId;
			const id = identitiesCache.get(walletId);
			if (!id) throw new Error(`Witness ${walletId} not found in identities to confirm, this should not happen as we fetched all identities for involved addresses in the previous step`);
			
			if (!signatures[walletId]) signatures[walletId] = new Set();
			if (signatures[walletId].has(signature)) throw new Error('Signature duplicate!!');
			signatures[walletId].add(signature);
		}

		// CHECK IF ALL THRESHOLD ARE MET
		/** key: walletId @type {Record<string, QsafeVerifyTask>} */
		const qsafeVerifyTasks = {};
		for (const walletId in signatures) {
			if (!identitiesCache.requiredWitnesses.has(walletId)) throw new Error("A set of signatures isn't corresponding to any required witness!!");
			
			const id = identitiesCache.get(walletId);
			if (!id) throw new Error(`${walletId} not found in identities to confirm, this should not happen as we fetched all identities for involved addresses in the previous step`);
			if (signatures[walletId].size < id.threshold) throw new Error(`Not enough witnesses for walletId: ${walletId}`);

			qsafeVerifyTasks[walletId] = new QsafeVerifyTask(signable, id.pubKeysHex, signatures[walletId]);
			identitiesCache.requiredWitnesses.delete(walletId);
		}

		// CHECK IF ALL REQUIRED WITNESSES ARE CONSUMMED
		if (identitiesCache.requiredWitnesses.size !== 0) throw new Error('Missing signature in tx!! Aborting before signarture validation.');
		return qsafeVerifyTasks; // to verify for the next step (signature verification)
	}

	/** ==> Ninth validation, medium computation cost. ~8ms/task @param {QsafeVerifyTask} qsafeVerifyTask */
    static async controlAllWitnessesSignatures(qsafeVerifyTask) {
		const { signable, pubKeysHex, signatures } = qsafeVerifyTask;
		const signaturesArray = Array.from(signatures);
		for (const signature of signaturesArray) {
			let correspondingPubKeyHasBeenRemoved = false;
			for (let i = 0; i < pubKeysHex.length; i++) {
				const pubKeyHex = pubKeysHex[i];
				try { // will throw an error if the signature is invalid
					await AsymetricFunctions.qsafeVerify(signable, signature, pubKeyHex);
					pubKeysHex.splice(i, 1); // Consumed pubkeys are spliced out to avoid reuse across signatures (one pubkey = one signature)
					correspondingPubKeyHasBeenRemoved = true;
				} catch (error) {};
			}

			if (!correspondingPubKeyHasBeenRemoved) throw new Error('Unable to find corresponding pubKeyHex for signature!')
		}
    }

    /** ==> Sequentially call the set of validations (DON'T give a specialTx to this function)
	 * @param {ContrastNode} node @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} tx @param {'solver' | 'validator'} [specialTx] */
    static async transactionValidation(node, involvedUTXOs, tx, specialTx) {
        const fee = this.isConformTransaction(involvedUTXOs, tx, specialTx); // also check spendable UTXOs
		const identitiesCache = new IdentitiesCache();
		const entriesCache = new EntriesCache();
		this.controlTransactionOutputsRulesConditions(tx);
		if (!specialTx) {
			this.controlOutputsHasIdentities(node, tx);
			this.controlIdentitiesReservation(node, tx, entriesCache);
			this.extractRegularTxIdentities(node, involvedUTXOs, tx, identitiesCache);
		} else this.extractSpecialTxIdentities(node, tx, identitiesCache, entriesCache);
		
		if (specialTx === 'solver') return { fee, success: true }; // solver's txs don't have to respect ownership rules, so we skip signature verification

		const qsafeVerifyTasks = this.controlAddressesHasAssociatedWitnesses(tx, identitiesCache);
		for (const walletId in qsafeVerifyTasks) await this.controlAllWitnessesSignatures(qsafeVerifyTasks[walletId]);

		return { fee, success: true };
    }
}