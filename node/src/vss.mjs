import { HashFunctions } from "./conCrypto.mjs";
import { UTXO } from "./transaction.mjs";

/**
 * @typedef {Object} StakeReference
 * @property {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
 * @property {string} anchor - Example: "0:bdadb7ab:0"
 * @property {number} amount - Example: 100
 */
/**
 * @param {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
 * @param {string} anchor - Example: "0:bdadb7ab:0"
 * @param {number} amount - Example: 100
 * @returns {VssRange}
 */
export const StakeReference = (address, anchor, amount) => {
    return {
        address,
        anchor,
        amount
    };
}

export class spectrumFunctions {
    /** @param {spectrum} spectrum */
    static getHighestUpperBound(spectrum) {
        const keys = Object.keys(spectrum);
        if (keys.length === 0) { return 0; }

        // just return the last key
        return parseInt(keys[keys.length - 1]);
    }
    /** 
     * @param {spectrum} spectrum
     * @param {number} index - The index to search for
     */
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

    // LOTTERY FUNCTIONS
    /** Will return a number between 0 and maxRange from a blockHash - makes sure the result is unbiased
     * @param {string} blockData
     * @param {number} maxRange
     * @param {number} maxAttempts
     */
    static async hashToIntWithRejection(blockHash, lotteryRound = 0, maxRange = 1000000, maxAttempts = 1000) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Generate a hash including the nonce to get different results if needed
            const hash = await HashFunctions.SHA256(`${lotteryRound}${blockHash}`);
            const hashInt = BigInt('0x' + hash);
    
            // Calculate the maximum acceptable range to avoid bias
            return Number(hashInt % BigInt(maxRange));
        }
    
        throw new Error("Max attempts reached. Consider increasing maxAttempts or revising the method.");
    }

    /** Will return a number between 0 and maxRange from a blockHash - makes sure the result is unbiased
     * @param {string} blockData
     * @param {number} maxRange
     * @param {number} maxAttempts */
    static async hashToIntWithRejection_v2(blockHash, lotteryRound = 0, maxRange = 1000000, maxAttempts = 1000) {
        let nonce = 0;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const hash = await HashFunctions.SHA256(`${lotteryRound}${blockHash}${nonce}`);
            const troncatedHash = hash.slice(0, 12); // 6 bytes = 12 characters = 48 bits
            const hashInt = parseInt(troncatedHash, 16);

            // Calculate the maximum acceptable range to avoid bias
            const maxAcceptableValue = Math.floor(2**48 / maxRange) * maxRange;

            if (hashInt < maxAcceptableValue) {
                const result = hashInt % maxRange;
                return result;
            } else {
                nonce++; // Increment the nonce to try a new hash
            }
        }
    
        throw new Error("Max attempts reached. Consider increasing maxAttempts or revising the method.");
    }
}

export class Vss {
    /** @param {number} maxSupply - The maximum supply value to be used in the VSS. */
    constructor(maxSupply) {
        /** Validator Selection Spectrum (VSS)
         * - Can search key with number, will be converted to string.
         * @example { '100': { address: 'WCHMD65Q7qR2uH9XF5dJ', anchor: '0:bdadb7ab:0' } }
         * @type {Object<string, StakeReference | undefined>} */
        this.spectrum = {};
        /** @type {StakeReference[]} */
        this.legitimacies = []; // the order of the stakes in the array is the order of legitimacy
        this.currentRoundHash = '';
        /** @type {number} */
        this.maxSupply = maxSupply; // Store the maxSupply passed in the constructor
        this.maxLegitimacyToBroadcast = 10; // node should not broadcast block if not in the top 10
    }

    /** @param {UTXO} utxo @param {number | undefined} upperBound */
    newStake(utxo, upperBound) {
        const address = utxo.address;
        const anchor = utxo.anchor;
        const amount = utxo.amount;
        
        if (!upperBound) {
            const lastUpperBound = spectrumFunctions.getHighestUpperBound(this.spectrum);
            if (lastUpperBound + amount > this.maxSupply) { throw new Error('VSS: Max supply reached.'); }
            this.spectrum[lastUpperBound + amount] = StakeReference(address, anchor, amount);
            return;
        }

        const lowerBound = upperBound - amount;
        const existingUpperBounds = Object.keys(this.spectrum).map(key => parseInt(key));
        existingUpperBounds.sort((a, b) => a - b);
    
        for (let i = 0; i < existingUpperBounds.length; i++) {
            const existingUpperBound = existingUpperBounds[i];
            const existingLowerBound = i === 0 ? 0 : existingUpperBounds[i - 1];
        
            if (!(upperBound <= existingLowerBound || lowerBound >= existingUpperBound)) {
                throw new Error('VSS: Overlapping stake ranges.');
            }
        }
        
        if (upperBound > this.maxSupply) { throw new Error('VSS: Max supply exceeded.'); }
        
        this.spectrum[upperBound] = StakeReference(address, anchor, amount);
    }
    /** @param {UTXO[]} utxos */
    newStakes(utxos) {
        for (const utxo of utxos) { this.newStake(utxo); }
    }
    /** @param {spectrum} spectrum @param {string} blockHash */
    async calculateRoundLegitimacies(blockHash, maxResultingArrayLength = 100) {
        if (blockHash === this.currentRoundHash) { return; } // already calculated

        const startTimestamp = Date.now();
        /** @type {StakeReference[]} */
        const roundLegitimacies = [];
        const spectrumLength = Object.keys(this.spectrum).length;

        let i = 0;
        for (i; i < maxResultingArrayLength; i++) {
            const maxRange = spectrumFunctions.getHighestUpperBound(this.spectrum);
            // everyone has considered 0 legitimacy when not enough stakes
            if (maxRange < 999_999) { this.legitimacies = roundLegitimacies; return; }
            
            const winningNumber = await spectrumFunctions.hashToIntWithRejection(blockHash, i, maxRange);
            const stakeReference = spectrumFunctions.getStakeReferenceFromIndex(this.spectrum, winningNumber);
            roundLegitimacies.push(stakeReference);
            
            if (roundLegitimacies.length >= spectrumLength) { break; } // If all stakes have been selected
            if (roundLegitimacies.length >= maxResultingArrayLength) { break; } // If the array is full
        }

        this.legitimacies = roundLegitimacies;
        this.currentRoundHash = blockHash;

        //console.log(`[VSS] <-- Calculated round legitimacies in ${((Date.now() - startTimestamp)/1000).toFixed(2)}s. | ${i} iterations. -->`);
    }
    /** @param {string} address */
    getAddressLegitimacy(address) {
        const legitimacy = this.legitimacies.findIndex(stakeReference => stakeReference.address === address);
        return legitimacy !== -1 ? legitimacy : this.legitimacies.length; // if not found, return last index + 1
    }
    getAddressStakesInfo(address) {
        const references = this.legitimacies.filter(stakeReference => stakeReference.address === address);
        return references;
    }
}