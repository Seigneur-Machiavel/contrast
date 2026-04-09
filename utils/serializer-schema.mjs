// @ts-check
import { ADDRESS } from '../types/address.mjs';

/** List of lengths for the different values, Each entry has the following format:
 * 
 * - bytes: The lengths in bytes of the value when serialized
 * - str: The lengths in characters of the value (if applicable, otherwise null) */
export const SIZES = {
	// GENERAL
	pointer16: { bytes: 2, str: null }, // A pointer is an offset in the serialized buffer, represented as 2 bytes, allowing to point up to 64KB of data.
	pointer32: { bytes: 4, str: null }, // A pointer is an offset in the serialized buffer, represented as 4 bytes, allowing to point up to 4GB of data.
	
	/** Amount, represented as 6 bytes, allowing to represent up to 281 trillion tokens */
	amount: { bytes: 6, str: null },
	/** Timestamp, represented as 6 bytes, allowing to represent up to the year 2106 */
	timestamp: { bytes: 6, str: null },

	// CRYPTO/IDENTITY
	/** 32 bits public key hash(xxHash32), represented as 4 bytes or 8 hex characters */
	pubKeyHash: { bytes: 4, str: 8 },
	/** Address, represented as a string of 7 characters or 5 bytes | ex: C123456 */
	address: { bytes: ADDRESS.CRITERIA.TOTAL_BYTES, str: ADDRESS.CRITERIA.TOTAL_LENGTH },

	// TRANSACTION
	/** Transaction header, represented as 12 bytes, containing: version(2) + witnessesCount(2) + identitiesCount(2) + inputsCount(2) + outputsCount(2) + dataLength(2) */
	txHeader: { bytes: 2 + 2 + 2 + 2 + 2 + 2, str: null },
	/** Anchor, represented as 8 bytes, containing: height(4) + txIndex(2) + vout(2) */
	anchor: { bytes: 8, str: null },
	/** Transaction ID, represented as 6 bytes, containing: height(4) + txIndex(2) */
	txId: { bytes: 6, str: null },
	/** UTXO state, represented as 5 bytes, containing: txIndex(2) + vout(2) + state(1) */
	utxoState: { bytes: 5, str: null },
	/** Mini UTXO, represented as 12 bytes, containing: address(5) + amount(6) + rule(1) */
	miniUTXO: { bytes: ADDRESS.CRITERIA.TOTAL_BYTES + 6 + 1, str: null },
	/** Validator input, represented as 37 bytes, containing: validatorAddress(5) + hash(32)
	 * - As string: <5 chars for address + : + 32 chars for hash in hex> */
	validatorInput: { bytes: ADDRESS.CRITERIA.TOTAL_BYTES + 32, str: ADDRESS.CRITERIA.TOTAL_LENGTH + 1 + 64 },

	// LEDGERS
	/** Ledger UTXO, represented as 15 bytes, containing: height(4) + txIndex(2) + vout(2) + amount(6) + rule(1) */
	ledgerUtxo: { bytes: 4 + 2 + 2 + 6 + 1, str: null },

	// BLOCK VALUES
	/** Block candidate header, represented as 60 bytes, containing: nbOfTxs(2) + index(4) + supply(6) + coinBase(4) + difficulty(4) + legitimacy(2) + prevHash(32) + posTimestamp(6) + powReward(6) */
	blockCandidateHeader: { bytes: 2 + 4 + 6 + 4 + 4 + 2 + 32 + 6 + 6, str: null },
	/** Block finalized header, represented as 96 bytes, containing: nbOfTxs(2) + index(4) + supply(6) + coinBase(4) + difficulty(4) + legitimacy(2) + prevHash(32) + posTimestamp(6) + timestamp(6) + hash(32) + nonce(4) */
	blockFinalizedHeader: { bytes: 2 + 4 + 6 + 4 + 4 + 2 + 32 + 6 + 6 + 32 + 4, str: null },
	/** Hash, represented as 32 bytes or 64 hex characters */
	hash: { bytes: 32, str: 64 },
	/** Nonce, represented as 4 bytes or 8 hex characters */
	nonce: { bytes: 4, str: 8 },

	// BLOCK INDEX ENTRY
	/** Start entry, represented as 6 bytes, containing: height(4) + txIndex(2) */
	startEntry: { bytes: 6, str: null },
	/** Block bytes entry, represented as 4 bytes, containing: blockBytesLen(4) */
	blockBytesEntry: { bytes: 4, str: null },
	/** UTXO states bytes entry, represented as 2 bytes, containing: utxosStatesBytesLen(2) */
	utxosStatesBytesEntry: { bytes: 2, str: null },
	/** Index entry, represented as 12 bytes, containing: start(6) + blockBytesLen(4) + utxosStatesBytesLen(2) */
	indexEntry: { bytes: 12, str: null },
};