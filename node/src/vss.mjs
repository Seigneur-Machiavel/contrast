import { BLOCKCHAIN_SETTINGS } from "../../utils/blockchain-settings.mjs";
import { HashFunctions } from "./conCrypto.mjs";

/**
 * @typedef {Object} StakeReference
 * @property {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
 * @property {string} anchor - Example: "0:bdadb7ab:0"
 * @property {number} amount - Example: 100
 * 
 * @typedef {Object<string, StakeReference | undefined>} Spectrum
 */

export class spectrumFunctions {
    /** @param {Spectrum} spectrum */
    static getHighestUpperBound(spectrum) {
        const keys = Object.keys(spectrum);
        if (keys.length === 0) { return 0; }

        // just return the last key
        return parseInt(keys[keys.length - 1]);
    }
    /** @param {Spectrum} spectrum @param {number} index - The index to search*/
    static getStakeReferenceFromIndex(spectrum, index) {
        const keys = Object.keys(spectrum);
        if (keys.length === 0) { return undefined; }

        keys.sort((a, b) => parseInt(a) - parseInt(b));
        
        for (let i = 0; i < keys.length; i++) {
            const key = parseInt(keys[i]);
            if (key >= index) {
                return spectrum[key];
            }
        }

        return undefined;
    }
}

export class Vss {
    /** Validator Selection Spectrum (VSS)
     * - Can search key by number (will be converted to string).
     * @example { '1_000_000': { address: 'WCHMD65Q7qR2uH9XF5dJ', anchor: '0:bdadb7ab:0' } }
     * @type {Spectrum} */
    spectrum = {};
    /** @type {StakeReference[]} */
    legitimacies = []; // the order of the stakes in the array is the order of legitimacy
    /** @type {Object<string, Object<string, number>>} */
    blockLegitimaciesByAddress = {}; // { 'WCHMD65Q7qR2uH9XF5dJ': 0 }
    maxLegitimacyToBroadcast = 27; // node should not broadcast block if not in the top 27
    currentRoundHash = '';

    /** @param {import("../../types/transaction.mjs").UTXO[]} utxos @param {'control' | 'persist'} mode default 'control' */
    newStakes(utxos, mode = 'control') {
        let upperBound = spectrumFunctions.getHighestUpperBound(this.spectrum);
        for (const utxo of utxos) {
			const { address, anchor, amount } = utxo;
            upperBound += amount;
            if (upperBound > BLOCKCHAIN_SETTINGS.maxSupply) return false;
			if (mode === 'control') continue;
            this.spectrum[upperBound] = { address, anchor, amount };
        }
		return true;
    }
    /** @param {string} blockHash @param {number} [maxResultingArrayLength] @param {number} [maxTry] */
    async calculateRoundLegitimacies(blockHash, maxResultingArrayLength = 27, maxTry = 100) {
        if (this.blockLegitimaciesByAddress[blockHash])
            return this.blockLegitimaciesByAddress[blockHash]; // already calculated
        
		// everyone has considered 0 legitimacy when not enough stakes
        const startTimestamp = Date.now();
        const maxRange = spectrumFunctions.getHighestUpperBound(this.spectrum);
        if (maxRange < 999_999) { this.blockLegitimaciesByAddress[blockHash] = []; return; } // no calculation needed
        
        /** @type {Object<string, number>} */
        const roundLegitimacies = {};
        const spectrumLength = Object.keys(this.spectrum).length;
        
        let leg = 0;
        let i = 0;
        for (i; i < maxTry; i++) {
			const hash = await HashFunctions.SHA256(`${i}${blockHash}`);
            const winningNumber = Number(BigInt('0x' + hash) % BigInt(maxRange)); // Calculate the maximum acceptable range to avoid bias
			const stakeReference = spectrumFunctions.getStakeReferenceFromIndex(this.spectrum, winningNumber);
            if (!stakeReference) { console.error(`[VSS] Stake not found for winning number: ${winningNumber}`); continue; }
            if (stakeReference.address < BLOCKCHAIN_SETTINGS.minStakeAmount) continue; // if stakeReference is less than minStakeAmount, skip it

            // if stakeReference already in roundLegitimacies, try again
            if (roundLegitimacies[stakeReference.address] !== undefined) continue;
            roundLegitimacies[stakeReference.address] = leg;
            leg++;

            if (leg >= spectrumLength) break; // If all stakes have been selected
            if (leg >= maxResultingArrayLength) break; // If the array is full
        }

        //console.log(`[VSS] -- Calculated round legitimacies in ${((Date.now() - startTimestamp)/1000).toFixed(2)}s. | ${i} iterations. -->`);
        //console.info(roundLegitimacies);
        
        this.blockLegitimaciesByAddress[blockHash] = roundLegitimacies;
		const keys = Object.keys(this.blockLegitimaciesByAddress);
        const toRemove = keys.length - 10;
        if (toRemove > 0)
            for (let i = 0; i < toRemove; i++) delete this.blockLegitimaciesByAddress[keys[i]];
        return roundLegitimacies;
    }
    /** If not found: return last index + 1 (= array length) @param {string} address @param {string} prevHash */
    async getAddressLegitimacy(address, prevHash) {
        const legitimacies = this.blockLegitimaciesByAddress[prevHash] || await this.calculateRoundLegitimacies(prevHash);
        if (!legitimacies) return 0;
        else return legitimacies[address] !== undefined ? legitimacies[address] : Object.keys(legitimacies).length;
    }
    getAddressStakesInfo(address) {
        const references = [];
		for (const key in this.spectrum)
            if (this.spectrum[key].address === address) references.push(this.spectrum[key]);
        return references;
    }
}