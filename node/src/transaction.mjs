// @ts-check
import { BlockUtils } from './block.mjs';
import { QsafeHelper } from './conCrypto.mjs';
import { ADDRESS } from '../../types/address.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { conditionnals } from '../../utils/conditionals.mjs';
import { serializer, BinaryWriter, SIZES } from '../../utils/serializer.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';
import { Transaction, TxOutput, UTXO, UTXO_RULES_GLOSSARY } from '../../types/transaction.mjs';

/**
 * @typedef {import('./account.mjs').Account} Account
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
    /** @param {string} nonceHex @param {string} address @param {number} amount @param {Uint8Array[] | undefined} [identities] @param {Uint8Array | undefined} [data] */
    static async createSolverReward(nonceHex, address, amount, identities, data) {
        if (typeof nonceHex !== 'string') throw new Error('Invalid nonceHex');
        if (typeof address !== 'string') throw new Error('Invalid address');
        if (typeof amount !== 'number') throw new Error('Invalid amount');
		if (data && !(data instanceof Uint8Array)) throw new Error('Invalid data');

        const coinbaseOutput = new TxOutput(amount, 'sig', address);
		return new Transaction([nonceHex], [coinbaseOutput], undefined, identities, data);
    }
    /** @param {number} posReward @param {BlockCandidate} blockCandidate @param {string} validatorAddress @param {string} rewardAddress - who will receive the reward @param {Uint8Array[] | undefined} [identities] @param {Uint8Array | undefined} [data] */
    static async createValidatorReward(posReward, blockCandidate, validatorAddress, rewardAddress, identities, data) {
        if (typeof rewardAddress !== 'string') throw new Error('Invalid rewardAddress');
        if (data && !(data instanceof Uint8Array)) throw new Error('Invalid data');

        const posHashHex = await BlockUtils.getBlockSignature(blockCandidate, true);
        const posInput = `${validatorAddress}:${posHashHex}`;
        const posOutput = new TxOutput(posReward, 'sig', rewardAddress);
		return new Transaction([posInput], [posOutput], undefined, identities, data);
    }
    /** @param {Account} senderAccount @param {{recipientAddress: string, amount: number}[]} transfers @param {number} feePerByte @param {Uint8Array[]} [identities] @param {Uint8Array} [data] */
    static createTransaction(senderAccount, transfers, feePerByte = 1, identities = [], data, inMaxAmount = false) {
        const { address, hybridKey } = senderAccount;
		if (!address || !hybridKey) throw new Error('Sender account is not properly initialized');

		const ruleCodesToExclude = new Set([UTXO_RULES_GLOSSARY['sigOrSlash'].code]);
        const UTXOs = UTXO.fromLedgerUtxos(address, senderAccount.ledgerUtxos, ruleCodesToExclude);
		if (UTXOs.length === 0) throw new Error('No UTXO to spend');

        this.checkMalformedAnchorsInUtxosArray(UTXOs);
        this.checkDuplicateAnchorsInUtxosArray(UTXOs);

		const dataLength = data ? data.length : 0;
        const { outputs, totalSpent } = Transaction_Builder.buildOutputsFrom(transfers, 'sig');
		
		// SIMPLIFIED FEE ESTIMATION WITHOUT OPTIMIZATION (USE ALL UTXOs, IF EXCEEDS MAX SIZE THEN THROW)
		const result = inMaxAmount ? Transaction_Builder.#countAllSpent(UTXOs, totalSpent, outputs.length, feePerByte, [hybridKey], identities, dataLength)
			: Transaction_Builder.#addUtxoUntilAmount(UTXOs, totalSpent, outputs.length, feePerByte, [hybridKey], identities, dataLength);
		
		const { selectedUtxos, changeOutput, finalFee, weight } = result;
		if (weight > BLOCKCHAIN_SETTINGS.maxTransactionSize) throw new Error(`Estimated transaction weight (${weight} bytes) exceeds maximum allowed (${BLOCKCHAIN_SETTINGS.maxTransactionSize} bytes)`);

		if (changeOutput) outputs.push(changeOutput);
        if (conditionnals.arrayIncludeDuplicates(outputs)) throw new Error('Duplicate outputs');

		const tx = Transaction.fromUTXOs(selectedUtxos, outputs, identities, data);
		return { tx, finalFee, totalConsumed: totalSpent + finalFee, weight };
    }
	/** Create a transaction to stake new VSS - fee should be => amount to be staked
     * @param {Account} senderAccount - the account who is staking the VSS
	 * @param {number} qty The quanity of stakes to create
	 * @param {string[]} [authorizedPubkeys] - the pubkeys of the validators authorized to sign for this stake (default: the senderAccount pubkey)
     * @param {boolean} useOnlyNecessaryUtxos - if true, the transaction will use only the necessary UTXOs to reach the amount */
    static createStakingVss(senderAccount, qty, authorizedPubkeys = [senderAccount.pubKey], useOnlyNecessaryUtxos = true) {
		if (typeof qty !== 'number' || qty <= 0) throw new Error('Invalid quantity to stake');
		if (!Array.isArray(authorizedPubkeys) || authorizedPubkeys.some(pubkey => typeof pubkey !== 'string')) throw new Error('Invalid authorized validator pubkeys');

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
		const utxos = Transaction_Builder.#extractNecessaryUtxosForAmount(availableUTXOs, totalStake + fee);
		const inAmount = utxos.reduce((a, b) => a + b.amount, 0);
		const change = inAmount - totalStake - fee;
		if (change) outputs.push(new TxOutput(change, 'sig', senderAddress));

		// SET THE AUTHORIZED VALIDATOR PUBKEY IN TX DATA
        const tx = Transaction.fromUTXOs(utxos, outputs);
		const pointersSize = BinaryWriter.calculatePointersSize(authorizedPubkeys.length);
		const pubKeys = authorizedPubkeys.map(pk => serializer.converter.hexToBytes(pk));
		const pubkeysSize = pubKeys.reduce((sum, pk) => sum + pk.length, 0);
		const w = new BinaryWriter(pointersSize + pubkeysSize);
		w.writePointersAndDataChunks(pubKeys);
		tx.data = w.getBytes();
		return { tx, finalFee: fee, totalConsumed: totalStake + fee };
    }
	/** @param {UTXO[]} utxos @param {number} amount */
    static #extractNecessaryUtxosForAmount(utxos, amount) {
        const necessaryUtxos = [];
        let remainingAmount = amount;
        for (const utxo of utxos) {
            if (remainingAmount <= 0) break; // stop if we've already covered the amount needed
            necessaryUtxos.push(utxo);
            remainingAmount -= utxo.amount;
        }

        return necessaryUtxos;
    }
	static createUnstakingVss() { throw new Error('Not implemented yet'); }
	static createSlashing() { throw new Error('Not implemented yet'); }
	/** @param {UTXO[]} utxos @param {number} amount @param {number} outputCount @param {number} feePerByte @param {Uint8Array[]} hybridKeys @param {Uint8Array[]} [identities] */
	static #addUtxoUntilAmount(utxos, amount, outputCount, feePerByte, hybridKeys, identities = [], dataSize = 0) {
		let finalFee = Transaction_Builder.#calculateTransactionSize(1, outputCount, hybridKeys, identities, dataSize); // start with 1 input and 1 output to get a baseline fee, then we will add UTXOs until we reach the amount needed with the fee
		let totalIn = 0;
		let weight = 0;
		const selectedUtxos = [];
		for (const utxo of utxos) {
			if (totalIn >= amount + finalFee) break; // stop if we've already reached the amount needed with the fee

			selectedUtxos.push(utxo);
			totalIn += utxo.amount;
			
			const needsChangeOutput = totalIn > amount + finalFee;
			const nbOutputs = outputCount + (needsChangeOutput ? 1 : 0);
			weight = this.#calculateTransactionSize(selectedUtxos.length, nbOutputs, hybridKeys, identities, dataSize);
			finalFee = Math.ceil(weight * feePerByte);
			if (totalIn < amount + finalFee) continue; // keep adding UTXOs until we reach the amount needed
		}

		if (totalIn < amount + finalFee) throw new Error(`Not enough funds: total UTXOs amount ${totalIn} is less than total needed ${amount + finalFee}`);
		const change = totalIn - amount - finalFee;
		const changeOutput = change > BLOCKCHAIN_SETTINGS.unspendableUtxoAmount ? new TxOutput(change, 'sig', utxos[0].address) : undefined;
		return { selectedUtxos, changeOutput, finalFee, weight };
	}
	/** @param {UTXO[]} utxos @param {number} amount @param {number} outputCount @param {number} feePerByte @param {Uint8Array[]} hybridKeys @param {Uint8Array[]} identities */
	static #countAllSpent(utxos, amount, outputCount, feePerByte, hybridKeys, identities, dataSize = 0) {
		const weight = Transaction_Builder.#calculateTransactionSize(utxos.length, outputCount, hybridKeys, identities, dataSize);
		return { selectedUtxos: utxos, changeOutput: undefined, finalFee: weight * feePerByte, weight };
	}
	/** @param {number} inputCount @param {number} outputCount @param {Uint8Array[]} hybridKeys @param {Uint8Array[]} identities */
	static #calculateTransactionSize(inputCount, outputCount, hybridKeys, identities, dataSize = 0) {
		const headerSize = SIZES.txHeader.bytes;
		const inputsSize = inputCount * SIZES.anchor.bytes;
		const outputsSize = outputCount * SIZES.miniUTXO.bytes;

		let witnessesSize = BinaryWriter.calculatePointersSize(hybridKeys.length); // for each witness.
		for (const hybridKey of hybridKeys) {
			const desc = QsafeHelper.parseHeader(hybridKey)?.desc;
			if (!desc) throw new Error('Invalid public key format in hybridKeys');

			witnessesSize += BinaryWriter.calculatePointersSize(2); // for the 2 parts of the witness (sig and pubkeyHash)
			witnessesSize += SIZES.ed25519Signature.bytes + SIZES.pubKeyHash.bytes + desc.sigSize;
		}

		const identitiesPointersSize = identities.length ? BinaryWriter.calculatePointersSize(identities.length) : 0;
		const identitiesSumSize = identities.length ? identities.reduce((sum, identity) => sum + identity.length, 0) : 0;
		const identitiesSize = identitiesPointersSize + identitiesSumSize;

		return headerSize + inputsSize + outputsSize + witnessesSize + identitiesSize + dataSize;
	}
	/** @param {Account} account @param {number} feePerByte @param {Uint8Array[]} identities @param {Uint8Array} [data] */
	static calculateMaxSendableAmount(account, feePerByte = 1, identities, data) {
		const { address, hybridKey, ledgerUtxos } = account;
		if (!hybridKey || ledgerUtxos.length === 0) throw new Error('No UTXO to spend');

		const nbIn = ledgerUtxos.length;
		const txSize = Transaction_Builder.#calculateTransactionSize(nbIn, 1, [hybridKey], identities, data?.length || 0); // estimate weight with 1 input and 1 output
		const estimatedFee = txSize * feePerByte;
		const availableUTXOs = UTXO.fromLedgerUtxos(address, ledgerUtxos);
		const totalAvailable = availableUTXOs.reduce((a, b) => a + b.amount, 0);
		if (totalAvailable <= estimatedFee) throw new Error(`Not enough funds to cover fee: available ${totalAvailable}, estimated fee ${estimatedFee}`);
		return totalAvailable - estimatedFee;
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
    /** @param {Transaction} tx */
    static isSolverOrValidatorTx(tx) {
        if (tx.inputs.length !== 1 || tx.outputs.length !== 1) return;

        if (tx.inputs[0].length === SIZES.nonce.str) 		// SOLVER nonce lenght is 8
			if (tx.witnesses.length === 0) return 'solver'; // and no witness

		if (tx.witnesses.length !== 1) return; 				// VALIDATOR should have exactly 1 witness
        if (tx.inputs[0].length !== SIZES.validatorInput.str) return; // VALIDATOR hash length is 64
		
		return 'validator';
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
    /** Fast method to create & sign a transaction in on call. (Only works with 1 signature, for more complex transactions use createTransaction + account.signTransaction separately)
	 * @param {Account} senderAccount @param {number | 'max'} amount @param {string} recipientAddress @param {number} [feePerByte]  @param {Uint8Array[]} [identities] @param {Uint8Array} [data] */
    static createAndSignTransaction(senderAccount, amount, recipientAddress, feePerByte = 1, identities = [], data) {
		if (amount !== 'max' && (typeof amount !== 'number' || amount <= 0)) throw new Error('Invalid amount');

		try {
			const inMaxAmount = amount === 'max';
			const amountToSend = !inMaxAmount ? amount : Transaction_Builder.calculateMaxSendableAmount(senderAccount, feePerByte, identities, data);
			const transfer = { recipientAddress, amount: amountToSend };
			const { tx, finalFee } = Transaction_Builder.createTransaction(senderAccount, [transfer], feePerByte, identities, data, inMaxAmount);
			senderAccount.signTransaction(tx);
			return { signedTx: tx, finalFee, error: false };
        } catch (/**@type {any}*/ error) { return { signedTx: null, error }; }
    }
	/** @param {Transaction} transaction */
	static getTransactionSignableString(transaction) {
		const i = JSON.stringify(transaction.inputs);
		const o = JSON.stringify(transaction.outputs);
		const d = JSON.stringify((transaction.data || []).join());
		const v = transaction.version.toString();
		return i + o + d + v;
	}
}