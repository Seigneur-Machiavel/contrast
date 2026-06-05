// @ts-check
import { HashFunctions } from "./conCrypto.mjs";
import { ADDRESS } from '../../types/address.mjs';
import { VssStorage } from "../../storage/vss-store.mjs";
import { TransactionReader } from '../../types/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from "../../config/blockchain-settings.mjs";
import { SIZES, serializer, BinaryReader } from "../../utils/serializer.mjs";

/**
 * @typedef {import('./blockchain.mjs').Blockchain} Blockchain
 * @typedef {import('../../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import('../../storage/storage.mjs').ContrastStorage} ContrastStorage */

class RoundLegitimacies {
	/** @type {string[]} */				owners = [];
	/** @type {Array<Set<string>>} */	legitimacies = [];

	/** @param {Set<string>} addresses */
	addAddresses(addresses) {
		this.legitimacies.push(addresses);
	}
	/** Returns best legitimacy of address for the round, if not found: return undefined @param {string} address */
	getAddressLegitimacy(address) {
		for (let i = 0; i < this.legitimacies.length; i++)
			if (this.legitimacies[i].has(address)) return i;
	}
}

/** Validator Selection Spectrum (VSS) */
export class Vss {
	/** @type {Map<string, RoundLegitimacies>} BlockHash: RoundLegitimacies */
	blockLegitimaciesByAddress = new Map();
	maxCacheLength = 100;
	vssStorage;
	blockchain;

	/** @param {Blockchain} blockchain @param {ContrastStorage} storage */
	constructor(blockchain, storage) {
		this.vssStorage = new VssStorage(storage);
		this.blockchain = blockchain;
	}

	// PUBLIC API
	/** @param {BlockFinalized} block @param {'control' | 'persist'} mode default 'control' */
	digestBlockStakes(block, mode = 'control') {
		const newStakeAnchors = this.#extractBlockStakes(block);
		const upperBound = this.vssStorage.stakesCount * BLOCKCHAIN_SETTINGS.stakeAmount;
		const newUpperBound = upperBound + (newStakeAnchors.length * BLOCKCHAIN_SETTINGS.stakeAmount);
		if (newUpperBound > BLOCKCHAIN_SETTINGS.maxSupply / 2) throw new Error(`VSS stake limit exceeded in block #${block.index}`);
		if (!this.vssStorage.hasStakes(newStakeAnchors).allMissing) throw new Error(`VSS stake already exists in block #${block.index}`);
		if (mode !== 'persist') return;

		for (const anchor of newStakeAnchors) this.vssStorage.addStake(anchor);
	}
	/** @param {BlockFinalized} block */
	revertBlockStakes(block) {
		const newStakeAnchors = this.#extractBlockStakes(block);
		if (newStakeAnchors.length) this.vssStorage.removeStakes(newStakeAnchors);
	}
	/** @param {BlockFinalized} block */
	hasBlockStakes(block) {
		const newStakeAnchors = this.#extractBlockStakes(block);
		return this.vssStorage.hasStakes(newStakeAnchors);
	}
	/** Returns best legitimacy of pubkey for the round, if not found: return last index + 1 (= array length) @param {string} address @param {string} prevHash */
	async getAddressLegitimacy(address, prevHash) {
		const round = await this.#calculateRound(prevHash);
		const walletId = ADDRESS.getAddressRoot(address).walletId;
		const bestLeg = round.getAddressLegitimacy(walletId);
		return bestLeg !== undefined ? bestLeg : round.legitimacies.length;
	}
	/** Return the worse legitimacy (highest number) for the round, if no stakes: return 0 @param {string} prevHash */
	async getWorseLegitimacy(prevHash) {
		const round = await this.#calculateRound(prevHash);
		return round.legitimacies.length;
	}
	/** @param {string} blockHash */
	getRoundForExplorerIfExists(blockHash) {
		const round = this.blockLegitimaciesByAddress.get(blockHash);
		if (!round) return null;
		else return round.owners.map((owner, index) => ({ address: owner, authorizedAddresses: round.legitimacies[index] }));
	}
	reset() {
		this.vssStorage.reset();
		this.blockLegitimaciesByAddress.clear();
	}

