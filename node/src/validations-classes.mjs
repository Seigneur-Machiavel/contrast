// Lot of performance optimization has been done in this file,
// The code is not the most readable but it's the fastest possible

import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import { Transaction, TxOutput, UTXO, Transaction_Builder } from './transaction.mjs';
import { UTXO_RULES_GLOSSARY } from '../../utils/utxo-rules.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { typeValidation } from '../../utils/type-validation.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';

/**
 * @typedef {import("./vss.mjs").Vss} Vss
 * @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
 * @typedef {import("./memPool.mjs").MemPool} MemPool
 * @typedef {import("./block-classes.mjs").BlockData} BlockData
 * @typedef {import("../workers/workers-classes.mjs").ValidationWorker} ValidationWorker
 */

/*const validationObs = new PerformanceObserver((items) => { // TODO: disable in production
    items.getEntries().forEach((entry) => { console.log(`${entry.name}: ${entry.duration.toFixed(3)}ms`); });});
validationObs.observe({ entryTypes: ['measure'] });*/

const ValidationMiniLogger = new MiniLogger('validation');

export class TxValidation {
    /** ==> Simple hash control, low computation cost. - control the transaction hash (SHA256) @param {Transaction} transaction */
    static async controlTransactionHash(transaction) {
        const expectedID = Transaction_Builder.hashId(transaction);
        if (expectedID !== transaction.id) { throw new Error(`Invalid transaction hash: ${transaction.id} !== ${expectedID}`); }
    }

