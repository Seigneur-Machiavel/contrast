// @ts-check
import { Transaction_Builder } from './transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { UTXO } from '../../types/transaction.mjs';

/**
* @typedef {import("./blockchain.mjs").Blockchain} Blockchain
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* @typedef {import("../../types/transaction.mjs").TxAnchor} TxAnchor
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
* @typedef {import("../../types/transaction.mjs").TxReference} TxReference
* @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack */

export class UtxoCache { // Used to store, addresses's UTXOs and balance.
	blockchain;
	/** @type {Object<string, number>} Used only in front context - { address: balance } */
	balances = {};
	totalSupply = 0;
	totalOfBalances = 0;
	biggestsHoldersToConserve = 10;

	/** @param {Blockchain} blockchain */
    constructor(blockchain) {
        /** @type {Array<{ address: string, balance: number }>} */
        this.biggestsHoldersBalances = [];
        /** @type {Object<string, WebSocketCallBack>} */
        this.wsCallbacks = {}; // not used yet
        /** @type {Object<string, Uint8Array>} - { anchor: miniUtxoSerialized } */
        this.unspentMiniUtxos = {};
        /** @type {Object<string, Uint8Array>} - { address: anchorArraySerialized } */
        this.addressesAnchors = {};
        this.blockchain = blockchain;
    }

