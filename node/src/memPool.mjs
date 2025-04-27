import { TxValidation } from './validations-classes.mjs';
import { Transaction_Builder, Transaction } from './transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { UtxoCache } from './utxoCache.mjs';
import { TransactionPriorityQueue } from './memPool-tx-queue.mjs';

/**
 * @typedef {import('./block-classes.mjs').BlockData} BlockData
 * @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack
 * @typedef {import("./transaction.mjs").UTXO} UTXO
 */

export class MemPool { 
    // maxPubKeysToRemember = 1_000_000; // ~45MB -> unused!
    knownPubKeysAddresses = {}; // used to avoid excessive address ownership confirmation
    useDevArgon2 = false;
    /** @type {TransactionPriorityQueue} */
    transactionQueue = new TransactionPriorityQueue();
    /** @type {Object<string, Transaction>} */
    transactionsByID = {};
    /** @type {Object<string, Transaction>} */
    transactionByAnchor = {};
    /** @type {Object<string, WebSocketCallBack>} */
    wsCallbacks = {};

    /** @param {Transaction} transaction @param {Transaction} collidingTx */
    #addMempoolTransaction(transaction, collidingTx = false) {
         // IMPORTANT : AT THIS STAGE WE HAVE ENSURED THAT THE TRANSACTION IS CONFORM
        if (collidingTx) { this.#removeMempoolTransaction(collidingTx); }
        
        // Add transaction to the priority queue
        this.transactionQueue.add(transaction);

        // Sorted by anchor
        for (const input of transaction.inputs) this.transactionByAnchor[input] = transaction;

        // Sorted by transaction ID
        this.transactionsByID[transaction.id] = transaction;

        //console.log(`[MEMPOOL] transaction: ${transaction.id} added`);
    }
    /** @param {Transaction} transaction */
    #removeMempoolTransaction(transaction) {
        // Remove from the priority queue
        this.transactionQueue.remove(transaction.id);

        // Remove from: sorted by anchor
        const colliding = this.#caughtTransactionsAnchorsCollision(transaction);
        for (const input of colliding.tx.inputs) {
            if (!this.transactionByAnchor[input]) throw new Error(`Transaction not found in mempool: ${input}`);
            delete this.transactionByAnchor[input];
        }

        // Remove from: sorted by transaction ID
        delete this.transactionsByID[transaction.id];

        //console.log(`[MEMPOOL] transaction: ${transaction.id} removed`);
    }
    /** @param {Transaction} transaction */
    #caughtTransactionsAnchorsCollision(transaction) {
        for (const input of transaction.inputs)
            if (this.transactionByAnchor[input])
                return { tx: this.transactionByAnchor[input], anchor: input };

        return false;
    }

    /** @param {Object<string, string>} discoveredPubKeysAddresses */
    addNewKnownPubKeysAddresses(discoveredPubKeysAddresses) {
        for (let [pubKeyHex, address] of Object.entries(discoveredPubKeysAddresses))
            this.knownPubKeysAddresses[pubKeyHex] = address;
    }
    /** @param {BlockData[]} blockData */
    removeFinalizedBlocksTransactions(blockData) {
        const Txs = blockData.Txs;
        if (!Array.isArray(Txs)) throw new Error('Txs is not an array');

        // Remove the transactions included in the block that collide with the mempool
        for (const tx of Txs) {
            if (Transaction_Builder.isMinerOrValidatorTx(tx)) continue;

            const colliding = this.#caughtTransactionsAnchorsCollision(tx);
            if (colliding) this.#removeMempoolTransaction(colliding.tx);
        }
    }
    /** @param {UtxoCache} utxoCache @param {Transaction} transaction */
    async pushTransaction(utxoCache, transaction) {
        const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTx(transaction);
        if (!involvedUTXOs) throw new Error('At least one UTXO not found in utxoCache');

        const timings = { start: Date.now(), first: 0, second: 0 };
        const serialized = serializer.serialize.transaction(transaction);
        const byteLength = serialized.byteLength;
        
        try { await TxValidation.controlTransactionHash(transaction); }
        catch (error) { throw new Error(`Transaction hash not valid - ${error.message}`); }
        
        try { TxValidation.isConformTransaction(involvedUTXOs, transaction, false, utxoCache.nodeVersion); } 
        catch (error) { throw new Error(`Transaction not conform - ${error.message}`); }

        const identicalIDTransaction = this.transactionsByID[transaction.id];
        if (identicalIDTransaction) throw new Error(`Transaction already in mempool: ${transaction.id}`);

        const colliding = this.#caughtTransactionsAnchorsCollision(transaction);
        const collidingTx = colliding ? colliding.tx : false;
        if (collidingTx) throw new Error(`Conflicting UTXOs with: ${collidingTx.id} | anchor: ${colliding.anchor}`);

        const fee = TxValidation.calculateRemainingAmount(involvedUTXOs, transaction);

        transaction.byteWeight = byteLength;
        transaction.feePerByte = (fee / transaction.byteWeight).toFixed(6);

        timings.first = Date.now() - timings.start;

        TxValidation.controlTransactionOutputsRulesConditions(transaction);

        const impliedKnownPubkeysAddresses = await TxValidation.controlAllWitnessesSignatures(this, transaction);

        await TxValidation.addressOwnershipConfirmation(involvedUTXOs, transaction, impliedKnownPubkeysAddresses, this.useDevArgon2);
        timings.second = Date.now() - timings.start;

        this.#addMempoolTransaction(transaction, collidingTx);
    }
    /** @param {UtxoCache} utxoCache @param {Transaction[]} transactions */
    async pushTransactions(utxoCache, transactions) {
        /** @type {{ success: Transaction[], failed: string[] }} */
        const results = { success: [], failed: [] };
        for (const transaction of transactions) {
            try {
                await this.pushTransaction(utxoCache, transaction);
                results.success.push(transaction);
            } catch (error) { results.failed.push(error.message) }
            await new Promise(resolve => setImmediate(resolve));
        }

        return results;
    }
    /** @param {UtxoCache} utxoCache */
    getMostLucrativeTransactionsBatch(utxoCache) {
        const totalBytesTrigger = BLOCKCHAIN_SETTINGS.maxBlockSize * 0.98;
        const transactions = [];
        let totalBytes = 0;

        // Use the priority queue to get transactions sorted by feePerByte
        const candidateTransactions = this.transactionQueue.getTransactions();
        for (let tx of candidateTransactions) {
            let txCanBeAdded = true;
            for (const anchor of tx.inputs) {
                const utxo = utxoCache.getUTXO(anchor);
                if (utxo && !utxo.spent) continue;
            
                txCanBeAdded = false;
                this.transactionQueue.remove(tx.id);
                break; 
            }
            if (!txCanBeAdded) continue;

            const txWeight = tx.byteWeight;
            if (totalBytes + txWeight > BLOCKCHAIN_SETTINGS.maxBlockSize) continue;

            // clean up the transaction's details before returning it
            const clone = Transaction_Builder.clone(tx);
            delete clone.feePerByte;
            delete clone.byteWeight;

            transactions.push(clone);
            totalBytes += txWeight;

            if (totalBytes > totalBytesTrigger) break;
        }

        return transactions;
    }
}