	// INTERNAL METHODS
	/** @param {BlockFinalized} block */
	#extractBlockStakes(block) {
		const newStakeAnchors = [];
		for (let txId = 2; txId < block.Txs.length; txId++) // skip coinbase and pos fee Txs
			for (let voudId = 0; voudId < block.Txs[txId].outputs.length; voudId++) {
				const { address, amount, rule } = block.Txs[txId].outputs[voudId];
				if (rule !== "sigOrSlash") continue;
				if (amount !== BLOCKCHAIN_SETTINGS.stakeAmount) throw new Error(`Invalid stake amount in block #${block.index}, Tx #${txId}, Vout #${voudId}`);
				newStakeAnchors.push(`${block.index}:${txId}:${voudId}`);
			}
		
		return newStakeAnchors;
	}
	/** @param {string} blockHash @param {number} [maxTry] Uint8 (max: 255) */
	async #calculateRound(blockHash, maxTry = 255) {
		if (maxTry > 255) throw new Error('maxTry > 255!!');

		const existing = this.blockLegitimaciesByAddress.get(blockHash);
		if (existing) return existing; // already calculated
		
		const legitimacies = new RoundLegitimacies();
		const maxRange = this.vssStorage.stakesCount;
		if (maxRange < BLOCKCHAIN_SETTINGS.validatorsPerRound) { // not enough stakes => empty round
			this.blockLegitimaciesByAddress.set(blockHash, legitimacies);
			return legitimacies;
		}
		
		let leg = 0;
		const blockHashBytes = serializer.converter.stringToBytes(blockHash);
		for (let i = 0; i < maxTry; i++) {
			blockHashBytes[0] = i; // SHA512 mod maxRange: bias exists but negligible (2^512 >> maxRange)
			const hash = HashFunctions.SHA512(blockHashBytes).hashHex;
			const winningNumber = Number(BigInt('0x' + hash) % BigInt(maxRange));
			const roundAuth = this.#getStakeAuthorizations(winningNumber);
			if (!roundAuth?.authorizedAddresses || roundAuth.authorizedAddresses.size === 0) {
				console.warn(`[VSS] No authorized addresses for winning number: ${winningNumber}`);
				continue;
			}

			legitimacies.addAddresses(roundAuth.authorizedAddresses);
			legitimacies.owners.push(roundAuth.owner);
			leg++;

			if (leg >= this.vssStorage.stakesCount) break; // all stakes selected
			if (leg >= BLOCKCHAIN_SETTINGS.validatorsPerRound) break; // round is full
		}

		// maxTry safety triggered: should never happen in normal operation
		if (leg < BLOCKCHAIN_SETTINGS.validatorsPerRound && maxRange >= BLOCKCHAIN_SETTINGS.validatorsPerRound)
			console.warn(`[VSS] Round incomplete: only ${leg}/${BLOCKCHAIN_SETTINGS.validatorsPerRound} validators selected after ${maxTry} iterations (blockHash: ${blockHash})`);

		this.blockLegitimaciesByAddress.set(blockHash, legitimacies);
		this.#pruneCache();
		return legitimacies;
	}
	/** @param {number} index */
	#getStakeAuthorizations(index) {
		const anchor = this.vssStorage.getStakeAnchor(index);
		if (!anchor) return null;

		const utxo = this.blockchain.getUtxo(anchor);
		if (!utxo?.address || utxo.spent) throw new Error(`Stake UTXO is missing or spent for anchor: ${anchor}`);

		const { height, txIndex, vout } = serializer.parseAnchor(anchor);
		const serializedTx = this.blockchain.blockStorage.getSerializedTransactions(height, [txIndex])?.txsBytes[txIndex];
		if (!serializedTx) throw new Error(`Unable to retrieve transaction for anchor: ${anchor}`);

		/** @type {Set<string>} */
		const authorizedAddresses = new Set();
		const mode = txIndex === 0 ? 'solver' : txIndex === 1 ? 'validator' : 'tx';
		const txReader = new TransactionReader(serializedTx, mode);
		const dataSize = txReader.setCursorStartOf('data');
		for (let i = 0; i < dataSize; i += SIZES.address.bytes)
			authorizedAddresses.add(ADDRESS.bytesToAddress(txReader.r.read(SIZES.address.bytes)));
		if (!txReader.r.isReadingComplete) throw new Error(`Failed to read all authorized addresses for anchor: ${anchor}`);
		return { authorizedAddresses, owner: utxo.address };
	}
	#pruneCache() {
		const toRemove = this.blockLegitimaciesByAddress.size - this.maxCacheLength;
		if (toRemove <= 0) return;

		const keys = Array.from(this.blockLegitimaciesByAddress.keys());
		for (let i = 0; i < toRemove; i++) this.blockLegitimaciesByAddress.delete(keys[i]);
	}
}