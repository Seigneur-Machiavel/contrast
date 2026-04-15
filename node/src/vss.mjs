// @ts-check
import { HashFunctions } from "./conCrypto.mjs";
import { VssStorage } from "../../storage/vss-store.mjs";
import { BLOCKCHAIN_SETTINGS } from "../../config/blockchain-settings.mjs";
import { serializer, BinaryReader } from "../../utils/serializer.mjs";

/**
 * @typedef {import('./blockchain.mjs').Blockchain} Blockchain
 * @typedef {import('../../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import('../../storage/storage.mjs').ContrastStorage} ContrastStorage */

class RoundLegitimacies {
	/** @type {Array<Set<string>>} */	legitimacies = [];

	/** @param {Set<string>} pubkeys */
	addPubkeys(pubkeys) {
		this.legitimacies.push(pubkeys);
	}
	/** Returns best legitimacy of pubkey for the round, if not found: return undefined @param {string} pubkey */
	getPubkeyBestLegitimacy(pubkey) {
		for (let i = 0; i < this.legitimacies.length; i++)
			if (this.legitimacies[i].has(pubkey)) return i;
	}
}

/** Validator Selection Spectrum (VSS) */
export class Vss {
	/** @type {Map<string, {legitimacies: RoundLegitimacies, owners: string[]}>} BlockHash: RoundLegitimacies */
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
		if (mode !== 'persist') return;

		for (const anchor of newStakeAnchors)
			if (this.vssStorage.hasStakes([anchor])) continue; // Guard against double-add (e.g. re-sync or fork switch) | verify if check cost is acceptable.
			else this.vssStorage.addStake(anchor);
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
	/** Returns best legitimacy of pubkey for the round, if not found: return last index + 1 (= array length) @param {string} pubkey @param {string} prevHash */
	async getPubkeyLegitimacy(pubkey, prevHash) {
		const round = await this.#calculateRound(prevHash);
		const bestLeg = round.legitimacies.getPubkeyBestLegitimacy(pubkey);
		return bestLeg !== undefined ? bestLeg : round.legitimacies.legitimacies.length;
	}
	/** Return the worse legitimacy (highest number) for the round, if no stakes: return 0 @param {string} prevHash */
	async getWorseLegitimacy(prevHash) {
		const round = await this.#calculateRound(prevHash);
		return round.legitimacies.legitimacies.length;
	}
	/** @param {string} blockHash */
	getRoundForExplorerIfExists(blockHash) {
		const round = this.blockLegitimaciesByAddress.get(blockHash);
		if (!round) return null;

		/** @type {Array<{address: string, pubkeys: Set<string>}>} */ const result = [];
		for (let i = 0; i < round.legitimacies.legitimacies.length; i++)
			result.push({ address: round.owners[i], pubkeys: round.legitimacies.legitimacies[i] });
		return result;
	}
	reset() {
		this.vssStorage.reset();
		this.blockLegitimaciesByAddress.clear();
	}

	// INTERNAL METHODS
	/** @param {BlockFinalized} block @returns {string[]} */
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
	/** @param {number} index */
	#getStakeAuthorizations(index) {
		const anchor = this.vssStorage.getStakeAnchor(index);
		if (!anchor) return null;

		const utxo = this.blockchain.getUtxo(anchor);
		if (!utxo?.address || utxo.spent) throw new Error(`Stake UTXO is missing or spent for anchor: ${anchor}`);

		const { height, txIndex, vout } = serializer.parseAnchor(anchor);
		const data = this.blockchain.blockStorage.getTransactionData(height, txIndex);
		if (!data) throw new Error(`Unable to retrieve transaction data for anchor: ${anchor}`);

		try {
			/** @type {Set<string>} */
			const authorizedPubkeys = new Set();
			const r = new BinaryReader(data);
			const pubKeys = r.readPointersAndExtractDataChunks();
			for (const pkBytes of pubKeys) authorizedPubkeys.add(serializer.converter.bytesToHex(pkBytes));
			return { authorizedPubkeys, owner: utxo.address };
		} catch (error) {
			console.error(`Failed to extract pubkeys for anchor: ${anchor} | error: ${error}`);
			throw new Error(`Failed to extract pubkeys for anchor: ${anchor}`);
		}
	}
	/** @param {string} blockHash @param {number} [maxTry] */
	async #calculateRound(blockHash, maxTry = 100) {
		const existing = this.blockLegitimaciesByAddress.get(blockHash);
		if (existing) return existing; // already calculated

		/** @type {string[]} */ const owners = [];
		const legitimacies = new RoundLegitimacies();
		const maxRange = this.vssStorage.stakesCount;
		if (maxRange < BLOCKCHAIN_SETTINGS.validatorsPerRound) // not enough stakes => empty round
			{ this.blockLegitimaciesByAddress.set(blockHash, { legitimacies, owners }); return { legitimacies, owners }; }

		let leg = 0;
		for (let i = 0; i < maxTry; i++) {
			const hash = HashFunctions.SHA512(`${i}${blockHash}`).hashHex;
			// SHA512 mod maxRange: bias exists but negligible (2^512 >> maxRange)
			const winningNumber = Number(BigInt('0x' + hash) % BigInt(maxRange));
			const roundAuth = this.#getStakeAuthorizations(winningNumber);
			if (!roundAuth?.authorizedPubkeys || roundAuth.authorizedPubkeys.size === 0) {
				console.warn(`[VSS] No authorized pubkeys for winning number: ${winningNumber}`);
				continue;
			}

			legitimacies.addPubkeys(roundAuth.authorizedPubkeys);
			owners.push(roundAuth.owner);
			leg++;

			if (leg >= this.vssStorage.stakesCount) break; // all stakes selected
			if (leg >= BLOCKCHAIN_SETTINGS.validatorsPerRound) break; // round is full
		}

		// maxTry safety triggered: should never happen in normal operation
		if (leg < BLOCKCHAIN_SETTINGS.validatorsPerRound && maxRange >= BLOCKCHAIN_SETTINGS.validatorsPerRound)
			console.warn(`[VSS] Round incomplete: only ${leg}/${BLOCKCHAIN_SETTINGS.validatorsPerRound} validators selected after ${maxTry} iterations (blockHash: ${blockHash})`);

		this.blockLegitimaciesByAddress.set(blockHash, { legitimacies, owners });
		this.#pruneCache();
		return { legitimacies, owners };
	}
	#pruneCache() {
		const toRemove = this.blockLegitimaciesByAddress.size - this.maxCacheLength;
		if (toRemove <= 0) return;

		const keys = Array.from(this.blockLegitimaciesByAddress.keys());
		for (let i = 0; i < toRemove; i++) this.blockLegitimaciesByAddress.delete(keys[i]);
	}
}