    // ----- PUBLIC METHODS -----
    /** Sort new UTXOs and consumed UTXOs of the block @param {BlockFinalized} block */
    preDigestFinalizedBlock(block) {
        if (!Array.isArray(block.Txs)) throw new Error('Txs is not an array');

        //console.log(`Digesting block ${blockIndex} with ${Txs.length} transactions`);
		/** @type {UTXO[]} */ 		const newStakesOutputs = [];
		/** @type {UTXO[]} */ 		const newUtxos = [];
		/** @type {TxAnchor[]} */ 	const consumedUtxoAnchors = [];
        for (let i = 0; i < block.Txs.length; i++) {
            const transaction = block.Txs[i];
			const txReference = `${block.index}:${i}`;
            const { newStakesOutputsFromTx, newUtxosFromTx } = this.#digestTransactionOutputs(txReference, transaction);
            newStakesOutputs.push(...newStakesOutputsFromTx);
            newUtxos.push(...newUtxosFromTx);

            if (Transaction_Builder.isMinerOrValidatorTx(transaction)) continue;
            consumedUtxoAnchors.push(...transaction.inputs);
        }

        return { newStakesOutputs, newUtxos, consumedUtxoAnchors };
    }
    /** Add the new UTXOs and Remove the consumed UTXOs @param {BlockFinalized} block @param {UTXO[]} newUtxos @param {TxAnchor[]} consumedUtxoAnchors */
    digestFinalizedBlock(block, newUtxos, consumedUtxoAnchors) {
        this.totalSupply = block.supply + block.coinBase;
        this.#digestNewUtxos(newUtxos);
        this.#digestConsumedUtxos(consumedUtxoAnchors);
    }
    /** @param {string} address */
    getAddressAnchorsArray(address) {
        const serializedAnchors = this.addressesAnchors[address];
        if (!serializedAnchors) { return []; }

        const anchors = serializer.deserialize.anchorsArray(serializedAnchors);
        return anchors;
    }
    /** @param {string[]} anchors */
    getUTXOs(anchors) {
        if (anchors.length === 0) return {};

        /** @type {Object<string, UTXO>} */
        const utxosObj = {};
        const missingAnchors = [];
        for (const anchor of anchors) {
            const miniUtxoSerialized = this.unspentMiniUtxos[anchor];
            if (!miniUtxoSerialized) { missingAnchors.push(anchor); continue; } // is spent or unexistant - treated later

            const { amount, rule, address } = serializer.deserialize.miniUTXO(miniUtxoSerialized);
            utxosObj[anchor] = new UTXO(anchor, amount, rule, address); // unspent
        }

        // UTXO SPENT OR UNEXISTANT
        for (const anchor in missingAnchors) {
			const { height, txIndex, vout } = serializer.parseAnchor(anchor);
            const txRef = `${height}:${txIndex}`;
            const relatedTx = this.blockchain.getTransactionByReference(txRef);
            const output = relatedTx?.tx.outputs[vout];
			if (!relatedTx || !output) continue;
            utxosObj[anchor] = new UTXO(anchor, output.amount, output.rule, output.address, true); // spent
        }

        return utxosObj;
    }
    /** @param {TxAnchor} anchor */
    getUTXO(anchor) {
        const miniUtxoSerialized = this.unspentMiniUtxos[anchor];
        if (miniUtxoSerialized) {
            const { amount, rule, address } = serializer.deserialize.miniUTXO(miniUtxoSerialized);
            return new UTXO(anchor, amount, rule, address); // unspent
        }

		const { height, txIndex, vout } = serializer.parseAnchor(anchor);
        const reference = `${height}:${txIndex}`;
        const relatedTx = this.blockchain.getTransactionByReference(reference);
        if (!relatedTx) return; // doesn't exist

        const output = relatedTx.tx.outputs[vout];
        if (output) return new UTXO(anchor, output.amount, output.rule, output.address, true); // spent
    }
    /** @param {Transaction} transaction */
    extractInvolvedUTXOsOfTx(transaction) { // BETTER RE USABILITY
        if (transaction instanceof Array) throw new Error('Transaction is an array: should be a single transaction');

        const involvedAnchors = [];
        for (const input of transaction.inputs) involvedAnchors.push(input);
        return this.getUTXOs(involvedAnchors);
    }
    /** @param {Transaction[]} transactions */
    extractInvolvedUTXOsOfTxs(transactions) { // BETTER RE USABILITY
        if (!Array.isArray(transactions)) throw new Error('Transactions is not an array');

        try {
            let repeatedAnchorsCount = 0;
			/** @type {Object<string, boolean>} */
            const control = {};
            const involvedAnchors = [];
            for (let i = 0; i < transactions.length; i++) {
                const transaction = transactions[i];
                const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(transaction) : false;
                if (specialTx) continue; // no anchor
                
                for (const input of transaction.inputs) {
                    if (control[input]) { repeatedAnchorsCount++; continue; }
                    control[input] = true;
                    involvedAnchors.push(input);
                }
            }
            
            if (repeatedAnchorsCount > 0) console.warn(`Repeated anchors: ${repeatedAnchorsCount}`);
            return this.getUTXOs(involvedAnchors);
        } catch (error) { return false; }
    }
    /** Re build the addressesAnchors from the unspentMiniUtxos after loading or snapshot loading */
    buildAddressesAnchorsFromUnspentMiniUtxos(updateBiggestsHolders = true) {
        this.addressesAnchors = {};
        this.balances = {};

		/** @type {Object<string, Object<string, boolean>>} */
        const addressesAnchors = {};
        const start = performance.now();
        const anchors = Object.keys(this.unspentMiniUtxos);
        for (const anchor of anchors) {
            const { address, amount } = serializer.deserialize.miniUTXO(this.unspentMiniUtxos[anchor]);
            if (!addressesAnchors[address]) addressesAnchors[address] = {};
            addressesAnchors[address][anchor] = true;
            this.balances[address] = (this.balances[address] || 0) + amount;
        }

        for (const address of Object.keys(addressesAnchors))
            this.addressesAnchors[address] = serializer.serialize.anchorsObjToArray(addressesAnchors[address]);

        if (updateBiggestsHolders) this.#updateBiggestsHolders();
    }
    // ----- PRIVATE METHODS -----
    #updateBiggestsHolders() {
        this.biggestsHoldersBalances = [];
        for (let i = 0; i < this.biggestsHoldersToConserve; i++)
            this.biggestsHoldersBalances.push({ address: '', balance: 0 });