    /** ==> First validation, low computation cost. - control format of : amount, address, rule, version, TxID, UTXOs spendable
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} transaction
     * @param {boolean} specialTx - 'miner' || 'validator' or false
     * @param {number} nodeVersion */
    static isConformTransaction(involvedUTXOs, transaction, specialTx, nodeVersion) {
        if (!transaction) { throw new Error(`missing transaction: ${transaction}`); }
        if (typeof transaction.id !== 'string') { throw new Error('Invalid transaction ID !== string'); }
        if (typeof transaction.version !== 'number') { throw new Error('Invalid version !== number'); }
        if (transaction.version <= 0) { throw new Error('Invalid version value: <= 0'); }
        if (transaction.version != nodeVersion) { throw new Error(`Invalid version value: ${transaction.version} !== ${nodeVersion}`); }

        if (!Array.isArray(transaction.inputs)) { throw new Error('Invalid transaction inputs'); }
        if (!Array.isArray(transaction.outputs)) { throw new Error('Invalid transaction outputs'); }
        if (!Array.isArray(transaction.witnesses)) { throw new Error('Invalid transaction witnesses'); }
        if (specialTx && transaction.inputs.length !== 1) { throw new Error(`Invalid coinbase transaction: ${transaction.inputs.length} inputs`); }
        if (specialTx && transaction.outputs.length !== 1) { throw new Error(`Invalid coinbase transaction: ${transaction.outputs.length} outputs`); }
        if (transaction.inputs.length === 0) { throw new Error('Invalid transaction: no inputs'); }
        if (transaction.outputs.length === 0) { throw new Error('Invalid transaction: no outputs'); }

        try {
            for (const witness of transaction.witnesses) { TxValidation.#decomposeWitnessOrThrow(witness); }
        } catch (error) { throw new Error('Invalid signature size'); }
        
        for (let i = 0; i < transaction.outputs.length; i++) {
            const output = transaction.outputs[i];
            TxValidation.isConformOutput(output);

            if (output.rule === "sigOrSlash") {
                if (i !== 0) throw new Error('sig_Or_Slash must be the first output');
                if (output.amount < BLOCKCHAIN_SETTINGS.minStakeAmount) throw new Error(`sig_Or_Slash amount < ${BLOCKCHAIN_SETTINGS.minStakeAmount}`);

                const remainingAmount = this.calculateRemainingAmount(involvedUTXOs, transaction);
                if (remainingAmount < output.amount) throw new Error('Sig_Or_Slash requires fee > amount');
            }
        }

        for (const input of transaction.inputs) {
            if (specialTx && typeof input !== 'string') throw new Error('Invalid coinbase input');
            if (specialTx) { continue; }

            const anchor = input;
            if (!typeValidation.isConformAnchor(anchor)) { throw new Error('Invalid anchor'); }

            const utxo = involvedUTXOs[anchor];
            if (!utxo) { throw new Error(`Invalid transaction: UTXO not found in involvedUTXOs: ${anchor}`); }
            if (utxo.spent) { throw new Error(`Invalid transaction: UTXO already spent: ${anchor}`); }
            if (utxo.rule === 'sigOrSlash') { throw new Error(`Invalid transaction: sigOrSlash UTXO cannot be spend: ${anchor}`); }
        }
    }
    /** @param {TxOutput} txOutput */
    static isConformOutput(txOutput) {
        if (typeof txOutput.amount !== 'number') { throw new Error('Invalid amount !== number'); }
        if (txOutput.amount <= 0) { throw new Error('Invalid amount value: <= 0'); }
        if (txOutput.amount % 1 !== 0) { throw new Error('Invalid amount value: not integer'); }

        if (typeof txOutput.rule !== 'string') { throw new Error('Invalid rule !== string'); }
        if (UTXO_RULES_GLOSSARY[txOutput.rule] === undefined) { throw new Error(`Invalid rule name: ${txOutput.rule}`); }

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
        for (const output of transaction.outputs) {
            if (output.amount < BLOCKCHAIN_SETTINGS.unspendableUtxoAmount) { continue; }
            fee -= output.amount || 0; 
        }

        for (const anchor of transaction.inputs) {
            const utxo = involvedUTXOs[anchor];
            if (!utxo) { throw new Error(`UTXO: ${anchor} not found in involvedUTXOs, already spent?`); }
            fee += utxo.amount;
        }

        if (fee <= 0) { throw new Error('Negative or zero fee transaction'); }
        if (fee % 1 !== 0) { throw new Error('Invalid fee: not integer'); }

        return fee;
    }

    /** ==> Fourth validation, low computation cost. - control the right to create outputs using the rule
     * @param {Transaction} transaction */
    static controlTransactionOutputsRulesConditions(transaction) { //TODO: NOT SURE IF WE CONSERVE THIS
        for (let i = 0; i < transaction.outputs.length; i++) {
            const inRule = transaction.inputs[i] ? transaction.inputs[i].rule : undefined;
            const inAmount = transaction.inputs[i] ? transaction.inputs[i].amount : undefined;
            const inAddress = transaction.inputs[i] ? transaction.inputs[i].address : undefined;

            const outRule = transaction.outputs[i] ? transaction.outputs[i].rule : undefined;
            const outAmount = transaction.outputs[i] ? transaction.outputs[i].amount : undefined;
            const outAddress = transaction.outputs[i] ? transaction.outputs[i].address : undefined;
        }
    } // NOT SURE IF WE CONSERVE THIS

    /** ==> Fifth validation, medium computation cost. - control the signature of the inputs
     * @param {MemPool} memPool @param {Transaction} transaction */
    static async controlAllWitnessesSignatures(memPool, transaction) {
        //const startTime = Date.now();
        if (!Array.isArray(transaction.witnesses)) { throw new Error(`Invalid witnesses: ${transaction.witnesses} !== array`); }
        
        /** @type {Object<string, string>} */
        const impliedKnownPubkeysAddresses = {};
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const { signature, pubKeyHex } = TxValidation.#decomposeWitnessOrThrow(transaction.witnesses[i]);
            await AsymetricFunctions.verifySignature(signature, transaction.id, pubKeyHex); // will throw an error if the signature is invalid
            
            const pubKeyAddress = memPool.knownPubKeysAddresses[pubKeyHex];
            if (pubKeyAddress) { impliedKnownPubkeysAddresses[pubKeyHex] = pubKeyAddress; }
        }

        //console.log(`[VALIDATION] .controlAllWitnessesSignatures() took ${Date.now() - startTime} ms`);
        return impliedKnownPubkeysAddresses;
    }
    /** @param {string} witness */
    static #decomposeWitnessOrThrow(witness) {
        if (typeof witness !== 'string') { throw new Error(`Invalid witness: ${witness} !== string`); }
        const witnessParts = witness.split(':');
        if (witnessParts.length !== 2) { throw new Error('Invalid witness'); }

        const signature = witnessParts[0];
        const pubKeyHex = witnessParts[1];

        if (signature.length !== 128) { throw new Error('Invalid signature size'); }
        if (pubKeyHex.length !== 64) { throw new Error('Invalid pubKey size'); }
        if (!typeValidation.hex(signature)) { throw new Error(`Invalid signature: ${signature} !== hex`); }
        if (!typeValidation.hex(pubKeyHex)) { throw new Error(`Invalid pubKey: ${pubKeyHex} !== hex`); }

