if (false) {
    const MessagePack = require('../libs/msgpack.min.js').default;
}

import { FastConverter } from './converters.mjs';
import { UTXO_RULES_GLOSSARY, UTXO_RULESNAME_FROM_CODE } from './utxo-rules.mjs';
import { Transaction } from '../node/src/transaction.mjs';

/**
* @typedef {import("../node/src/block-classes.mjs").BlockData} BlockData
* @typedef {import("../node/src/utxoCache.mjs").UtxoCache} UtxoCache
*
* @typedef { Object } NodeSetting
* @property { string } privateKey
* @property { string } validatorRewardAddress
* @property { string } minerAddress
* @property { number } minerThreads
* 
* @typedef {Object} CheckpointInfo
* @property {number} height
* @property {string} hash
* 
* @typedef {Object} SyncStatus
* @property {number} currentHeight
* @property {string} latestBlockHash
* @property {CheckpointInfo} checkpointInfo
*/

const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
async function msgPackLib() {
    if (isNode) {
        const m = await import('../libs/msgpack.min.js');
        return m.default;
    }
    //return MessagePack;
    return window.msgpack;
};
const msgpack = await msgPackLib();
const fastConverter = new FastConverter();

/** Theses functions are used to serialize and deserialize the data of the blockchain.
 * 
 * - functions do not check the input data.
 * - Make sure to validate the data before using these functions.
 */
