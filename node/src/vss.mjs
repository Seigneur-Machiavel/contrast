// @ts-check
import { HashFunctions } from "./conCrypto.mjs";
import { VssStorage } from "../../storage/vss-store.mjs";
import { BLOCKCHAIN_SETTINGS } from "../../utils/blockchain-settings.mjs";
import { serializer } from "../../utils/serializer.mjs";

/**
 * @typedef {import('../../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import('./blockchain.mjs').Blockchain} Blockchain
 * @typedef {import('../../storage/storage.mjs').ContrastStorage} ContrastStorage
 */

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
	/** @type {Map<string, RoundLegitimacies>} BlockHash: RoundLegitimacies */
	blockLegitimaciesByAddress = new Map();
    currentRoundHash = '';
	maxCacheLenght = 100;
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

		for (const anchor of newStakeAnchors) this.vssStorage.addStake(anchor);
    }
	/** @param {BlockFinalized} block */
	undoBlockStakes(block) {
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
		if (pubkey.length !== serializer.lengths.pubKey.str) throw new Error('Invalid pubkey length');
		const legs = await this.#calculateRoundLegitimacies(prevHash);
		const bestLeg = legs.getPubkeyBestLegitimacy(pubkey);
		return bestLeg !== undefined ? bestLeg : legs.legitimacies.length;
	}
	reset() {
		this.vssStorage.reset();
		this.blockLegitimaciesByAddress.clear();
		this.currentRoundHash = '';
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

		const utxos = this.blockchain.getUtxos([anchor], true);
		const utxo = utxos?.[anchor];;
		if (!utxo?.address || utxo.spent) throw new Error(`Stake UTXO is missing or spent for anchor: ${anchor}`);

		const { height, txIndex, vout } = serializer.parseAnchor(anchor);
		const tx = this.blockchain.blockStorage.getTransaction(`${height}:${txIndex}`);
		if (!tx) throw new Error(`Stake transaction not found for anchor: ${anchor}`);
		if (!tx.data || tx.data.length % 32 !== 0) throw new Error(`Invalid stake transaction data for anchor: ${anchor}`);

		/** @type {Set<string>} */
		const authorizedPubkeys = new Set();
		const hex = serializer.converter.bytesToHex(tx.data);
		for (let i = 0; i < hex.length; i += 64) authorizedPubkeys.add(hex.slice(i, i + 64));
		return authorizedPubkeys;
	}
    /** @param {string} blockHash @param {number} [maxTry] */
    async #calculateRoundLegitimacies(blockHash, maxTry = 100) {
		const existing = this.blockLegitimaciesByAddress.get(blockHash);
		if (existing) return existing; // already calculated
        
		// everyone has considered 0 legitimacy when not enough stakes
        const startTimestamp = Date.now();
		const roundLegitimacies = new RoundLegitimacies();
		const maxRange = this.vssStorage.stakesCount;
        if (maxRange < BLOCKCHAIN_SETTINGS.validatorsPerRound) // no calculation needed => set empty and return
			{ this.blockLegitimaciesByAddress.set(blockHash, roundLegitimacies); return roundLegitimacies; }

		let [ leg, i ] = [ 0, 0 ];
        for (i; i < maxTry; i++) {
			const hash = await HashFunctions.SHA256(`${i}${blockHash}`);
            const winningNumber = Number(BigInt('0x' + hash) % BigInt(maxRange)); // Calculate the maximum acceptable range to avoid bias
			const authorizedPubkeys = this.#getStakeAuthorizations(winningNumber);
			if (!authorizedPubkeys || authorizedPubkeys.size === 0) { console.error(`[VSS] No authorized pubkeys for winning number: ${winningNumber}`); continue; }

            roundLegitimacies.addPubkeys(authorizedPubkeys);
            leg++;

            if (leg >= this.vssStorage.stakesCount) break; // If all stakes have been selected
            if (leg >= BLOCKCHAIN_SETTINGS.validatorsPerRound) break; // If the array is full
        }

        //console.log(`[VSS] -- Calculated round legitimacies in ${((Date.now() - startTimestamp)/1000).toFixed(2)}s. | ${i} iterations. -->`);
        //console.info(roundLegitimacies);
        this.blockLegitimaciesByAddress.set(blockHash, roundLegitimacies);
		this.#pruneCache();
		return roundLegitimacies;
    }
	#pruneCache() {
		const toRemove = this.blockLegitimaciesByAddress.size - this.maxCacheLenght;
		if (toRemove <= 0) return;

		const keys = Array.from(this.blockLegitimaciesByAddress.keys());
		for (let i = 0; i < toRemove; i++) this.blockLegitimaciesByAddress.delete(keys[i]);
	}
}