        return { signature, pubKeyHex };
    }

    /** ==> Sixth validation, high computation cost.
     * 
     * - control the inputAddresses/witnessesPubKeys correspondence
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {Transaction} transaction
     * @param {Object<string, string>} impliedKnownPubkeysAddresses
     * @param {boolean} useDevArgon2
     * @param {string | false} specialTx - 'miner' || 'validator' or false
     */
    static async addressOwnershipConfirmation(involvedUTXOs, transaction, impliedKnownPubkeysAddresses = {}, useDevArgon2 = false, specialTx) {
        //const startTime = Date.now();
        const transactionWitnessesPubKey = [];
        const transactionWitnessesAddresses = [];
        const discoveredPubKeysAddresses = {};

        // derive witnesses addresses
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const witnessParts = transaction.witnesses[i].split(':');
            const pubKeyHex = witnessParts[1];
            
            if (transactionWitnessesPubKey.includes(pubKeyHex)) { throw new Error('Duplicate witness'); }
            transactionWitnessesPubKey.push(pubKeyHex);

            if (impliedKnownPubkeysAddresses[pubKeyHex]) { // If the address derivation is known, use it and skip the derivation
                transactionWitnessesAddresses.push(impliedKnownPubkeysAddresses[pubKeyHex]);
                continue;
            }
            
            const argon2Fnc = useDevArgon2 ? HashFunctions.devArgon2 : HashFunctions.Argon2;
            const derivedAddressBase58 = await addressUtils.deriveAddress(argon2Fnc, pubKeyHex);
            if (!derivedAddressBase58) { throw new Error('Invalid derived address'); }

            await addressUtils.securityCheck(derivedAddressBase58, pubKeyHex);
            
            transactionWitnessesAddresses.push(derivedAddressBase58);
            discoveredPubKeysAddresses[pubKeyHex] = derivedAddressBase58; // store the derived address for future use
        }

        if (specialTx === 'miner') { return discoveredPubKeysAddresses; }

        // control the input's(UTXOs) addresses presence in the witnesses
        for (let i = 0; i < transaction.inputs.length; i++) {
            let addressToVerify;
            if (specialTx === 'validator') {
                addressToVerify = transaction.inputs[i].split(':')[0];
            } else {
                const anchor = transaction.inputs[i];
                const utxo = involvedUTXOs[anchor];
                if (!utxo) { throw new Error(`UTXO not found in involvedUTXOs: ${anchor}`); }
                addressToVerify = utxo.address;
            }
            
            if (!addressToVerify) { throw new Error('addressToVerify not found'); }

            if (!transactionWitnessesAddresses.includes(addressToVerify)) {
                ValidationMiniLogger.log(`UTXO address: ${addressUtils.formatAddress(addressToVerify)}`, (m) => { console.log(m); });
                throw new Error(`Witness missing for address: ${addressToVerify}, witnesses: ${transactionWitnessesAddresses.join(', ')}`);
            }
        }

        //console.log(`[VALIDATION] .addressOwnershipConfirmation() took ${Date.now() - startTime} ms`);
        return discoveredPubKeysAddresses;
    }
    /** This function is used to optimize the verification while using multi threading */
    static async addressOwnershipConfirmationOnlyIfKownPubKey(involvedUTXOs, transaction, impliedKnownPubkeysAddresses = {}, useDevArgon2 = false, specialTx) {
        //const startTime = Date.now();
        const transactionWitnessesPubKey = [];
        const transactionWitnessesAddresses = [];

        // derive witnesses addresses
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const witnessParts = transaction.witnesses[i].split(':');
            const pubKeyHex = witnessParts[1];
            
            if (transactionWitnessesPubKey.includes(pubKeyHex)) { throw new Error('Duplicate witness'); }
            transactionWitnessesPubKey.push(pubKeyHex);

            if (impliedKnownPubkeysAddresses[pubKeyHex]) { // If the address derivation is known, use it and skip the derivation
                transactionWitnessesAddresses.push(impliedKnownPubkeysAddresses[pubKeyHex]);
                continue;
            }

            return false; // Can't proceed fast confirmation if the pubKey is not known
        }

        if (specialTx === 'miner') { return true; }

        for (let i = 0; i < transaction.inputs.length; i++) {
            let addressToVerify;
            if (specialTx === 'validator') {
                addressToVerify = transaction.inputs[i].split(':')[0];
            } else {
                const anchor = transaction.inputs[i];
                const utxo = involvedUTXOs[anchor];
                if (!utxo) { throw new Error(`UTXO not found in involvedUTXOs: ${anchor}`); }
                addressToVerify = utxo.address;
            }
            
            if (!addressToVerify) { throw new Error('addressToVerify not found'); }

            if (!transactionWitnessesAddresses.includes(addressToVerify)) {
                ValidationMiniLogger.log(`UTXO address: ${addressUtils.formatAddress(addressToVerify)}`, (m) => { console.log(m); });
                throw new Error(`Witness missing for address: ${addressToVerify}, witnesses: ${transactionWitnessesAddresses.join(', ')}`);
            }
        }

        return true
    }
    /** @param {MemPool} memPool @param {Transaction} transaction */
    static extractImpliedKnownPubkeysAddresses(memPool, transaction) {
        const impliedKnownPubkeysAddresses = {};
        for (let i = 0; i < transaction.witnesses.length; i++) {
            const { pubKeyHex } = TxValidation.#decomposeWitnessOrThrow(transaction.witnesses[i]);
            
            const pubKeyAddress = memPool.knownPubKeysAddresses[pubKeyHex];
            if (pubKeyAddress) { impliedKnownPubkeysAddresses[pubKeyHex] = pubKeyAddress; }
        }
        return impliedKnownPubkeysAddresses;
    }
    /** ==> Sequencially call the full set of validations
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {MemPool} memPool
     * @param {Transaction} transaction
     * @param {string | false} specialTx - 'miner' || 'validator' or false
     * @param {string} nodeVersion
     * @param {boolean} useDevArgon2 - use the devArgon2 function instead of the Argon2 function
     */
    static async fullTransactionValidation(involvedUTXOs, memPool, transaction, specialTx, nodeVersion, useDevArgon2 = false) {
        const logPerf = false;

        const result = { fee: 0, success: false, discoveredPubKeysAddresses: {} };
        performance.mark('startConformityValidation');
        TxValidation.isConformTransaction(involvedUTXOs, transaction, specialTx, nodeVersion); // also check spendable UTXOs
        performance.mark('endConformityValidation');

        performance.mark('startControlTransactionHash');
        await TxValidation.controlTransactionHash(transaction);
        performance.mark('endControlTransactionHash');
        // if transaction is already in the memPool, we don't need to validate it again
        const memPoolTx = memPool.transactionsByID[transaction.id];
        if (memPoolTx) {
            let areSame = true;
            for (let i = 0; i < memPoolTx.inputs.length; i++) {
                if (memPoolTx.inputs[i] !== transaction.inputs[i]) { areSame = false; break; }
            }
            if (areSame) { result.success = true; return result };
        }
        
        performance.mark('startControlAllWitnessesSignatures');
        const impliedKnownPubkeysAddresses = await TxValidation.controlAllWitnessesSignatures(memPool, transaction);
        performance.mark('endControlAllWitnessesSignatures');

        if (specialTx === 'miner') { result.success = true; return result; }
        
        if (!specialTx) { result.fee = TxValidation.calculateRemainingAmount(involvedUTXOs, transaction); }
        performance.mark('startAddressOwnershipConfirmation');
        const discoveredPubKeysAddresses = await TxValidation.addressOwnershipConfirmation(involvedUTXOs, transaction, impliedKnownPubkeysAddresses, useDevArgon2, specialTx);
        result.discoveredPubKeysAddresses = discoveredPubKeysAddresses;
        performance.mark('endAddressOwnershipConfirmation');

        if (logPerf) {
            performance.measure('Conformity validation', 'startConformityValidation', 'endConformityValidation');
            performance.measure('Control transaction hash', 'startControlTransactionHash', 'endControlTransactionHash');
            performance.measure('Control all witnesses signatures', 'startControlAllWitnessesSignatures', 'endControlAllWitnessesSignatures');
            performance.measure('Address ownership confirmation', 'startAddressOwnershipConfirmation', 'endAddressOwnershipConfirmation');
            performance.clearMarks();
        }

        result.success = true;
        return result;
    }
    /** ==> Sequencially call the partial set of validations (no address ownership confirmation)
     * @param {Object<string, UTXO>} involvedUTXOs
     * @param {MemPool} memPool
     * @param {Transaction} transaction
     * @param {string | false} specialTx - 'miner' || 'validator' or false
     * @param {string} nodeVersion */
    static async partialTransactionValidation(involvedUTXOs, memPool, transaction, specialTx, nodeVersion) {
        const result = { fee: 0, success: false, impliedKnownPubkeysAddresses: {} };
        TxValidation.isConformTransaction(involvedUTXOs, transaction, specialTx, nodeVersion); // also check spendable UTXOs
        await TxValidation.controlTransactionHash(transaction);

        // if transaction is already in the memPool, we don't need to validate it again
        const memPoolTx = memPool.transactionsByID[transaction.id];
        if (memPoolTx) {
            let areSame = true;
            for (let i = 0; i < memPoolTx.inputs.length; i++) {
                if (memPoolTx.inputs[i] !== transaction.inputs[i]) { areSame = false; break; }
            }
            if (areSame) {
                result.success = true;
                result.impliedKnownPubkeysAddresses = TxValidation.extractImpliedKnownPubkeysAddresses(memPool, transaction);
                return result
            };
        }
        
        const impliedKnownPubkeysAddresses = await TxValidation.controlAllWitnessesSignatures(memPool, transaction);
        result.impliedKnownPubkeysAddresses = impliedKnownPubkeysAddresses;

        if (specialTx === 'miner') { result.success = true; return result; }
        if (!specialTx) { result.fee = TxValidation.calculateRemainingAmount(involvedUTXOs, transaction); }

        result.success = true;
        return result;
    }
}

