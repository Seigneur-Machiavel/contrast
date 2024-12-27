import { FastConverter } from './converters.mjs';
import { UTXO_RULES_GLOSSARY, UTXO_RULESNAME_FROM_CODE } from './utxo-rules.mjs';
import { Transaction } from '../node/src/transaction.mjs';

/**
* @typedef {import("../node/src/block-classes.mjs").BlockData} BlockData
*/

const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
async function msgPackLib() {
    if (isNode) {
        const m = await import('../libs/msgpack.min.js');
        return m.default;
    }
    return MessagePack;
};
const msgpack = await msgPackLib();
const fastConverter = new FastConverter();

/** Theses functions are used to serialize and deserialize the data of the blockchain.
 * 
 * - functions do not check the input data.
 * - Make sure to validate the data before using these functions.
 */
export const serializer = {
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
            for (let i = 0; i < witnesses.length; i++) {
                const witness = fastConverter.hexToUint8Array(witnesses[i].replace(':', ''));
                witnessesBufferView.set(witness, i * 96);
            }
            return witnessesBufferView;
        },
        /** @param {Transaction} tx */
        specialTransation(tx) {
            try {
                const isCoinbase = tx.witnesses.length === 0;
                const isValidator = tx.witnesses.length === 1;
                if (!isCoinbase && !isValidator) { throw new Error('Invalid special transaction'); }
                
                if (isCoinbase && (tx.inputs.length !== 1 || tx.inputs[0].length !== 8)) { throw new Error('Invalid coinbase transaction'); }
                if (isValidator && (tx.inputs.length !== 1 || tx.inputs[0].length !== 85)) { throw new Error('Invalid transaction'); }
    
                const elementsLenght = {
                    witnesses: tx.witnesses.length, // nb of witnesses: 0 = coinbase, 1 = validator
                    witnessesBytes: tx.witnesses.length * 96, // (sig + pubKey) * nb of witnesses -> 96 bytes * nb of witnesses
                    inputsBytes: isCoinbase ? 4 : 85, // nonce(4B) or address(16B) + posHashHex(32B)
                    outputs: tx.outputs.length, // nb of outputs
                    outputsBytes: 23, // (amount + rule + address) -> 23 bytes
                    dataBytes: tx.data ? tx.data.byteLength : 0 // data: bytes
                }
    
                const serializedTx = new ArrayBuffer(6 + 4 + elementsLenght.witnessesBytes + 2 + elementsLenght.inputsBytes + elementsLenght.outputsBytes + elementsLenght.dataBytes);
                const serializedTxView = new Uint8Array(serializedTx);

                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.witnesses), 0); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.outputs), 2); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.dataBytes), 6); // 2 bytes

                let cursor = 6;
                serializedTxView.set(fastConverter.hexToUint8Array(tx.id), cursor);
                cursor += 4; // id: hex 4 bytes

                if (isValidator) { // WITNESSES
                    serializedTxView.set(this.witnessesArray(tx.witnesses), cursor);
                    cursor += elementsLenght.witnessesBytes; // witnesses: 96 bytes
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
                cursor += elementsLenght.outputsBytes;

                if (elementsLenght.dataBytes === 0) { return serializedTxView; }

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
                const elementsLenght = {
                    witnesses: tx.witnesses.length, // nb of witnesses
                    witnessesBytes: tx.witnesses.length * 96, // (sig + pubKey) * nb of witnesses -> 96 bytes * nb of witnesses
                    inputs: tx.inputs.length, // nb of inputs
                    inputsBytes: tx.inputs.length * 10, // (blockHeight + hash + inputIndex) * nb of inputs -> 10 bytes * nb of inputs
                    outputs: tx.outputs.length, // nb of outputs
                    outputsBytes: tx.outputs.length * 23, // (amount + rule + address) * nb of outputs -> 23 bytes * nb of outputs
                    dataBytes: tx.data ? tx.data.byteLength : 0 // data: bytes
                }

                const serializedTx = new ArrayBuffer(8 + 4 + elementsLenght.witnessesBytes + 2 + elementsLenght.inputsBytes + elementsLenght.outputsBytes + elementsLenght.dataBytes);
                const serializedTxView = new Uint8Array(serializedTx);

                // DESCRIPTION (8 bytes)
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.witnesses), 0); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.inputs), 2); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.outputs), 4); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.dataBytes), 6); // 2 bytes
                
                let cursor = 8;
                serializedTxView.set(fastConverter.hexToUint8Array(tx.id), cursor);
                cursor += 4; // id: hex 4 bytes

                serializedTxView.set(this.witnessesArray(tx.witnesses), cursor);
                cursor += elementsLenght.witnessesBytes;

                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(tx.version), cursor);
                cursor += 2; // version: number 2 bytes

                serializedTxView.set(this.anchorsArray(tx.inputs), cursor);
                cursor += elementsLenght.inputsBytes;

                const serializedOutputs = this.miniUTXOsArray(tx.outputs);
                serializedTxView.set(serializedOutputs, cursor);
                cursor += elementsLenght.outputsBytes;

                if (elementsLenght.dataBytes === 0) { return serializedTxView; }

                throw new Error('Data serialization not implemented yet');
                serializedTxView.set(tx.data, cursor); // max 65535 bytes
                return serializedTxView;
            } catch (error) {
                console.error('Error while serializing the transaction:', error);
                throw new Error('Failed to serialize the transaction');
            }
        },
        /** @param {BlockData} blockData */
        block_finalized(blockData) {
            try {
                const pointerByte = 8; // ID:Offset => 4 bytes + 4 bytes
                const elementsLenght = {
                    nbOfTxs: 2, // 2bytes to store: blockData.Txs.length
                    indexBytes: 4,
                    supplyBytes: 8,
                    coinBaseBytes: 4,
                    difficultyBytes: 4,
                    legitimacyBytes: 2,
                    prevHashBytes: 32,
                    posTimestampBytes: 4,
                    timestampBytes: 4,
                    hashBytes: 32,
                    nonceBytes: 4,

                    toto: blockData.powReward,
                    txsPointersBytes: blockData.Txs.length * pointerByte,
                    txsBytes: 0
                }

                /** @type {Uint8Array<ArrayBuffer>[]} */
                const serializedTxs = [];
                for (let i = 0; i < blockData.Txs.length; i++) {
                    const serializedTx = i < 2
                        ? this.specialTransation(blockData.Txs[i])
                        : this.transaction(blockData.Txs[i])

                    serializedTxs.push(serializedTx);
                    elementsLenght.txsBytes += serializedTx.length;
                }
                
                const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 4 + 4 + 32 + 4; // usefull for reading
                const serializedBlock = new ArrayBuffer(2 + totalHeaderBytes + elementsLenght.txsPointersBytes + elementsLenght.txsBytes);
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

                serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.posTimestamp), cursor);
                cursor += 4; // posTimestamp: 4 bytes

                serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.timestamp), cursor);
                cursor += 4; // timestamp: 4 bytes

                serializedBlockView.set(fastConverter.hexToUint8Array(blockData.hash), cursor);
                cursor += 32; // hash: 32 bytes

                serializedBlockView.set(fastConverter.hexToUint8Array(blockData.nonce), cursor);
                cursor += 4; // nonce: 4 bytes
                
                // POINTERS & TXS -> This specific traitment offer a better reading performance:
                // ----- no need to deserialize the whole block to read the txs -----
                let offset = 2 + totalHeaderBytes + elementsLenght.txsPointersBytes; // where the txs start
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
            } catch (error) {
                console.error('Error while serializing the finalized block:', error);
                throw new Error('Failed to serialize the finalized block');
            }
        },
        block_candidate(blockData) {
            try {
                const elementsLenght = {
                    indexBytes: 4,
                    supplyBytes: 8,
                    coinBaseBytes: 4,
                    difficultyBytes: 4,
                    legitimacyBytes: 2,
                    prevHashBytes: 32,
                    posTimestampBytes: 4,
                    powRewardBytes: 8,
                    txsBytes: 0
                }

                /** @type {Uint8Array<ArrayBuffer>[]} */
                const serializedTxs = [];
                for (let i = 0; i < blockData.Txs.length; i++) {
                    const serializedTx = i === 0 // only the first tx is a special transaction in candidate
                        ? this.specialTransation(blockData.Txs[i])
                        : this.transaction(blockData.Txs[i])

                    serializedTxs.push(serializedTx);
                    elementsLenght.txsBytes += serializedTx.length;
                }

                const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 4 + 8;
                const serializedBlock = new ArrayBuffer(totalHeaderBytes + elementsLenght.txsBytes);
                const serializedBlockView = new Uint8Array(serializedBlock);

                let cursor = 0;
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

                serializedBlockView.set(fastConverter.numberTo4BytesUint8Array(blockData.posTimestamp), cursor);
                cursor += 4; // posTimestamp: 4 bytes

                serializedBlockView.set(fastConverter.numberTo8BytesUint8Array(blockData.powReward), cursor);
                cursor += 8; // powReward: 8 bytes

                // TXS
                let offset = totalHeaderBytes;
                for (let i = 0; i < serializedTxs.length; i++) {
                    const serializedTx = serializedTxs[i];
                    serializedBlockView.set(serializedTx, offset);
                    offset += serializedTx.length;
                }

                return serializedBlockView;
            }
            catch (error) {
                console.error('Error while serializing the candidate block:', error);
                throw new Error('Failed to serialize the candidate block');
            }
        }
    },
    deserialize: {
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
            for (let i = 0; i < serializedAnchorsArray.length; i += 10) {
                const serializedAnchor = serializedAnchorsArray.slice(i, i + 10);
                anchors.push(this.anchor(serializedAnchor));
            }
            return anchors;
        },
        /** @param {Uint8Array} serializedAnchorsObj */
        anchorsObjFromArray(serializedAnchorsObj) {
            const anchors = this.anchorsArray(serializedAnchorsObj);
            const obj = {};
            for (let i = 0; i < anchors.length; i++) {
                obj[anchors[i]] = true;
            }
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
            for (let i = 0; i < serializedminiUTXOs.length; i += 23) {
                miniUTXOs.push(this.miniUTXO(serializedminiUTXOs.slice(i, i + 23)));
            }
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
        specialTransation(serializedTx) {
            try {
                const elementsLenght = {
                    witnesses: fastConverter.uint82BytesToNumber(serializedTx.slice(0, 2)), // nb of witnesses
                    outputs: fastConverter.uint82BytesToNumber(serializedTx.slice(2, 4)), // nb of outputs
                    dataBytes: fastConverter.uint82BytesToNumber(serializedTx.slice(4, 6)) // data: bytes
                }

                const isCoinbase = elementsLenght.witnesses === 0;
                const isValidator = elementsLenght.witnesses === 1;
                if (!isCoinbase && !isValidator) { throw new Error('Invalid special transaction'); }

                let cursor = 6;
                const id = fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4));
                cursor += 4; // id: hex 4 bytes

                const witnesses = isCoinbase ? [] : this.witnessesArray(serializedTx.slice(cursor, cursor + elementsLenght.witnesses * 96));
                cursor += elementsLenght.witnesses * 96;

                const version = fastConverter.uint82BytesToNumber(serializedTx.slice(cursor, cursor + 2));
                cursor += 2; // version: number 2 bytes

                const inputs = isCoinbase
                    ? [fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4))]
                    : [`${fastConverter.addressUint8ArrayToBase58(serializedTx.slice(cursor, cursor + 16))}:${fastConverter.uint8ArrayToHex(serializedTx.slice(cursor + 16, cursor + 48))}`];
                cursor += isCoinbase ? 4 : 48;

                const outputs = this.miniUTXOsArray(serializedTx.slice(cursor, cursor + elementsLenght.outputs * 23));
                cursor += elementsLenght.outputs * 23;

                if (elementsLenght.dataBytes === 0) { return Transaction(inputs, outputs, id, witnesses, version); }

                throw new Error('Data field not implemented yet!');
                const data = serializedTx.slice(cursor, cursor + elementsLenght.dataBytes); // max 65535 bytes
                return Transaction(inputs, outputs, id, witnesses, version, data);
            } catch (error) {
                console.error(error);
                throw new Error('Failed to deserialize the special transaction');
            }
        },
        /** @param {Uint8Array} serializedTx */
        transaction(serializedTx) {
            try {
                const elementsLenght = {
                    witnesses: fastConverter.uint82BytesToNumber(serializedTx.slice(0, 2)), // nb of witnesses
                    inputs: fastConverter.uint82BytesToNumber(serializedTx.slice(2, 4)), // nb of inputs
                    outputs: fastConverter.uint82BytesToNumber(serializedTx.slice(4, 6)), // nb of outputs
                    dataBytes: fastConverter.uint82BytesToNumber(serializedTx.slice(6, 8)) // data: bytes
                }

                let cursor = 8;
                const id = fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4));
                cursor += 4; // id: hex 4 bytes

                const witnesses = this.witnessesArray(serializedTx.slice(cursor, cursor + elementsLenght.witnesses * 96));
                cursor += elementsLenght.witnesses * 96;

                const version = fastConverter.uint82BytesToNumber(serializedTx.slice(cursor, cursor + 2));
                cursor += 2; // version: number 2 bytes

                const inputs = this.anchorsArray(serializedTx.slice(cursor, cursor + elementsLenght.inputs * 10));
                cursor += elementsLenght.inputs * 10;

                const outputs = this.miniUTXOsArray(serializedTx.slice(cursor, cursor + elementsLenght.outputs * 23));
                cursor += elementsLenght.outputs * 23;

                if (elementsLenght.dataBytes === 0) { return Transaction(inputs, outputs, id, witnesses, version); }

                throw new Error('Data field not implemented yet!');
                const data = serializedTx.slice(cursor, cursor + elementsLenght.dataBytes); // max 65535 bytes
                return Transaction(inputs, outputs, id, witnesses, version, data);
                
            } catch (error) {
                if (error.message === 'Data field not implemented yet!') { throw new Error('Data field not implemented yet!'); }
                console.error(error);
                throw new Error('Failed to deserialize the transaction');
            }
        },
        /** @param {Uint8Array} serializedBlock */
        block_finalized(serializedBlock) {
            try {
                const nbOfTxs = fastConverter.uint82BytesToNumber(serializedBlock.slice(0, 2)); // 2 bytes

                /** @type {BlockData} */
                const blockData = {
                    index: fastConverter.uint84BytesToNumber(serializedBlock.slice(2, 6)),
                    supply: fastConverter.uint88BytesToNumber(serializedBlock.slice(6, 14)),
                    coinBase: fastConverter.uint84BytesToNumber(serializedBlock.slice(14, 18)),
                    difficulty: fastConverter.uint84BytesToNumber(serializedBlock.slice(18, 22)),
                    legitimacy: fastConverter.uint82BytesToNumber(serializedBlock.slice(22, 24)),
                    prevHash: fastConverter.uint8ArrayToHex(serializedBlock.slice(24, 56)),
                    posTimestamp: fastConverter.uint84BytesToNumber(serializedBlock.slice(56, 60)),
                    timestamp: fastConverter.uint84BytesToNumber(serializedBlock.slice(60, 64)),
                    hash: fastConverter.uint8ArrayToHex(serializedBlock.slice(64, 96)),
                    nonce: fastConverter.uint8ArrayToHex(serializedBlock.slice(96, 100)),
                    Txs: []
                }

                const totalHeaderBytes = 4 + 8 + 4 + 4 + 2 + 32 + 4 + 4 + 32 + 4; // usefull for reading
                const cursor = 2 + totalHeaderBytes;
                const txsPointers = [];
                for (let i = cursor; i < cursor + nbOfTxs * 8; i += 8) {
                    const id = fastConverter.uint8ArrayToHex(serializedBlock.slice(i, i + 4));
                    const offset = fastConverter.uint84BytesToNumber(serializedBlock.slice(i + 4, i + 8));
                    txsPointers.push([id, offset]);
                }

                if (txsPointers.length !== nbOfTxs) { throw new Error('Invalid txs pointers'); }

                for (let i = 0; i < txsPointers.length; i++) {
                    const [id, offsetStart] = txsPointers[i];
                    const offsetEnd = i + 1 < txsPointers.length ? txsPointers[i + 1][1] : serializedBlock.length;
                    const serializedTx = serializedBlock.slice(offsetStart, offsetEnd);
                    const tx = i < 2 ? this.specialTransation(serializedTx) : this.transaction(serializedTx);
                    if (tx.id !== id) { throw new Error('Invalid tx id'); }
                    blockData.Txs.push(tx);
                }

                return blockData;
            } catch (error) {
                console.error(error);
                throw new Error('Failed to deserialize the finalized block');
            }
        },
        /** @param {Uint8Array} serializedBlock */
        block_candidate(serializedBlock) {
            try {
                const cursor = 0;
                const blockData = {
                    index: fastConverter.uint84BytesToNumber(serializedBlock.slice(cursor, cursor + 4)),
                    supply: fastConverter.uint88BytesToNumber(serializedBlock.slice(cursor + 4, cursor + 12)),
                    coinBase: fastConverter.uint84BytesToNumber(serializedBlock.slice(cursor + 12, cursor + 16)),
                    difficulty: fastConverter.uint84BytesToNumber(serializedBlock.slice(cursor + 16, cursor + 20)),
                    legitimacy: fastConverter.uint82BytesToNumber(serializedBlock.slice(cursor + 20, cursor + 22)),
                    prevHash: fastConverter.uint8ArrayToHex(serializedBlock.slice(cursor + 22, cursor + 54)),
                    posTimestamp: fastConverter.uint84BytesToNumber(serializedBlock.slice(cursor + 54, cursor + 58)),
                    powReward: fastConverter.uint88BytesToNumber(serializedBlock.slice(cursor + 58, cursor + 66)),
                    Txs: []
                }

                const txsStart = 66;
                for (let i = txsStart; i < serializedBlock.length; i += 1) {
                    const tx = this.specialTransation(serializedBlock.slice(i, i + 1));
                    blockData.Txs.push(tx);
                }

                return blockData;
            } catch (error) {
                console.error(error);
                throw new Error('Failed to deserialize the candidate block');
            }
        }
    }
};