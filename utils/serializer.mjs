import { convert, FastConverter } from './converters.mjs';
import { UTXO_RULES_GLOSSARY, UTXO_RULESNAME_FROM_CODE } from './utxo-rules.mjs';
import { Transaction } from '../node/src/transaction.mjs';

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

export const serializer = {
    rawData: {
        toBinary_v1(rawData) {
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(rawData);//, { maxStrLength: }
            return encoded;
        },
        /** @param {Uint8Array} encodedData */
        fromBinary_v1(encodedData) {
            return msgpack.decode(encodedData);
        },
        clone(data) { // not that fast compared to JSON.parse(JSON.stringify(data))
            const encoded = serializer.rawData.toBinary_v1(data);
            const decoded = serializer.rawData.fromBinary_v1(encoded);
            return decoded;
        }
    },
    transaction: {
        /** @param {Transaction} tx */
        toBinary_v2(tx, applyMsgPack = true) { // return array of Uint8Array
            try {
                const txAsArray = [
                    null, // id
                    [], // witnesses
                    null, // version
                    [], // inputs,
                    [] // outputs
                ]

                txAsArray[0] = convert.hex.toUint8Array(tx.id); // safe type: hex
                txAsArray[2] = convert.number.toUint8Array(tx.version); // safe type: number

                for (let i = 0; i < tx.witnesses.length; i++) {
                    const splitted = tx.witnesses[i].split(':');
                    txAsArray[1].push([
                        convert.hex.toUint8Array(splitted[0]), // safe type: hex
                        convert.hex.toUint8Array(splitted[1]) // safe type: hex
                    ]);
                }

                for (let j = 0; j < tx.inputs.length; j++) {
                    const splitted = tx.inputs[j].split(':');
                    if (splitted.length === 3) { // -> anchor ex: "3:f996a9d1:0"
                        txAsArray[3].push([
                            convert.number.toUint8Array(splitted[0]), // safe type: number
                            convert.hex.toUint8Array(splitted[1]), // safe type: hex
                            convert.number.toUint8Array(splitted[2]) // safe type: number
                        ]);
                    } else if (splitted.length === 2) { // -> pos validator address:hash
                        // ex: "WKXmNF5xJTd58aWpo7QX:964baf99b331fe400ca2de4da6fb4f52cbff8a7abfcea74e9f28704dc0dd2b5c"
                        txAsArray[3].push([
                            convert.base58.toUint8Array(splitted[0]), // safe type: base58
                            convert.hex.toUint8Array(splitted[1]) // safe type: hex
                        ]);
                    } else if (splitted.length === 1) { // -> pow miner nonce ex: "5684e9b4"
                        txAsArray[3].push([convert.hex.toUint8Array(splitted[0])]); // safe type: hex
                    }
                };

                for (let j = 0; j < tx.outputs.length; j++) {
                    const { address, amount, rule } = tx.outputs[j];
                    if (address, amount, rule) { //  {"amount": 19545485, "rule": "sig", "address": "WKXmNF5xJTd58aWpo7QX"}
                        const ruleCode = UTXO_RULES_GLOSSARY[rule].code;
                        txAsArray[4].push([
                            convert.number.toUint8Array(amount), // safe type: number
                            convert.number.toUint8Array(ruleCode), // safe type: numbers
                            convert.base58.toUint8Array(address) // safe type: base58
                        ]);
                    } else { // type: string
                        txAsArray[4].push([convert.string.toUint8Array(tx.outputs[j])]);
                    }
                };

                if (!applyMsgPack) { return txAsArray; }

                /** @type {Uint8Array} */
                const encoded = msgpack.encode(txAsArray);
                return encoded;
            } catch (error) {
                console.error('Error in prepareTransaction.toBinary_v2:', error);
                throw new Error('Failed to serialize the transaction');
            }
        },
        /** @param {Uint8Array} encodedTx */
        fromBinary_v2(encodedTx, applyMsgPack = true) {
            try {
                /** @type {Transaction} */
                const decodedTx = applyMsgPack ? msgpack.decode(encodedTx) : encodedTx;
                /** @type {Transaction} */
                const tx = {
                    id: convert.uint8Array.toHex(decodedTx[0]), // safe type: uint8 -> hex
                    witnesses: [],
                    version: convert.uint8Array.toNumber(decodedTx[2]), // safe type: uint8 -> number
                    inputs: [],
                    outputs: []
                };

                for (let i = 0; i < decodedTx[1].length; i++) {
                    const signature = convert.uint8Array.toHex(decodedTx[1][i][0]); // safe type: uint8 -> hex
                    const publicKey = convert.uint8Array.toHex(decodedTx[1][i][1]); // safe type: uint8 -> hex
                    tx.witnesses.push(`${signature}:${publicKey}`);
                };

                for (let j = 0; j < decodedTx[3].length; j++) {
                    const input = decodedTx[3][j];
                    if (input.length === 3) { // -> anchor ex: "3:f996a9d1:0"
                        tx.inputs.push(`${convert.uint8Array.toNumber(input[0])}:${convert.uint8Array.toHex(input[1])}:${convert.uint8Array.toNumber(input[2])}`);
                    } else if (input.length === 2) { // -> pos validator address:hash
                        tx.inputs.push(`${convert.uint8Array.toBase58(input[0])}:${convert.uint8Array.toHex(input[1])}`);
                    } else if (input.length === 1) { // -> pow miner nonce ex: "5684e9b4"
                        tx.inputs.push(convert.uint8Array.toHex(input[0]));
                    }
                };

                for (let j = 0; j < decodedTx[4].length; j++) {
                    const output = decodedTx[4][j];
                    if (output.length === 3) {
                        const amount = convert.uint8Array.toNumber(output[0]); // safe type: uint8 -> number
                        const ruleCode = convert.uint8Array.toNumber(output[1]); // safe type: uint8 -> number
                        const rule = UTXO_RULESNAME_FROM_CODE[ruleCode];
                        const address = convert.uint8Array.toBase58(output[2]); // safe type: uint8 -> base58
                        tx.outputs.push({ address, amount, rule });
                    } else {
                        tx.outputs.push(convert.uint8Array.toString(output));
                    }
                }

                return tx;
            } catch (error) {
                console.error('Error in prepareTransaction.fromBinary_v2:', error);
                throw new Error('Failed to deserialize the transaction');
            }
        }
    },
    array_of_transactions: {
        /** @param {Transaction[]} txs */
        toBinary_v3(txs, applyMsgPack = true) {
            const serializedTxs = [];
            for (let i = 0; i < txs.length; i++) {
                serializedTxs.push(serializer.transaction.toBinary_v2(txs[i], false));
            }

            if (!applyMsgPack) { return serializedTxs; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(serializedTxs);
            return encoded;
        },
        toBinary_v4(txs, applyMsgPack = true) {
            const serializedTxs = [];
            for (let i = 0; i < txs.length; i++) {
                if (i < 2) { serializedTxs.push(serializer.transaction.toBinary_v2(txs[i], false)); continue; }
                serializedTxs.push(serializerFast.serialize.transaction(txs[i]));
            }

            if (!applyMsgPack) { return serializedTxs; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(serializedTxs);
            return encoded;
        },
        /** @param {Uint8Array} encodedTxs */
        fromBinary_v3(encodedTxs, applyMsgPack = true) {
            const decodedTxs = applyMsgPack ? msgpack.decode(encodedTxs) : encodedTxs;
            const txs = [];
            for (let i = 0; i < decodedTxs.length; i++) {
                txs.push(serializer.transaction.fromBinary_v2(decodedTxs[i], false));
            }

            return txs;
        },
        fromBinary_v4(encodedTxs, applyMsgPack = true) {
            const decodedTxs = applyMsgPack ? msgpack.decode(encodedTxs) : encodedTxs;
            const txs = [];
            for (let i = 0; i < decodedTxs.length; i++) {
                if (i < 2) { txs.push(serializer.transaction.fromBinary_v2(decodedTxs[i], false)); continue; }
                txs.push(serializerFast.deserialize.transaction(decodedTxs[i]));
            }

            return txs;
        }
    },
    array_of_tx_ids: {
        /** @param {string[]} txIds */
        toBinary_v3(txIds, applyMsgPack = true) {
            const txIdsAsArray = [];
            for (let i = 0; i < txIds.length; i++) {
                txIdsAsArray.push(convert.hex.toUint8Array(txIds[i])); // safe type: hex
            }

            if (!applyMsgPack) { return txIdsAsArray; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(txIdsAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedTxIds */
        fromBinary_v3(encodedTxIds, applyMsgPack = true) {
            const decodedTxIds = applyMsgPack ? msgpack.decode(encodedTxIds) : encodedTxIds;
            const txIds = [];
            for (let i = 0; i < decodedTxIds.length; i++) {
                txIds.push(convert.uint8Array.toHex(decodedTxIds[i])); // safe type: uint8 -> hex
            }

            return txIds;
        }
    },
    block_candidate: {
        /** @param {BlockData} blockData */
        toBinary_v2(blockData) {
            // + powReward
            // - nonce - hash - timestamp

            const blockAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.powReward), // safe type: number
                [] // Txs
            ];

            for (let i = 0; i < blockData.Txs.length; i++) {
                blockAsArray[8].push(serializer.transaction.toBinary_v2(blockData.Txs[i]));
            }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v2(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlock[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlock[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlock[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlock[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlock[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlock[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlock[6]), // safe type: uint8 -> number
                powReward: convert.uint8Array.toNumber(decodedBlock[7]), // safe type: uint8 -> number
                Txs: []
            };

            for (let i = 0; i < decodedBlock[8].length; i++) {
                blockData.Txs.push(serializer.transaction.fromBinary_v2(decodedBlock[8][i]));
            }

            return blockData;
        },
        /** @param {BlockData} blockData */
        toBinary_v4(blockData) {
            const blockAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.powReward), // safe type: number
                serializer.array_of_transactions.toBinary_v4(blockData.Txs, false)
            ];

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v4(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlock[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlock[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlock[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlock[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlock[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlock[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlock[6]), // safe type: uint8 -> number
                powReward: convert.uint8Array.toNumber(decodedBlock[7]), // safe type: uint8 -> number
                Txs: serializer.array_of_transactions.fromBinary_v4(decodedBlock[8], false)
            };

            return blockData;
        }
    },
    block_finalized: {
        /** @param {BlockData} blockData */
        toBinary_v2(blockData) {
            //const startTimestamp = Date.now();
            const blockAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.timestamp), // safe type: number
                convert.hex.toUint8Array(blockData.hash), // safe type: hex
                convert.hex.toUint8Array(blockData.nonce), // safe type: hex
                [] // Txs
            ];

            for (let i = 0; i < blockData.Txs.length; i++) {
                blockAsArray[10].push(serializer.transaction.toBinary_v2(blockData.Txs[i]));
            };

            //console.log('Block finalized serialization time:', Date.now() - startTimestamp, 'ms');
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            //console.log('Block finalized serialization+msgpack time:', Date.now() - startTimestamp, 'ms');
            //console.log('Block finalized serialization+msgpack size:', encoded.length, 'bytes');
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v2(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlock[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlock[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlock[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlock[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlock[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlock[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlock[6]), // safe type: uint8 -> number   
                timestamp: convert.uint8Array.toNumber(decodedBlock[7]), // safe type: uint8 -> number
                hash: convert.uint8Array.toHex(decodedBlock[8]), // safe type: uint8 -> hex
                nonce: convert.uint8Array.toHex(decodedBlock[9]), // safe type: uint8 -> hex
                Txs: []
            };

            for (let i = 0; i < decodedBlock[10].length; i++) {
                blockData.Txs.push(serializer.transaction.fromBinary_v2(decodedBlock[10][i]));
            }

            return blockData;
        },
        /** @param {BlockData} blockData */
        toBinary_v3(blockData) {
            const blockAsArray = serializer.blockHeader_finalized.toBinary_v3(blockData, false);
            const Txs = serializer.array_of_transactions.toBinary_v3(blockData.Txs, false);
            blockAsArray.push(Txs);

            //console.log('Block finalized serialization time:', Date.now() - startTimestamp, 'ms');
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            //console.log('Block finalized serialization+msgpack time:', Date.now() - startTimestamp, 'ms');
            //console.log('Block finalized serialization+msgpack size:', encoded.length, 'bytes');
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v3(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = serializer.blockHeader_finalized.fromBinary_v3(decodedBlock, false);
            blockData.Txs = serializer.array_of_transactions.fromBinary_v3(decodedBlock[10], false);

            return blockData;
        },
        /** @param {BlockData} blockData */
        toBinary_v4(blockData) {
            const blockAsArray = serializer.blockHeader_finalized.toBinary_v3(blockData, false);
            const Txs = serializer.array_of_transactions.toBinary_v4(blockData.Txs, false);
            blockAsArray.push(Txs);

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v4(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = serializer.blockHeader_finalized.fromBinary_v3(decodedBlock, false);
            blockData.Txs = serializer.array_of_transactions.fromBinary_v4(decodedBlock[10], false);

            return blockData;
        }
    },
    blockHeader_finalized: {
        /** @param {BlockData} blockData */
        toBinary_v3(blockData, applyMsgPack = true) {
            const blockHeaderAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.timestamp), // safe type: number
                convert.hex.toUint8Array(blockData.hash), // safe type: hex
                convert.hex.toUint8Array(blockData.nonce) // safe type: hex
            ];

            if (!applyMsgPack) { return blockHeaderAsArray; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockHeaderAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlockHeader */
        fromBinary_v3(encodedBlockHeader, applyMsgPack = true) {
            const decodedBlockHeader = applyMsgPack ? msgpack.decode(encodedBlockHeader) : encodedBlockHeader;
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlockHeader[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlockHeader[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlockHeader[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlockHeader[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlockHeader[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlockHeader[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlockHeader[6]), // safe type: uint8 -> number
                timestamp: convert.uint8Array.toNumber(decodedBlockHeader[7]), // safe type: uint8 -> number
                hash: convert.uint8Array.toHex(decodedBlockHeader[8]), // safe type: uint8 -> hex
                nonce: convert.uint8Array.toHex(decodedBlockHeader[9]) // safe type: uint8 -> hex
            };

            return blockData;
        }
    },
};
/**
 * Theses functions are used to convert data between different formats.
 * 
 * - functions do not check the input data.
 * - Make sure to validate the data before using these functions.
 */
export const serializerFast = {
    serialize: {
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
        witnessesArray(witnesses) {
            const witnessesBuffer = new ArrayBuffer(96 * witnesses.length); // (sig + pubKey) * nb of witnesses
            const witnessesBufferView = new Uint8Array(witnessesBuffer);
            for (let i = 0; i < witnesses.length; i++) {
                const witness = fastConverter.hexToUint8Array(witnesses[i].replace(':', ''));
                witnessesBufferView.set(witness, i * 96);
            }
            return witnessesBufferView;
        },
        specialTransation: {
            
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

        /** @param {BlockData} blockData */
        blockHeader_finalized(blockData) {
            try {
                const elementsLenght = {
                    indexBytes: 4,
                    supplyBytes: 8,
                    coinBaseBytes: 4,
                    difficultyBytes: 4,
                    legitimacyBytes: 2,
                    prevHashBytes: 32,
                    posTimestampBytes: 4,
                    timestampBytes: 4,
                    hashBytes: 32,
                    nonceBytes: 4
                }
                
                const serializedHeader = new ArrayBuffer();
                /*const blockHeaderAsArray = [
                    convert.number.toUint8Array(blockData.index), // safe type: number
                    convert.number.toUint8Array(blockData.supply), // safe type: number
                    convert.number.toUint8Array(blockData.coinBase), // safe type: number
                    convert.number.toUint8Array(blockData.difficulty), // safe type: number
                    convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                    convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                    convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                    convert.number.toUint8Array(blockData.timestamp), // safe type: number
                    convert.hex.toUint8Array(blockData.hash), // safe type: hex
                    convert.hex.toUint8Array(blockData.nonce) // safe type: hex
                ];*/
                
            } catch (error) {
                
            }
        }
    },
    deserialize: {
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
        /** @param {Uint8Array} serializedPubkeyAddresses */
        pubkeyAddressesObj(serializedPubkeyAddresses) {
            const pubkeyAddresses = {};
            for (let i = 0; i < serializedPubkeyAddresses.byteLength; i += 48) {
                const pubKey = fastConverter.uint8ArrayToHex(serializedPubkeyAddresses.slice(i, i + 32)); // 48 + 32 = 80
                const address = fastConverter.addressUint8ArrayToBase58(serializedPubkeyAddresses.slice(i + 32, i + 48));
                pubkeyAddresses[pubKey] = address;
            }
            return pubkeyAddresses;
        }
    }
};