export class BlockValidation {
    /** @param {BlockData} blockData @param {BlockData} prevBlockData */
    static isTimestampsValid(blockData, prevBlockData) {
        if (blockData.posTimestamp <= prevBlockData.timestamp) { throw new Error(`Invalid PoS timestamp: ${blockData.posTimestamp} <= ${prevBlockData.timestamp}`); }
        if (blockData.timestamp > Date.now()) { throw new Error('Invalid timestamp'); }
    }
    /** @param {number} powReward @param {number} posReward @param {BlockData} blockData */
    static areExpectedRewards(powReward, posReward, blockData) {
        if (blockData.Txs[0].outputs[0].amount !== powReward) { throw new Error(`Invalid PoW reward: ${blockData.Txs[0].outputs[0].amount} - expected: ${powReward}`); }
        if (blockData.Txs[1].outputs[0].amount !== posReward) { throw new Error(`Invalid PoS reward: ${blockData.Txs[0].outputs[0].amount} - expected: ${posReward}`); }
    }

    /** @param {BlockData} block */
    static checkBlockIndexIsNumber(block) {
        if (typeof block.index !== 'number') { throw new Error('Invalid block index'); }
        if (Number.isInteger(block.index) === false) { throw new Error('Invalid block index'); }
    }
    /** @param {BlockData} block @param {number} currentHeight */
    static validateBlockIndex(block, currentHeight = -1) {
        if (block.index > currentHeight + 9) {
            throw new Error(`!ignore! Rejected: #${block.index} > #${currentHeight + 9}(+9)`);
        }

        if (block.index > currentHeight + 1) {
            throw new Error(`!store! !reorg! #${block.index} > #${currentHeight + 1}(last+1)`);
        }

        if (block.index <= currentHeight) {
            throw new Error(`!store! Rejected: #${block.index} <= #${currentHeight}(outdated)`);
        }
    }
    /** @param {BlockData} block @param {string} lastBlockHash */
    static validateBlockPrevHash(block, lastBlockHash) {
        if (typeof block.prevHash !== 'string') throw new Error('!banBlock! Invalid prevHash type!');
        if (typeof lastBlockHash !== 'string') throw new Error('!banBlock! Invalid lastBlockHash type!');

        if (lastBlockHash === block.prevHash) return;
        throw new Error(`!store! !reorg! #${block.index} Rejected -> invalid prevHash: ${block.prevHash.slice(0, 10)} - expected: ${lastBlockHash.slice(0, 10)}`);
    }
    /** @param {BlockData} block @param {BlockData} lastBlock @param {number} currentTime */
    static validateTimestamps(block, lastBlock, currentTime) {
        // verify the POS timestamp
        if (typeof block.posTimestamp !== 'number') throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        if (Number.isInteger(block.posTimestamp) === false) throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        const timeDiffPos = lastBlock === null ? 1 : block.posTimestamp - lastBlock.timestamp;
        if (timeDiffPos <= 0) throw new Error(`Rejected: #${block.index} -> time difference (${timeDiffPos}) must be greater than 0`);

        // verify final timestamp
        if (typeof block.timestamp !== 'number') throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        if (Number.isInteger(block.timestamp) === false) throw new Error('!banBlock! !applyOffense! Invalid block timestamp');
        
        const timeDiffFinal = block.timestamp - currentTime;
        if (timeDiffFinal > 1000) throw new Error(`!applyMinorOffense! Rejected: #${block.index} -> ${timeDiffFinal} > timestamp_diff_tolerance: 1000`);
    }
    /** @param {BlockData} block @param {Vss} vss */
    static async validateLegitimacy(block, vss, isCandidateBlock = false) {
        //await vss.calculateRoundLegitimacies(block.prevHash);
        const txs = block.Txs;
        const validatorTx = isCandidateBlock ? txs[0] : txs[1];
        if (!validatorTx) { throw new Error('Validator transaction not found'); }

        const validatorAddress = validatorTx.inputs[0].split(':')[0];
        if (!validatorAddress) { throw new Error('Validator address not found'); }

        const validatorLegitimacy = await vss.getAddressLegitimacy(validatorAddress, block.prevHash);
        if (validatorLegitimacy === block.legitimacy) { return true; }

        throw new Error(`Invalid #${block.index} legitimacy: ${block.legitimacy} - expected: ${validatorLegitimacy}`);
    }
    /** @param {BlockData} blockData */
    static isFinalizedBlockDoubleSpending(blockData) {
        const utxoSpent = {};
        for (let i = 0; i < blockData.Txs.length; i++) {
            const tx = blockData.Txs[i];
            const specialTx = i < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false;
            if (specialTx) { continue; } // coinbase Tx / validator Tx

            for (const input of tx.inputs) {
                const anchor = input;
                if (utxoSpent[anchor]) { throw new Error('Double spending!'); }
                utxoSpent[anchor] = true;
            }
        }
    }
    /** Apply fullTransactionValidation() to all transactions in a block
     * @param {BlockData} blockData
     * @param {UtxoCache} utxoCache
     * @param {MemPool} memPool
     * @param {ValidationWorker[]} workers
     * @param {boolean} useDevArgon2 */
    static async fullBlockTxsValidation(blockData, utxoCache, memPool, workers, useDevArgon2 = false) {
        const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTxs(blockData.Txs);
        if (!involvedUTXOs) { throw new Error('At least one UTXO not found in utxoCache'); }

        const nbOfWorkers = workers.length;
        const minTxsToUseWorkers = 15;
        /** @type {Object<string, string>} */
        const allDiscoveredPubKeysAddresses = {};

        const singleThreadStart = Date.now();
        if (nbOfWorkers === 0 || blockData.Txs.length <= minTxsToUseWorkers) {
            for (let i = 0; i < blockData.Txs.length; i++) {
                const tx = blockData.Txs[i];
                let specialTx = false;
                if (i < 2) { specialTx = Transaction_Builder.isMinerOrValidatorTx(tx) } // coinbase Tx / validator Tx

                const { fee, success, discoveredPubKeysAddresses } = await TxValidation.fullTransactionValidation(involvedUTXOs, memPool, tx, specialTx, utxoCache.nodeVersion, useDevArgon2);
                if (!success) { throw new Error(`Invalid transaction: ${tx.id} - ${TxValidation}`); }

                for (let [pubKeyHex, address] of Object.entries(discoveredPubKeysAddresses)) {
                    allDiscoveredPubKeysAddresses[pubKeyHex] = address;
                }
            }
            ValidationMiniLogger.log(`Single thread ${blockData.Txs.length} txs validated in ${Date.now() - singleThreadStart} ms`, (m) => { console.log(m); });
            return allDiscoveredPubKeysAddresses;
        }

        // THIS CODE IS NOT EXECUTED IF nbOfWorkers === 0 // IGNORED ATM
        //#region - MULTI THREADING VALIDATION_v2
        const multiThreadStart = Date.now();
        // PARTIAL VALIDATION
        const allImpliedKnownPubkeysAddresses = {};
        for (let i = 0; i < blockData.Txs.length; i++) {
            const tx = blockData.Txs[i];
            let specialTx = false;
            if (i < 2) { specialTx = Transaction_Builder.isMinerOrValidatorTx(tx) } // coinbase Tx / validator Tx

            const { fee, success, impliedKnownPubkeysAddresses } = await TxValidation.partialTransactionValidation(involvedUTXOs, memPool, tx, specialTx, utxoCache.nodeVersion);
            if (!success) { throw new Error(`Invalid transaction: ${tx.id}`); }

            for (let [pubKeyHex, address] of Object.entries(impliedKnownPubkeysAddresses)) {
                allImpliedKnownPubkeysAddresses[pubKeyHex] = address;
            }
        }

        // ADDRESS OWNERSHIP CONFIRMATION WITH WORKERS
        const treatedTxs = {};
        let remainingTxs = blockData.Txs.length;
        let fastTreatedTxs = 0;
        // treat the first 2 transactions in the main thread
        for (let i = 0; i < 2; i++) {
            const tx = blockData.Txs[i];
            let specialTx = false;
            if (i < 2) { specialTx = Transaction_Builder.isMinerOrValidatorTx(tx) } // coinbase Tx / validator Tx

            const { fee, success, discoveredPubKeysAddresses } = await TxValidation.fullTransactionValidation(involvedUTXOs, memPool, tx, specialTx, utxoCache.nodeVersion, useDevArgon2);
            if (!success) { throw new Error(`Invalid transaction: ${tx.id}`); }

            for (let [pubKeyHex, address] of Object.entries(discoveredPubKeysAddresses)) {
                allDiscoveredPubKeysAddresses[pubKeyHex] = address;
            }
            treatedTxs[i] = true;
            remainingTxs--;
        }

        // treat the txs that can be fast validated because we know the pubKey-address correspondence
        for (let i = 2; i < blockData.Txs.length; i++) {
            const tx = blockData.Txs[i];
            const isValid = await TxValidation.addressOwnershipConfirmationOnlyIfKownPubKey(
                involvedUTXOs,
                tx,
                allImpliedKnownPubkeysAddresses,
                useDevArgon2,
                false
            );
            if (isValid === false) { continue; } // can't proceed fast confirmation

            remainingTxs--;
            fastTreatedTxs++;
            treatedTxs[i] = true;
        }

        if (remainingTxs === 0) {
            ValidationMiniLogger.log(`Multi thread ${blockData.Txs.length}(fast: ${fastTreatedTxs}) txs validated in ${Date.now() - multiThreadStart} ms`, (m) => { console.log(m); });
            return allDiscoveredPubKeysAddresses;
        }

        const workersPromises = {};
        const txsByWorkers = {};
        for (const worker of workers) { workersPromises[worker.id] = null; txsByWorkers[worker.id] = []; }

        // SPLIT THE REMAINING TRANSACTIONS BETWEEN WORKERS
        const nbOfTxsPerWorker = Math.floor(remainingTxs / nbOfWorkers);
        let currentWorkerIndex = 0;
        for (let i = 2; i < blockData.Txs.length; i++) {
            if (treatedTxs[i]) { continue; } // already treated

            const tx = blockData.Txs[i];
            txsByWorkers[workers[currentWorkerIndex].id].push(tx);

            const isLastWorker = currentWorkerIndex === nbOfWorkers - 1;
            if (isLastWorker) { continue; } // avoid giving tx to undefined worker

            // check nbOfTxsPerWorker to increment the currentWorkerIndex
            const workerTxsCount = txsByWorkers[workers[currentWorkerIndex].id].length;
            if (workerTxsCount >= nbOfTxsPerWorker) { currentWorkerIndex++; }
        }

        for (const worker of workers) {
            const txs = txsByWorkers[worker.id];
            if (txs.length === 0) { continue; }

            workersPromises[worker.id] = worker.addressOwnershipConfirmation(
                involvedUTXOs,
                txs,
                allImpliedKnownPubkeysAddresses,
                useDevArgon2
            );
        }

        for (const worker of workers) {
            if (workersPromises[worker.id] === null) { continue; } // no task sent

            const resolved = await workersPromises[worker.id];
            if (!resolved.isValid) { throw new Error(resolved.error); }

            for (let [pubKeyHex, address] of Object.entries(resolved.discoveredPubKeysAddresses)) {
                allDiscoveredPubKeysAddresses[pubKeyHex] = address;
            }
        }

        ValidationMiniLogger.log(`Multi thread ${blockData.Txs.length}(fast: ${fastTreatedTxs}) txs validated in ${Date.now() - multiThreadStart} ms`, (m) => { console.log(m); });
        return allDiscoveredPubKeysAddresses;
    }
}