export const serializer = {
    syncResponseMinLen: 76,
    txPointerByte: 8, // ID:Offset => 4 bytes + 4 bytes
    serialize: {
        rawData(rawData) {
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(rawData);//, { maxStrLength: }
            return encoded;
        },
        /** @param {string} anchor */
        anchor(anchor) {
            const splitted = anchor.split(':');
            const blockHeight = fastConverter.numberTo4BytesUint8Array(splitted[0]);
            const hash = fastConverter.hexToUint8Array(splitted[1]);
            const inputIndex = fastConverter.numberTo2BytesUint8Array(splitted[2]);

            const anchorBuffer = new ArrayBuffer(10);
            const bufferView = new Uint8Array(anchorBuffer);
            bufferView.set(blockHeight, 0);
            bufferView.set(hash, 4);
            bufferView.set(inputIndex, 8);
            return bufferView;
        },
        /** @param {string[]} anchors */
        anchorsArray(anchors) {
            const anchorsBuffer = new ArrayBuffer(10 * anchors.length);
            const bufferView = new Uint8Array(anchorsBuffer);
            for (let j = 0; j < anchors.length; j++) { // -> anchor ex: "3:f996a9d1:0"
                const splitted = anchors[j].split(':');
                const blockHeight = fastConverter.numberTo4BytesUint8Array(splitted[0]);
                const hash = fastConverter.hexToUint8Array(splitted[1]);
                const inputIndex = fastConverter.numberTo2BytesUint8Array(splitted[2]);

                bufferView.set(blockHeight, j * 10);
                bufferView.set(hash, j * 10 + 4);
                bufferView.set(inputIndex, j * 10 + 8);
            };
            return bufferView;
        },
        anchorsObjToArray(anchors) {
            return this.anchorsArray(Object.keys(anchors));
        },
        /** serialize the UTXO as a miniUTXO: address, amount, rule (23 bytes) @param {UTXO} utxo */
        miniUTXO(utxo) {
            const utxoBuffer = new ArrayBuffer(23);
            const bufferView = new Uint8Array(utxoBuffer); // 23 bytes (6 + 1 + 16)
            bufferView.set(fastConverter.numberTo6BytesUint8Array(utxo.amount), 0);
            bufferView.set(fastConverter.numberTo1ByteUint8Array(UTXO_RULES_GLOSSARY[utxo.rule].code), 6);
            bufferView.set(fastConverter.addressBase58ToUint8Array(utxo.address), 7);
            return bufferView;
        },
        /** @param {UTXO[]} outputs */
        miniUTXOsArray(outputs) {
            const outputsBuffer = new ArrayBuffer(23 * outputs.length);
            const outputsBufferView = new Uint8Array(outputsBuffer);
            for (let i = 0; i < outputs.length; i++) {
                const { address, amount, rule } = outputs[i];
                const ruleCode = UTXO_RULES_GLOSSARY[rule].code;
                outputsBufferView.set(fastConverter.numberTo6BytesUint8Array(amount), i * 23);
                outputsBufferView.set(fastConverter.numberTo1ByteUint8Array(ruleCode), i * 23 + 6);
                outputsBufferView.set(fastConverter.addressBase58ToUint8Array(address), i * 23 + 7);
            }
            return outputsBufferView;
        },
        /** @param {Object <string, UTXO>} utxos */
        miniUTXOsObj(utxos) {
            const totalBytes = (10 + 23) * Object.keys(utxos).length;
            const utxosBuffer = new ArrayBuffer(totalBytes);
            const bufferView = new Uint8Array(utxosBuffer);
            // loop over entries
            let i = 0;
            for (const [key, value] of Object.entries(utxos)) {
                // key: anchor string (10 bytes)
                // value: miniUTXO serialized (23 bytes uint8Array)
                const anchorSerialized = this.anchor(key);
                const miniUTXOSerialized = value;
                bufferView.set(anchorSerialized, i * 33);
                bufferView.set(miniUTXOSerialized, i * 33 + 10);

                i++;
            }
            return bufferView;
        },
        /** @param {string[]} txsRef */
        txsReferencesArray(txsRef) {
            const anchorsBuffer = new ArrayBuffer(8 * txsRef.length);
            const bufferView = new Uint8Array(anchorsBuffer);
            for (let j = 0; j < txsRef.length; j++) { // -> anchor ex: "3:f996a9d1:0"
                const splitted = txsRef[j].split(':');
                const blockHeight = fastConverter.numberTo4BytesUint8Array(splitted[0]);
                const hash = fastConverter.hexToUint8Array(splitted[1]);

                bufferView.set(blockHeight, j * 8);
                bufferView.set(hash, j * 8 + 4);
            };
            return bufferView;
        },
        /** @param {Object <string, string>} pubkeyAddresses */
        pubkeyAddressesObj(pubkeyAddresses) {
            // { pubKeyHex(32bytes): addressBase58(16bytes) }

            const pubKeys = Object.keys(pubkeyAddresses);
            const nbOfBytesToAllocate = pubKeys.length * (32 + 16);
            const resultBuffer = new ArrayBuffer(nbOfBytesToAllocate);
            const uint8Result = new Uint8Array(resultBuffer);
            for (let i = 0; i < pubKeys.length; i++) {
                uint8Result.set(fastConverter.hexToUint8Array(pubKeys[i]), i * 48);
                uint8Result.set(fastConverter.addressBase58ToUint8Array(pubkeyAddresses[pubKeys[i]]), i * 48 + 32);
            }
            return uint8Result;
        },
        /** @param {string[]} witnesses */
        witnessesArray(witnesses) {
            const witnessesBuffer = new ArrayBuffer(96 * witnesses.length); // (sig + pubKey) * nb of witnesses
            const witnessesBufferView = new Uint8Array(witnessesBuffer);
            for (let i = 0; i < witnesses.length; i++)
                witnessesBufferView.set(fastConverter.hexToUint8Array(witnesses[i].replace(':', '')), i * 96);
            return witnessesBufferView;
        },
        /** @param {Transaction} tx */
        specialTransaction(tx) {
            try {
                const isCoinbase = tx.witnesses.length === 0;
                const isValidator = tx.witnesses.length === 1;
                if (!isCoinbase && !isValidator) throw new Error('Invalid special transaction');
                
                if (isCoinbase && (tx.inputs.length !== 1 || tx.inputs[0].length !== 8)) throw new Error('Invalid coinbase transaction');
                if (isValidator && (tx.inputs.length !== 1 || tx.inputs[0].length !== 85)) throw new Error('Invalid transaction');
    
                const elementsLength = {
                    witnesses: tx.witnesses.length, // nb of witnesses: 0 = coinbase, 1 = validator
                    witnessesBytes: tx.witnesses.length * 96, // (sig + pubKey) * nb of witnesses -> 96 bytes * nb of witnesses
                    inputsBytes: isCoinbase ? 4 : 85, // nonce(4B) or address(16B) + posHashHex(32B)
                    outputs: tx.outputs.length, // nb of outputs
                    outputsBytes: 23, // (amount + rule + address) -> 23 bytes
                    dataBytes: tx.data ? tx.data.byteLength : 0 // data: bytes
                }
    
                const serializedTx = new ArrayBuffer(6 + 4 + elementsLength.witnessesBytes + 2 + elementsLength.inputsBytes + elementsLength.outputsBytes + elementsLength.dataBytes);
                const serializedTxView = new Uint8Array(serializedTx);

                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.witnesses), 0); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.outputs), 2); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.dataBytes), 6); // 2 bytes

                let cursor = 6;
                serializedTxView.set(fastConverter.hexToUint8Array(tx.id), cursor);
                cursor += 4; // id: hex 4 bytes

                if (isValidator) { // WITNESSES
                    serializedTxView.set(this.witnessesArray(tx.witnesses), cursor);
                    cursor += elementsLength.witnessesBytes; // witnesses: 96 bytes
                }

                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(tx.version), cursor);
                cursor += 2; // version: number 2 bytes

                if (isCoinbase) { // INPUTS
                    serializedTxView.set(fastConverter.hexToUint8Array(tx.inputs[0]), cursor);
                    cursor += 4; // nonce: 4 bytes
                } else if (isValidator) {
                    const [address, posHash] = tx.inputs[0].split(':');
                    serializedTxView.set(fastConverter.addressBase58ToUint8Array(address), cursor);
                    cursor += 16; // address base58: 16 bytes

                    serializedTxView.set(fastConverter.hexToUint8Array(posHash), cursor);
                    cursor += 32; // posHash: 32 bytes
                }

                const serializedOutputs = this.miniUTXOsArray(tx.outputs);
                serializedTxView.set(serializedOutputs, cursor);
                cursor += elementsLength.outputsBytes;

                if (elementsLength.dataBytes === 0) return serializedTxView;

                throw new Error('Data serialization not implemented yet');

                serializedTxView.set(tx.data, cursor); // max 65535 bytes
                return serializedTxView;
            } catch (error) {
                console.error('Error while serializing the special transaction:', error);
                throw new Error('Failed to serialize the special transaction');
            }
        },
        /** @param {Transaction} tx */
        transaction(tx) {
            try {
                const elementsLength = {
                    witnesses: tx.witnesses.length, // nb of witnesses
                    witnessesBytes: tx.witnesses.length * 96, // (sig + pubKey) * nb of witnesses -> 96 bytes * nb of witnesses
                    inputs: tx.inputs.length, // nb of inputs
                    inputsBytes: tx.inputs.length * 10, // (blockHeight + hash + inputIndex) * nb of inputs -> 10 bytes * nb of inputs
                    outputs: tx.outputs.length, // nb of outputs
                    outputsBytes: tx.outputs.length * 23, // (amount + rule + address) * nb of outputs -> 23 bytes * nb of outputs
                    dataBytes: tx.data ? tx.data.byteLength : 0 // data: bytes
                }

                const serializedTx = new ArrayBuffer(8 + 4 + elementsLength.witnessesBytes + 2 + elementsLength.inputsBytes + elementsLength.outputsBytes + elementsLength.dataBytes);
                const serializedTxView = new Uint8Array(serializedTx);

                // DESCRIPTION (8 bytes)
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.witnesses), 0); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.inputs), 2); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.outputs), 4); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLength.dataBytes), 6); // 2 bytes
                
                let cursor = 8;
                serializedTxView.set(fastConverter.hexToUint8Array(tx.id), cursor);
                cursor += 4; // id: hex 4 bytes

                serializedTxView.set(this.witnessesArray(tx.witnesses), cursor);
                cursor += elementsLength.witnessesBytes;

                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(tx.version), cursor);
                cursor += 2; // version: number 2 bytes

                serializedTxView.set(this.anchorsArray(tx.inputs), cursor);
                cursor += elementsLength.inputsBytes;

                const serializedOutputs = this.miniUTXOsArray(tx.outputs);
                serializedTxView.set(serializedOutputs, cursor);
                cursor += elementsLength.outputsBytes;

                if (elementsLength.dataBytes === 0) return serializedTxView;

                throw new Error('Data serialization not implemented yet');
            } catch (error) {
                console.error('Error while serializing the transaction:', error);
                throw new Error('Failed to serialize the transaction');
            }
        },
        /** @param {BlockData} blockData */
        block_finalized(blockData) {
            const elementsLength = {
                nbOfTxs: 2, // 2bytes to store: blockData.Txs.length
                indexBytes: 4,
                supplyBytes: 8,
                coinBaseBytes: 4,
                difficultyBytes: 4,
                legitimacyBytes: 2,
                prevHashBytes: 32,
                posTimestampBytes: 6,
                timestampBytes: 6,
                hashBytes: 32,
                nonceBytes: 4,

                txsPointersBytes: blockData.Txs.length * serializer.txPointerByte,
                txsBytes: 0
            }

            /** @type {Uint8Array<ArrayBuffer>[]} */
            const serializedTxs = [];
            for (let i = 0; i < blockData.Txs.length; i++) {
                const serializedTx = i < 2
                    ? this.specialTransaction(blockData.Txs[i])
                    : this.transaction(blockData.Txs[i])

                serializedTxs.push(serializedTx);
                elementsLength.txsBytes += serializedTx.length;
            }
            
            const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 6 + 6 + 32 + 4; // usefull for reading
            const serializedBlock = new ArrayBuffer(2 + totalHeaderBytes + elementsLength.txsPointersBytes + elementsLength.txsBytes);
            const serializedBlockView = new Uint8Array(serializedBlock);

            // HEADER
            let cursor = 0;
            serializedBlockView.set(fastConverter.numberTo2BytesUint8Array(blockData.Txs.length), cursor);
            cursor += 2; // nb of txs: 2 bytes

            serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.index), cursor);
            cursor += 4; // index: 4 bytes

            serializedBlockView.set(fastConverter.numberTo8BytesUint8Array(blockData.supply), cursor);
            cursor += 8; // supply: 8 bytes

            serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.coinBase), cursor);
            cursor += 4; // coinBase: 4 bytes

            serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.difficulty), cursor);
            cursor += 4; // difficulty: 4 bytes

            serializedBlockView.set(fastConverter.numberTo2BytesUint8Array(blockData.legitimacy), cursor);
            cursor += 2; // legitimacy: 2 bytes

            serializedBlockView.set(fastConverter.hexToUint8Array(blockData.prevHash), cursor);
            cursor += 32; // prevHash: 32 bytes

            serializedBlockView.set(fastConverter.numberTo6BytesUint8Array(blockData.posTimestamp), cursor);
            cursor += 6; // posTimestamp: 6 bytes

            serializedBlockView.set(fastConverter.numberTo8BytesUint8Array(blockData.timestamp), cursor);
            cursor += 6; // timestamp: 6 bytes

            serializedBlockView.set(fastConverter.hexToUint8Array(blockData.hash), cursor);
            cursor += 32; // hash: 32 bytes

            serializedBlockView.set(fastConverter.hexToUint8Array(blockData.nonce), cursor);
            cursor += 4; // nonce: 4 bytes
            
            // POINTERS & TXS -> This specific traitment offer a better reading performance:
            // ----- no need to deserialize the whole block to read the txs -----
            let offset = 2 + totalHeaderBytes + elementsLength.txsPointersBytes; // where the txs start
            for (let i = 0; i < serializedTxs.length; i++) {
                serializedBlockView.set(fastConverter.hexToUint8Array(blockData.Txs[i].id), cursor);
                cursor += 4; // tx id: 4 bytes

                serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(offset), cursor);
                cursor += 4; // tx offset: 4 bytes
                
                const serializedTx = serializedTxs[i];
                serializedBlockView.set(serializedTx, offset);
                offset += serializedTx.length;
            }

            return serializedBlockView;
        },
        /** @param {BlockData} blockData */
        block_candidate(blockData) {
            const elementsLength = {
                nbOfTxs: 2, // 2bytes to store: blockData.Txs.length
                indexBytes: 4,
                supplyBytes: 8,
                coinBaseBytes: 4,
                difficultyBytes: 4,
                legitimacyBytes: 2,
                prevHashBytes: 32,
                posTimestampBytes: 6,
                powRewardBytes: 8,

                txsPointersBytes: blockData.Txs.length * serializer.txPointerByte,
                txsBytes: 0
            }

            /** @type {Uint8Array<ArrayBuffer>[]} */
            const serializedTxs = [];
            for (let i = 0; i < blockData.Txs.length; i++) {
                const serializedTx = i === 0 // only one special transaction in candidate block (validatorTx)
                    ? this.specialTransaction(blockData.Txs[i])
                    : this.transaction(blockData.Txs[i])

                serializedTxs.push(serializedTx);
                elementsLength.txsBytes += serializedTx.length;
            }

            const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 6 + 8; // usefull for reading
            const serializedBlock = new ArrayBuffer(2 + totalHeaderBytes + elementsLength.txsPointersBytes + elementsLength.txsBytes);
            const serializedBlockView = new Uint8Array(serializedBlock);
            let cursor = 0;

            // HEADER
            serializedBlockView.set(fastConverter.numberTo2BytesUint8Array(blockData.Txs.length), cursor);
            cursor += 2; // nb of txs: 2 bytes

            serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.index), cursor);
            cursor += 4; // index: 4 bytes

            serializedBlockView.set(fastConverter.numberTo8BytesUint8Array(blockData.supply), cursor);
            cursor += 8; // supply: 8 bytes

            serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.coinBase), cursor);
            cursor += 4; // coinBase: 4 bytes

            serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.difficulty), cursor);
            cursor += 4; // difficulty: 4 bytes

            serializedBlockView.set(fastConverter.numberTo2BytesUint8Array(blockData.legitimacy), cursor);
            cursor += 2; // legitimacy: 2 bytes

            serializedBlockView.set(fastConverter.hexToUint8Array(blockData.prevHash), cursor);
            cursor += 32; // prevHash: 32 bytes

            serializedBlockView.set(fastConverter.numberTo6BytesUint8Array(blockData.posTimestamp), cursor);
            cursor += 6; // posTimestamp: 4 bytes

            serializedBlockView.set(fastConverter.numberTo8BytesUint8Array(blockData.powReward), cursor);
            cursor += 8; // powReward: 8 bytes

            // POINTERS & TXS
            let offset = 2 + totalHeaderBytes + elementsLength.txsPointersBytes; // where the txs start
            for (let i = 0; i < serializedTxs.length; i++) {
                serializedBlockView.set(fastConverter.hexToUint8Array(blockData.Txs[i].id), cursor);
                cursor += 4; // tx id: 4 bytes

                serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(offset), cursor);
                cursor += 4; // tx offset: 4 bytes
                
                const serializedTx = serializedTxs[i];
                serializedBlockView.set(serializedTx, offset);
                offset += serializedTx.length;
            }

            return serializedBlockView;
        },
        /** @param {NodeSetting} nodeSetting */
        nodeSetting(nodeSetting) {
            const serializedNodeSetting = new ArrayBuffer(32 + 16 + 16 + 1); // total 65 bytes
            const serializedNodeSettingView = new Uint8Array(serializedNodeSetting);
            serializedNodeSettingView.set(fastConverter.hexToUint8Array(nodeSetting.privateKey), 0); // 32 bytes
            serializedNodeSettingView.set(fastConverter.addressBase58ToUint8Array(nodeSetting.validatorRewardAddress), 32); // 16 bytes
            serializedNodeSettingView.set(fastConverter.addressBase58ToUint8Array(nodeSetting.minerAddress), 48); // 16 bytes
            serializedNodeSettingView.set(fastConverter.numberTo1ByteUint8Array(nodeSetting.minerThreads), 64); // 1 byte
            return serializedNodeSettingView;
        },
        /** @param {UtxoCache} utxoCache */
        utxoCacheData(utxoCache) {
            const totalOfBalancesSerialized = fastConverter.numberTo6BytesUint8Array(utxoCache.totalOfBalances);
            const totalSupplySerialized = fastConverter.numberTo6BytesUint8Array(utxoCache.totalSupply);
            const miniUTXOsSerialized = serializer.serialize.miniUTXOsObj(utxoCache.unspentMiniUtxos);
    
            const utxoCacheDataSerialized = new Uint8Array(6 + 6 + miniUTXOsSerialized.length);
            utxoCacheDataSerialized.set(totalOfBalancesSerialized);
            utxoCacheDataSerialized.set(totalSupplySerialized, 6);
            utxoCacheDataSerialized.set(miniUTXOsSerialized, 12);
            return utxoCacheDataSerialized;
        },
        /** @param {SyncStatus} syncStatus @param {Uint8Array} data */
        syncResponse(syncStatus, data) {
            const serializedSyncStatus = new ArrayBuffer(4 + 4 + 4 + 32 + 32 + data.length); // total 76 + data.length bytes
            const serializedSyncStatusView = new Uint8Array(serializedSyncStatus);
            serializedSyncStatusView.set(fastConverter.numberTo4BytesUint8Array(data.length), 0);
            serializedSyncStatusView.set(fastConverter.numberTo4BytesUint8Array(syncStatus.currentHeight), 4);
            serializedSyncStatusView.set(fastConverter.numberTo4BytesUint8Array(syncStatus.checkpointInfo.height), 8);
            serializedSyncStatusView.set(fastConverter.hexToUint8Array(syncStatus.latestBlockHash), 12);
            serializedSyncStatusView.set(fastConverter.hexToUint8Array(syncStatus.checkpointInfo.hash), 44);
            if (data.length > 0) serializedSyncStatusView.set(data, 76);
            return serializedSyncStatusView;
        }
    },
    deserialize: {
        /** @param {Uint8Array} serializedSyncResponse */
        syncResponse(serializedSyncResponse) {
            const dataLength = fastConverter.uint84BytesToNumber(serializedSyncResponse.slice(0, 4));
            const currentHeight = fastConverter.uint84BytesToNumber(serializedSyncResponse.slice(4, 8));
            const checkpointHeight = fastConverter.uint84BytesToNumber(serializedSyncResponse.slice(8, 12));
            const latestBlockHash = fastConverter.uint8ArrayToHex(serializedSyncResponse.slice(12, 44));
            const checkpointHash = fastConverter.uint8ArrayToHex(serializedSyncResponse.slice(44, 76));
            // fill data even if partial
            const data = dataLength > 0 ? serializedSyncResponse.slice(76) : new Uint8Array(0);
            return { dataLength, currentHeight, latestBlockHash, checkpointInfo: { height: checkpointHeight, hash: checkpointHash }, data };
        },
        rawData(encodedData) {
            return msgpack.decode(encodedData);
        },
        /** @param {Uint8Array} serializedAnchor */
        anchor(serializedAnchor) {
            const blockHeightSerialized = serializedAnchor.slice(0, 4);
            const hashSerialized = serializedAnchor.slice(4, 8);
            const inputIndexSerialized = serializedAnchor.slice(8, 10);

            const blockHeight = fastConverter.uint84BytesToNumber(blockHeightSerialized);
            const hash = fastConverter.uint8ArrayToHex(hashSerialized);
            const inputIndex = fastConverter.uint82BytesToNumber(inputIndexSerialized);
            return `${blockHeight}:${hash}:${inputIndex}`;
        },
        /** @param {Uint8Array} serializedAnchorsArray */
        anchorsArray(serializedAnchorsArray) {
            const anchors = [];
            for (let i = 0; i < serializedAnchorsArray.length; i += 10)
                anchors.push(this.anchor(serializedAnchorsArray.slice(i, i + 10)));
            return anchors;
        },
        /** @param {Uint8Array} serializedAnchorsObj */
        anchorsObjFromArray(serializedAnchorsObj) {
            const anchors = this.anchorsArray(serializedAnchorsObj);
            const obj = {};
            for (let i = 0; i < anchors.length; i++) obj[anchors[i]] = true;
            return obj;
        },
        /** Deserialize a miniUTXO: address, amount, rule (23 bytes)
         * @param {Uint8Array} serializedUTXO */
        miniUTXO(serializedminiUTXO) {
            const amount = fastConverter.uint86BytesToNumber(serializedminiUTXO.slice(0, 6)); // 6 bytes
            const ruleCode = fastConverter.uint81ByteToNumber(serializedminiUTXO.slice(6, 7)); // 1 byte
            /** @type {string} */
            const rule = UTXO_RULESNAME_FROM_CODE[ruleCode];
            const address = fastConverter.addressUint8ArrayToBase58(serializedminiUTXO.slice(7, 23)); // 16 bytes
            return { address, amount, rule };
        },
        /** @param {Uint8Array} serializedminiUTXOs */
        miniUTXOsArray(serializedminiUTXOs) {
            const miniUTXOs = [];
            for (let i = 0; i < serializedminiUTXOs.length; i += 23)
                miniUTXOs.push(this.miniUTXO(serializedminiUTXOs.slice(i, i + 23)));
            return miniUTXOs;
        },
        /** @param {Uint8Array} serializedminiUTXOs */
        miniUTXOsObj(serializedminiUTXOs) {
            //const deserializationStart = performance.now();
            //let totalAnchorsDeserializationTime = 0;
            const miniUTXOsObj = {};
            for (let i = 0; i < serializedminiUTXOs.length; i += 33) {
                const anchorSerialized = serializedminiUTXOs.slice(i, i + 10);
                const miniUTXOSerialized = serializedminiUTXOs.slice(i + 10, i + 33);
                //const AnchorsdeserializationStart = performance.now();
                const anchor = this.anchor(anchorSerialized); // deserialize anchor to string key
                //const AnchorsdeserializationEnd = performance.now();
                //totalAnchorsDeserializationTime += AnchorsdeserializationEnd - AnchorsdeserializationStart;
                miniUTXOsObj[anchor] = miniUTXOSerialized;
            }
            /*const totalDeserializationTime = performance.now() - deserializationStart;
            console.log('Total anchors deserialization time:', totalAnchorsDeserializationTime, 'ms');
            console.log('Total deserialization time:', totalDeserializationTime, 'ms');*/
            return miniUTXOsObj;
        },
        /** @param {Uint8Array} serializedTxsRef */
        txsReferencesArray(serializedTxsRef) {
            const txsRef = [];
            for (let i = 0; i < serializedTxsRef.length; i += 8) {
                const blockHeight = fastConverter.uint84BytesToNumber(serializedTxsRef.slice(i, i + 4));
                const hash = fastConverter.uint8ArrayToHex(serializedTxsRef.slice(i + 4, i + 8));
                txsRef.push(`${blockHeight}:${hash}`);
            }
            return txsRef;
        },
        /** @param {Uint8Array} serializedPubkeyAddresses */
        pubkeyAddressesObj(serializedPubkeyAddresses) {
            const pubkeyAddresses = {};
            for (let i = 0; i < serializedPubkeyAddresses.byteLength; i += 48) {
                const pubKey = fastConverter.uint8ArrayToHex(serializedPubkeyAddresses.slice(i, i + 32)); // 48 + 32 = 80
                const address = fastConverter.addressUint8ArrayToBase58(serializedPubkeyAddresses.slice(i + 32, i + 48));
                pubkeyAddresses[pubKey] = address;
            }
            return pubkeyAddresses;
        },
        /** @param {Uint8Array} serializedWitnesses */
        witnessesArray(serializedWitnesses) {
            const witnesses = [];
            for (let i = 0; i < serializedWitnesses.length; i += 96) { 
                const sig = fastConverter.uint8ArrayToHex(serializedWitnesses.slice(i, i + 64));
                const pubKey = fastConverter.uint8ArrayToHex(serializedWitnesses.slice(i + 64, i + 96));
                witnesses.push(`${sig}:${pubKey}`);
            }
            return witnesses;
        },
        /** @param {Uint8Array} serializedTx */
        specialTransaction(serializedTx) {
            try {
                const elementsLength = {
                    witnesses: fastConverter.uint82BytesToNumber(serializedTx.slice(0, 2)), // nb of witnesses
                    outputs: fastConverter.uint82BytesToNumber(serializedTx.slice(2, 4)), // nb of outputs
                    dataBytes: fastConverter.uint82BytesToNumber(serializedTx.slice(4, 6)) // data: bytes
                }

                const isCoinbase = elementsLength.witnesses === 0;
                const isValidator = elementsLength.witnesses === 1;
                if (!isCoinbase && !isValidator) throw new Error('Invalid special transaction');

                let cursor = 6;
                const id = fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4));
                cursor += 4; // id: hex 4 bytes

                const witnesses = isCoinbase ? [] : this.witnessesArray(serializedTx.slice(cursor, cursor + elementsLength.witnesses * 96));
                cursor += elementsLength.witnesses * 96;

                const version = fastConverter.uint82BytesToNumber(serializedTx.slice(cursor, cursor + 2));
                cursor += 2; // version: number 2 bytes

                const inputs = isCoinbase
                    ? [fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4))]
                    : [`${fastConverter.addressUint8ArrayToBase58(serializedTx.slice(cursor, cursor + 16))}:${fastConverter.uint8ArrayToHex(serializedTx.slice(cursor + 16, cursor + 48))}`];
                cursor += isCoinbase ? 4 : 48;

                const outputs = this.miniUTXOsArray(serializedTx.slice(cursor, cursor + elementsLength.outputs * 23));
                cursor += elementsLength.outputs * 23;

                if (elementsLength.dataBytes === 0) return Transaction(inputs, outputs, id, witnesses, version);

                throw new Error('Data field not implemented yet!');
                const data = serializedTx.slice(cursor, cursor + elementsLength.dataBytes); // max 65535 bytes
                return Transaction(inputs, outputs, id, witnesses, version, data);
            } catch (error) {
                console.error(error);
                throw new Error('Failed to deserialize the special transaction');
            }
        },
        /** @param {Uint8Array} serializedTx */
        transaction(serializedTx) {
            try {
                const elementsLength = {
                    witnesses: fastConverter.uint82BytesToNumber(serializedTx.slice(0, 2)), // nb of witnesses
                    inputs: fastConverter.uint82BytesToNumber(serializedTx.slice(2, 4)), // nb of inputs
                    outputs: fastConverter.uint82BytesToNumber(serializedTx.slice(4, 6)), // nb of outputs
                    dataBytes: fastConverter.uint82BytesToNumber(serializedTx.slice(6, 8)) // data: bytes
                }

                let cursor = 8;
                const id = fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4));
                cursor += 4; // id: hex 4 bytes

                const witnesses = this.witnessesArray(serializedTx.slice(cursor, cursor + elementsLength.witnesses * 96));
                cursor += elementsLength.witnesses * 96;

                const version = fastConverter.uint82BytesToNumber(serializedTx.slice(cursor, cursor + 2));
                cursor += 2; // version: number 2 bytes

                const inputs = this.anchorsArray(serializedTx.slice(cursor, cursor + elementsLength.inputs * 10));
                cursor += elementsLength.inputs * 10;

                const outputs = this.miniUTXOsArray(serializedTx.slice(cursor, cursor + elementsLength.outputs * 23));
                cursor += elementsLength.outputs * 23;

                if (elementsLength.dataBytes === 0) return Transaction(inputs, outputs, id, witnesses, version);

                throw new Error('Data field not implemented yet!');
                const data = serializedTx.slice(cursor, cursor + elementsLength.dataBytes); // max 65535 bytes
                return Transaction(inputs, outputs, id, witnesses, version, data);
                
            } catch (error) {
                if (error.message === 'Data field not implemented yet!') { throw new Error('Data field not implemented yet!'); }
                console.error(error);
                throw new Error('Failed to deserialize the transaction');
            }
        },
        /** @param {Uint8Array} serializedBlock */
        block_finalized(serializedBlock) {
            const nbOfTxs = fastConverter.uint82BytesToNumber(serializedBlock.slice(0, 2)); // 2 bytes

            /** @type {BlockData} */
            const blockData = {
                index: fastConverter.uint84BytesToNumber(serializedBlock.slice(2, 6)), // 4 bytes
                supply: fastConverter.uint88BytesToNumber(serializedBlock.slice(6, 14)), // 8 bytes
                coinBase: fastConverter.uint84BytesToNumber(serializedBlock.slice(14, 18)), // 4 bytes
                difficulty: fastConverter.uint84BytesToNumber(serializedBlock.slice(18, 22)), // 4 bytes
                legitimacy: fastConverter.uint82BytesToNumber(serializedBlock.slice(22, 24)), // 2 bytes
                prevHash: fastConverter.uint8ArrayToHex(serializedBlock.slice(24, 56)), // 32 bytes
                posTimestamp: fastConverter.uint86BytesToNumber(serializedBlock.slice(56, 62)), // 6 bytes
                timestamp: fastConverter.uint86BytesToNumber(serializedBlock.slice(62, 68)), // 6 bytes
                hash: fastConverter.uint8ArrayToHex(serializedBlock.slice(68, 100)), // 32 bytes
                nonce: fastConverter.uint8ArrayToHex(serializedBlock.slice(100, 104)), // 4 bytes
                Txs: []
            }

            const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 6 + 6 + 32 + 4; // usefull for reading
            const cursor = 2 + totalHeaderBytes;
            const txsPointers = [];
            for (let i = cursor; i < cursor + nbOfTxs * 8; i += 8) {
                const id = fastConverter.uint8ArrayToHex(serializedBlock.slice(i, i + 4));
                const offset = fastConverter.uint84BytesToNumber(serializedBlock.slice(i + 4, i + 8));
                txsPointers.push([id, offset]);
            }

            if (txsPointers.length !== nbOfTxs) throw new Error('Invalid txs pointers');

            for (let i = 0; i < txsPointers.length; i++) {
                const [id, offsetStart] = txsPointers[i];
                const offsetEnd = i + 1 < txsPointers.length ? txsPointers[i + 1][1] : serializedBlock.length;
                const serializedTx = serializedBlock.slice(offsetStart, offsetEnd);
                const tx = i < 2 ? this.specialTransaction(serializedTx) : this.transaction(serializedTx);
                if (tx.id !== id) throw new Error('Invalid tx id');
                blockData.Txs.push(tx);
            }

            return blockData;
        },
        /** @param {Uint8Array} serializedBlock */
        block_candidate(serializedBlock) {
            const nbOfTxs = fastConverter.uint82BytesToNumber(serializedBlock.slice(0, 2)); // 2 bytes

            /** @type {BlockData} */
            const blockData = {
                index: fastConverter.uint84BytesToNumber(serializedBlock.slice(2, 6)), // 4 bytes
                supply: fastConverter.uint88BytesToNumber(serializedBlock.slice(6, 14)), // 8 bytes
                coinBase: fastConverter.uint84BytesToNumber(serializedBlock.slice(14, 18)), // 4 bytes
                difficulty: fastConverter.uint84BytesToNumber(serializedBlock.slice(18, 22)), // 4 bytes
                legitimacy: fastConverter.uint82BytesToNumber(serializedBlock.slice(22, 24)), // 2 bytes
                prevHash: fastConverter.uint8ArrayToHex(serializedBlock.slice(24, 56)), // 32 bytes
                posTimestamp: fastConverter.uint86BytesToNumber(serializedBlock.slice(56, 62)), // 6 bytes
                powReward: fastConverter.uint88BytesToNumber(serializedBlock.slice(62, 70)), // 8 bytes
                Txs: []
            }

            const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 6 + 8; // usefull for reading
            const cursor = 2 + totalHeaderBytes;
            const txsPointers = [];
            for (let i = cursor; i < cursor + nbOfTxs * 8; i += 8) {
                const id = fastConverter.uint8ArrayToHex(serializedBlock.slice(i, i + 4));
                const offset = fastConverter.uint84BytesToNumber(serializedBlock.slice(i + 4, i + 8));
                txsPointers.push([id, offset]);
            }

            if (txsPointers.length !== nbOfTxs) throw new Error('Invalid txs pointers');

            for (let i = 0; i < txsPointers.length; i++) {
                const [id, offsetStart] = txsPointers[i];
                const offsetEnd = i + 1 < txsPointers.length ? txsPointers[i + 1][1] : serializedBlock.length;
                const serializedTx = serializedBlock.slice(offsetStart, offsetEnd);
                const tx = i === 0 ? this.specialTransaction(serializedTx) : this.transaction(serializedTx);
                if (tx.id !== id) throw new Error('Invalid tx id');

                blockData.Txs.push(tx);
            }

            return blockData;
        },
        /** @param {Uint8Array} serializedNodeSetting */
        nodeSetting(serializedNodeSetting) {
            const privateKey = fastConverter.uint8ArrayToHex(serializedNodeSetting.slice(0, 32)); // 32 bytes
            const validatorRewardAddress = fastConverter.addressUint8ArrayToBase58(serializedNodeSetting.slice(32, 48)); // 16 bytes
            const minerAddress = fastConverter.addressUint8ArrayToBase58(serializedNodeSetting.slice(48, 64)); // 16 bytes
            const minerThreads = fastConverter.uint81ByteToNumber(serializedNodeSetting.slice(64, 65)); // 1 byte

            return { privateKey, validatorRewardAddress, minerAddress, minerThreads };
        }
    }
};