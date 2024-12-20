import { Transaction, UTXO, Transaction_Builder } from './transaction.mjs';
import utils from './utils.mjs';

/**
* @typedef {import("./blockchain.mjs").Blockchain} Blockchain
* @typedef {import("./block-classes.mjs").BlockData} BlockData
* @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack
*/

export class UtxoCache { // Used to store, addresses's UTXOs and balance.
    constructor(nodeId, nodeVersion, blockchain) {
        this.logPerformance = false;
        this.totalSupply = 0;
        this.totalOfBalances = 0;

        /** @type {Object<string, WebSocketCallBack>} */
        this.wsCallbacks = {}; // not used yet

        this.nodeId = nodeId;
        this.nodeVersion = nodeVersion;

        /** @type {Blockchain} */
        this.blockchain = blockchain;
        /** @type {Object<string, Uint8Array>} */
        this.unspentMiniUtxos = {}; // { anchor: miniUtxoSerialized }
        /** @type {Object<string, Uint8Array>} */
        this.addressesAnchors = {}; // { address: anchorArraySerialized }
    }

    // ----- PUBLIC METHODS -----
    /** Remove the consumed UTXOs and add the new UTXOs - Return the new stakes outputs @param {BlockData[]} blocksData */
    async digestFinalizedBlocks(blocksData) {
        try {
            /** @type {UTXO[]} */
            const batchNewStakesOutputs = [];
            /** @type {UTXO[]} */
            const batchNewUtxos = [];
            /** @type {string[]} */
            const batchConsumedUtxoAnchors = [];

            for (const blockData of blocksData) {
                const Txs = blockData.Txs;
                const { newStakesOutputs, newUtxos, consumedUtxoAnchors } = await this.#digestFinalizedBlockTransactions(blockData.index, Txs);

                const supplyFromBlock = blockData.supply;
                const coinBase = blockData.coinBase;
                this.totalSupply = supplyFromBlock + coinBase;

                batchNewStakesOutputs.push(...newStakesOutputs);
                batchNewUtxos.push(...newUtxos);
                batchConsumedUtxoAnchors.push(...consumedUtxoAnchors);
            }

            await this.#digestNewUtxos(batchNewUtxos);
            await this.#digestConsumedUtxos(batchConsumedUtxoAnchors);

            return batchNewStakesOutputs;
        } catch (error) {
            console.error(error);
            throw error;
        }
    }
    /** @param {string} address */
    getAddressAnchorsArray(address) {
        const serializedAnchors = this.addressesAnchors[address];
        if (!serializedAnchors) { return []; }

        const anchors = utils.serializerFast.deserialize.anchorsArray(serializedAnchors);
        return anchors;
    }
    /** @param {string} anchors */
    async getUTXOs(anchors) {
        if (anchors.length === 0) { return {}; }
        /** @type {UTXO[]} */
        const utxosObj = {};
        const missingAnchors = [];
        for (const anchor of anchors) {
            const miniUtxoSerialized = this.unspentMiniUtxos[anchor];
            if (!miniUtxoSerialized) { // is spent or unexistant - treated later
                missingAnchors.push(anchor);
                continue; 
            }
            const { amount, rule, address } = utils.serializerFast.deserialize.miniUTXO(miniUtxoSerialized);
            utxosObj[anchor] = UTXO(anchor, amount, rule, address); // unspent
        }

        // UTXO SPENT OR UNEXISTANT
        const missingUtxosTxPromises = {};
        for (const anchor of missingAnchors) {
            const [height, txId] = anchor.split(':');
            const txRef = `${height}:${txId}`;
            missingUtxosTxPromises[txRef] = this.blockchain.getTransactionByReference(txRef);
        }

        for (const anchor in missingAnchors) {
            const outputIndex = Number(anchor.split(':')[2]);
            const relatedTx = await missingUtxosTxPromises[anchor];
            if (!relatedTx) { utxosObj[anchor] = undefined; continue; } // doesn't exist

            const output = relatedTx.outputs[outputIndex];
            if (!output) { utxosObj[anchor] = undefined; continue; } // doesn't exist

            /** @type {UTXO} */
            utxosObj[anchor] = UTXO(anchor, output.amount, output.rule, output.address, true); // spent
        }

        return utxosObj;
    }
    /** @param {string} anchor @returns {Promise<UTXO | undefined>} */
    async getUTXO(anchor) {
        const miniUtxoSerialized = this.unspentMiniUtxos[anchor];
        if (miniUtxoSerialized) {
            const { amount, rule, address } = utils.serializerFast.deserialize.miniUTXO(miniUtxoSerialized);
            return UTXO(anchor, amount, rule, address); // unspent
        }

        const height = anchor.split(':')[0];
        const txID = anchor.split(':')[1];
        const reference = `${height}:${txID}`;
        const relatedTx = await this.blockchain.getTransactionByReference(reference);
        if (!relatedTx) { return undefined; } // doesn't exist

        const outputIndex = Number(anchor.split(':')[2]);
        const output = relatedTx.outputs[outputIndex];
        if (!output) { return undefined; } // doesn't exist

        /** @type {UTXO} */
        return UTXO(anchor, output.amount, output.rule, output.address, true); // spent
    }
    /** @param {Transaction} transaction */
    async extractInvolvedUTXOsOfTx(transaction) { // BETTER RE USABILITY
        if (transaction instanceof Array) { throw new Error('Transaction is an array: should be a single transaction'); }

        const involvedAnchors = [];
        for (const input of transaction.inputs) { involvedAnchors.push(input); }

        const involvedUTXOs = await this.getUTXOs(involvedAnchors);
        return involvedUTXOs;
    }
    /** @param {Transaction[]} transactions */
    async extractInvolvedUTXOsOfTxs(transactions) { // BETTER RE USABILITY
        if (!Array.isArray(transactions)) { throw new Error('Transactions is not an array'); }

        try {
            const involvedAnchors = [];
            for (let i = 0; i < transactions.length; i++) {
                const transaction = transactions[i];
                const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(transaction) : false;
                if (specialTx) { continue; } // no anchor
    
                for (const input of transaction.inputs) { involvedAnchors.push(input); }
            }
    
            const involvedUTXOs = await this.getUTXOs(involvedAnchors);
            return involvedUTXOs;  
        } catch (error) {
            return false;
        }
    }
    /** Re build the addressesAnchors from the unspentMiniUtxos after loading or snapshot loading */
    buildAddressesAnchorsFromUnspentMiniUtxos() {
        this.addressesAnchors = {};

        const addressesAnchors = {};
        const start = performance.now();
        const anchors = Object.keys(this.unspentMiniUtxos);
        for (const anchor of anchors) {
            const { address } = utils.serializerFast.deserialize.miniUTXO(this.unspentMiniUtxos[anchor]);
            if (!addressesAnchors[address]) { addressesAnchors[address] = {}; }
            addressesAnchors[address][anchor] = true;
        }

        for (const address of Object.keys(addressesAnchors)) {
            this.addressesAnchors[address] = utils.serializerFast.serialize.anchorsObjToArray(addressesAnchors[address]);
        }
    }
    // ----- PRIVATE METHODS -----
    /** @param {string} address */
    #getAddressAnchorsObj(address) {
        const serializedAnchors = this.addressesAnchors[address];
        if (!serializedAnchors) { return []; }