        for (const address in this.balances) {
            const balance = this.balances[address];
            const lowestBiggestsHolder = this.biggestsHoldersBalances[this.biggestsHoldersToConserve - 1].balance;
            if (balance <= lowestBiggestsHolder) continue; // not a biggest holder

            for (let i = 0; i < this.biggestsHoldersToConserve; i++) {
                if (balance <= this.biggestsHoldersBalances[i].balance) continue;
                const partA = this.biggestsHoldersBalances.slice(0, i);
                const partB = this.biggestsHoldersBalances.slice(i);
                this.biggestsHoldersBalances = [...partA, { address, balance }, ...partB];
                this.biggestsHoldersBalances.pop();
                break;
            }
        }
    }
    /** @param {string} address */
    #getAddressAnchorsObj(address) {
        const serializedAnchors = this.addressesAnchors[address];
        const anchors = serializer.deserialize.anchorsObjFromArray(serializedAnchors);
        return anchors;
    }
    /** Sort the new UTXOs and Stakes Outputs from a transaction @param {TxReference} txReference @param {Transaction} transaction */
    #digestTransactionOutputs(txReference, transaction) {
        const newUtxosFromTx = [];
        const newStakesOutputsFromTx = [];
        for (let i = 0; i < transaction.outputs.length; i++) {
            const { address, amount, rule } = transaction.outputs[i];
            const anchor = `${txReference}:${i}`
            const utxo = new UTXO(anchor, amount, rule, address); // unspent
            if (utxo.amount < BLOCKCHAIN_SETTINGS.unspendableUtxoAmount) continue; // dust
            if (rule === "sigOrSlash") newStakesOutputsFromTx.push(utxo); // used to fill VSS stakes (for now we only create new range)
            newUtxosFromTx.push(utxo);
        }

        return { newStakesOutputsFromTx, newUtxosFromTx };
    }
    /** Fill the UTXOs and addressesAnchors with the new UTXOs @param {UTXO[]} newUtxos */
    #digestNewUtxos(newUtxos) {
		/** @type {Object<string, string[]>} */
        const newAnchorsByAddress = {};
        for (const utxo of newUtxos) {
            const serializedMiniUtxo = serializer.serialize.miniUTXO(utxo);
            this.unspentMiniUtxos[utxo.anchor] = serializedMiniUtxo;
            this.totalOfBalances += utxo.amount;
            this.balances[utxo.address] = (this.balances[utxo.address] || 0) + utxo.amount;

            if (!newAnchorsByAddress[utxo.address]) { newAnchorsByAddress[utxo.address] = []; }
            newAnchorsByAddress[utxo.address].push(utxo.anchor);
        }
        
		for (const address in newAnchorsByAddress) {
            const addressAnchors = this.#getAddressAnchorsObj(address);
            for (const anchor of newAnchorsByAddress[address]) {
                if (addressAnchors[anchor]) throw new Error('Anchor already exists');
                addressAnchors[anchor] = true;
            }
            this.addressesAnchors[address] = serializer.serialize.anchorsObjToArray(addressAnchors);
            if (this.wsCallbacks.onBalanceUpdated) { this.wsCallbacks.onBalanceUpdated.execute('balance_updated', address); }
        }
    }
    /** Remove the UTXOs from utxoCache @param {TxAnchor[]} consumedAnchors */
    #digestConsumedUtxos(consumedAnchors) {
		/** @type {Object<string, TxAnchor[]>} */
        const consumedUtxosByAddress = {};
        for (const anchor of consumedAnchors) {
            const utxo = this.getUTXO(anchor); // fast access: cached miniUTXOs
            if (!utxo) throw new Error('UTXO not found');
            if (utxo.spent) throw new Error('UTXO already spent');
            
            delete this.unspentMiniUtxos[anchor];
            this.totalOfBalances -= utxo.amount;
            this.balances[utxo.address] = (this.balances[utxo.address] || 0) - utxo.amount;

            if (!consumedUtxosByAddress[utxo.address]) consumedUtxosByAddress[utxo.address] = [];
            consumedUtxosByAddress[utxo.address].push(utxo.anchor);
        }

		for (const address in consumedUtxosByAddress) {
            const addressAnchors = this.#getAddressAnchorsObj(address);
            for (const anchor of consumedUtxosByAddress[address]) {
                if (!addressAnchors[anchor]) { throw new Error('Anchor not found'); }
                delete addressAnchors[anchor];
            }

            if (Object.keys(addressAnchors).length === 0) { delete this.addressesAnchors[address]; continue; }
            this.addressesAnchors[address] = serializer.serialize.anchorsObjToArray(addressAnchors);
            if (this.wsCallbacks.onBalanceUpdated) this.wsCallbacks.onBalanceUpdated.execute('balance_updated', address);
        }
    }
}