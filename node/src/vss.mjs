import { BLOCKCHAIN_SETTINGS } from "../../utils/blockchain-settings.mjs";
import { HashFunctions } from "./conCrypto.mjs";
import { UTXO } from "./transaction.mjs";

/**
 * @typedef {Object} StakeReference
 * @property {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
 * @property {string} anchor - Example: "0:bdadb7ab:0"
 * @property {number} amount - Example: 100
 * 
 * @typedef {Object<string, StakeReference | undefined>} Spectrum
 */

/**
 * @param {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
 * @param {string} anchor - Example: "0:bdadb7ab:0"
 * @param {number} amount - Example: 100
 * @returns {VssRange}
 */
export const StakeReference = (address, anchor, amount) => {
    return { address, anchor, amount };
}

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
    /** Will return a number between 0 and maxRange from a blockHash - makes sure the result is unbiased */
    static async hashToIntWithRejection(blockHash, lotteryRound = 0, maxRange = 1000000, maxAttempts = 1000) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Generate a hash including the nonce to get different results if needed
            const hash = await HashFunctions.SHA256(`${lotteryRound}${blockHash}`);
            const hashInt = BigInt('0x' + hash);
    
            return Number(hashInt % BigInt(maxRange)); // Calculate the maximum acceptable range to avoid bias
        }
    
        throw new Error("Max attempts reached. Consider increasing maxAttempts or revising the method.");
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
    currentRoundHash = '';
    maxLegitimacyToBroadcast = 27; // node should not broadcast block if not in the top 27

    /** @param {number} maxSupply - The maximum supply value to be used in the VSS. */
    constructor(maxSupply) {
        /** @type {number} */
        this.maxSupply = maxSupply; // Store the maxSupply passed in the constructor
    }
    /** @param {UTXO[]} utxos */
    newStakesCanBeAdded(utxos) {
        let upperBound = spectrumFunctions.getHighestUpperBound(this.spectrum);
        for (const utxo of utxos) {
            const updatedUpperBond = upperBound + utxo.amount;
            if (updatedUpperBond > this.maxSupply) return false;
            upperBound = updatedUpperBond;
        }
        return true;
    }
    /** @param {UTXO[]} utxos */
    newStakes(utxos) {
        let upperBound = spectrumFunctions.getHighestUpperBound(this.spectrum);
        for (const utxo of utxos) {
            const address = utxo.address;
            const anchor = utxo.anchor;
            const amount = utxo.amount;
            
            const updatedUpperBond = upperBound + amount;
            if (updatedUpperBond > this.maxSupply) throw new Error('VSS: Max supply reached.');
            this.spectrum[updatedUpperBond] = StakeReference(address, anchor, amount);
    
            upperBound = updatedUpperBond;
        }
    }
    /** @param {string} blockHash @param {number} [maxResultingArrayLength] @param {number} [maxTry] */
    async calculateRoundLegitimacies(blockHash, maxResultingArrayLength = 27, maxTry = 100) {
        if (this.blockLegitimaciesByAddress[blockHash])
            return this.blockLegitimaciesByAddress[blockHash]; // already calculated
        
        const startTimestamp = Date.now();
        // everyone has considered 0 legitimacy when not enough stakes
        const maxRange = spectrumFunctions.getHighestUpperBound(this.spectrum);
        if (maxRange < 999_999) { this.blockLegitimaciesByAddress[blockHash] = []; return; } // no calculation needed
        
        /** @type {Object<string, number>} */
        const roundLegitimacies = {};
        const spectrumLength = Object.keys(this.spectrum).length;
        
        let leg = 0;
        let i = 0;
        for (i; i < maxTry; i++) {
            const winningNumber = await spectrumFunctions.hashToIntWithRejection(blockHash, i, maxRange);
            const stakeReference = spectrumFunctions.getStakeReferenceFromIndex(this.spectrum, winningNumber);
            if (!stakeReference) { console.error(`[VSS] Stake not found for winning number: ${winningNumber}`); continue; }
            if (stakeReference.address < BLOCKCHAIN_SETTINGS.minStakeAmount) continue; // if stakeReference is less than minStakeAmount, skip it

            // if stakeReference already in roundLegitimacies, try again
            if (roundLegitimacies[stakeReference.address] !== undefined) continue;
            
            //roundLegitimacies.push(stakeReference);
            roundLegitimacies[stakeReference.address] = leg;
            leg++;

            if (leg >= spectrumLength) break; // If all stakes have been selected
            if (leg >= maxResultingArrayLength) break; // If the array is full
        }

        //console.log(`[VSS] -- Calculated round legitimacies in ${((Date.now() - startTimestamp)/1000).toFixed(2)}s. | ${i} iterations. -->`);
        //console.info(roundLegitimacies);
        
        this.blockLegitimaciesByAddress[blockHash] = roundLegitimacies;
        const toRemove = Object.keys(this.blockLegitimaciesByAddress).length - 10;
        if (toRemove > 0) {
            const keys = Object.keys(this.blockLegitimaciesByAddress);
            for (let i = 0; i < toRemove; i++) delete this.blockLegitimaciesByAddress[keys[i]];
        }
        return roundLegitimacies;
    }
    /** @param {string} address @param {string} prevHash */
    async getAddressLegitimacy(address, prevHash) {
        const legitimacies = this.blockLegitimaciesByAddress[prevHash] || await this.calculateRoundLegitimacies(prevHash);
        if (!legitimacies) return 0;

        // if not found, return last index + 1 (= array length)
        const legitimacy = legitimacies[address] !== undefined ? legitimacies[address] : Object.keys(legitimacies).length;
        return legitimacy;
    }
    getAddressStakesInfo(address) {
        const references = [];
        for (const [key, value] of Object.entries(this.spectrum)) {
            if (value.address === address) { references.push(value); }
        }
        return references;
    }
}