        const anchors = utils.serializerFast.deserialize.anchorsObjFromArray(serializedAnchors);
        return anchors;
    }
    /** Sort the new UTXOs and Stakes Outputs from a transaction
     * @param {number} blockIndex @param {Transaction} transaction */
    async #digestTransactionOutputs(blockIndex, transaction) {
        const newUtxosFromTx = [];
        const newStakesOutputsFromTx = [];
        for (let i = 0; i < transaction.outputs.length; i++) {
            const { address, amount, rule } = transaction.outputs[i];
            const anchor = `${blockIndex}:${transaction.id}:${i}`
            const utxo = UTXO(anchor, amount, rule, address); // unspent
            if (utxo.amount < utils.SETTINGS.unspendableUtxoAmount) { continue; }

            if (rule === "sigOrSlash") {
                const involvedUTXOs = await this.extractInvolvedUTXOsOfTx(transaction);
                if (!involvedUTXOs) { throw new Error('At least one UTXO not found in utxoCache'); }

                newStakesOutputsFromTx.push(utxo); // used to fill VSS stakes (for now we only create new range)
            }

            newUtxosFromTx.push(utxo);
        }

        return { newStakesOutputsFromTx, newUtxosFromTx };
    }
    /** Sort new UTXOs and consumed UTXOs of the block @param {number} blockIndex @param {Transaction[]} Txs */
    async #digestFinalizedBlockTransactions(blockIndex, Txs) {
        if (!Array.isArray(Txs)) { throw new Error('Txs is not an array'); }
        //console.log(`Digesting block ${blockIndex} with ${Txs.length} transactions`);
        const newStakesOutputs = [];
        const consumedUtxoAnchors = [];
        const newUtxos = [];

        for (let i = 0; i < Txs.length; i++) {
            const transaction = Txs[i];
            const { newStakesOutputsFromTx, newUtxosFromTx } = await this.#digestTransactionOutputs(blockIndex, transaction);
            newStakesOutputs.push(...newStakesOutputsFromTx);
            newUtxos.push(...newUtxosFromTx);

            if (Transaction_Builder.isMinerOrValidatorTx(transaction, i)) { continue; }
            consumedUtxoAnchors.push(...transaction.inputs);
        }

        return { newStakesOutputs, newUtxos, consumedUtxoAnchors };
    }
    /** Fill the UTXOs and addressesAnchors with the new UTXOs @param {UTXO[]} newUtxos */
    async #digestNewUtxos(newUtxos) {
        if (this.logPerformance) { performance.mark('digestNewUtxos-setUTXOs start'); }
        const newAnchorsByAddress = {};
        for (const utxo of newUtxos) {
            const serializedMiniUtxo = utils.serializerFast.serialize.miniUTXO(utxo);
            this.unspentMiniUtxos[utxo.anchor] = serializedMiniUtxo;
            this.totalOfBalances += utxo.amount;

            if (!newAnchorsByAddress[utxo.address]) { newAnchorsByAddress[utxo.address] = []; }
            newAnchorsByAddress[utxo.address].push(utxo.anchor);
        }
        
        for (const address of Object.keys(newAnchorsByAddress)) {
            const addressAnchors = this.#getAddressAnchorsObj(address);
            for (const anchor of newAnchorsByAddress[address]) {
                if (addressAnchors[anchor]) { throw new Error('Anchor already exists'); }
                addressAnchors[anchor] = true;
            }
            this.addressesAnchors[address] = utils.serializerFast.serialize.anchorsObjToArray(addressAnchors);
            if (this.wsCallbacks.onBalanceUpdated) { this.wsCallbacks.onBalanceUpdated.execute('balance_updated', address); }
        }

        if (this.logPerformance) { performance.mark('digestNewUtxos-setUTXOs end'); }
        
        if (!this.logPerformance) { return; }
        
        /*console.log(`#${this.blockchain.currentHeight} - New UTXOs: ${newUtxos.length}`);
        performance.measure('digestNewUtxos-setUTXOs', 'digestNewUtxos-setUTXOs start', 'digestNewUtxos-setUTXOs end');*/
    }
    /** Remove the UTXOs from utxoCache @param {string[]} consumedAnchors */
    async #digestConsumedUtxos(consumedAnchors) {
        const consumedUtxosByAddress = {};
        for (const anchor of consumedAnchors) {
            const utxo = await this.getUTXO(anchor); // fast access: cached miniUTXOs
            if (!utxo) { throw new Error('UTXO not found'); }
            if (utxo.spent) { throw new Error('UTXO already spent'); }
            
            delete this.unspentMiniUtxos[anchor];
            this.totalOfBalances -= utxo.amount;

            if (!consumedUtxosByAddress[utxo.address]) { consumedUtxosByAddress[utxo.address] = []; }
            consumedUtxosByAddress[utxo.address].push(utxo.anchor);
        }

        for (const address of Object.keys(consumedUtxosByAddress)) {
            const addressAnchors = this.#getAddressAnchorsObj(address);
            for (const anchor of consumedUtxosByAddress[address]) {
                if (!addressAnchors[anchor]) { throw new Error('Anchor not found'); }
                delete addressAnchors[anchor];
            }

            if (Object.keys(addressAnchors).length === 0) { delete this.addressesAnchors[address]; continue; }
            this.addressesAnchors[address] = utils.serializerFast.serialize.anchorsObjToArray(addressAnchors);
            if (this.wsCallbacks.onBalanceUpdated) { this.wsCallbacks.onBalanceUpdated.execute('balance_updated', address); }
        }
    }
}