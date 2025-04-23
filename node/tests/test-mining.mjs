import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { conditionnals } from '../../utils/conditionnals.mjs';

const testStart = Date.now();
let finalDifficulty = 27;
let totalPowCounter = 0;
let totalSuccess = 0;

let sessionStart = Date.now();
let powCounter = 0;
let success = 0;

/** @param {string} signatureHex @param {string} nonce */
async function mineBlock(signatureHex, nonce) {
    try {
        const blockHash = await mining.hashBlockSignature(HashFunctions.Argon2, signatureHex, nonce);
        if (!blockHash) throw new Error('Invalid block hash');
        return { bitsArrayAsString: blockHash.bitsArray.join('') };
    } catch (err) { throw err; }
}
class hashrateCalculator {
    constructor() {
        this.periodStart = Date.now();
    
        this.hashCount = 0;
        this.hashTimes = [];
        this.calculateAndSendEvery = 10; // in hashes
    }
    reset() {
        this.periodStart = Date.now();
        this.hashCount = 0;
        this.hashTimes = [];
    }
    newHash(hashTime) {

        this.hashCount++;
        this.hashTimes.push(hashTime); // dev
        this.#logHashTimeIfNecessary(); // dev
    }
    #logHashTimeIfNecessary() { // dev
        if (this.hashCount === 0) return;
        if (this.hashCount % this.calculateAndSendEvery !== 0) return;

        const avgTime = this.hashTimes.reduce((a, b) => a + b, 0) / this.hashTimes.length;
        //console.log('Average hash time:', avgTime.toFixed(2), 'ms');
        
        if (this.hashCount >= 50) this.reset();
    }
}
function verify(HashBitsAsString = 'toto') {
    const { zeros, adjust } = mining.decomposeDifficulty(finalDifficulty);

    const condition1 = conditionnals.binaryStringStartsWithZeros(HashBitsAsString, zeros);
    if (!condition1) return false;

    const next5Bits = HashBitsAsString.substring(zeros, zeros + 5);
    const condition2 = conditionnals.binaryStringSupOrEqual(next5Bits, adjust);
    if (!condition2) return false;

    return true;
}
function rndHash(len = 64) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(len / 2));
    return Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function mineBlockUntilValid() {
    const hashRateCalculator = new hashrateCalculator();
    while (true) {
        try {
            const startTime = performance.now();
            //const signatureHex = '0005d5e180e8127d04514319fc65b9a1b3cd8beff052ff9a85e813ec801296ff';
            const signatureHex = rndHash(64);
            const headerNonce = mining.generateRandomNonce().Hex;
            const coinbaseNonce = mining.generateRandomNonce().Hex;
            const nonce = `${headerNonce}${coinbaseNonce}`;
            const mined = await mineBlock(signatureHex, nonce, false);
            if (!mined) throw new Error('Invalid block hash');
    
            hashRateCalculator.newHash(performance.now() - startTime);
            powCounter++;
            totalPowCounter++;
            
            const conform = verify(mined.bitsArrayAsString);
            if (!conform) continue;

            success++;
            totalSuccess++;
            const elapsedTime = Date.now() - testStart;
            const elapsedTimeInSeconds = (elapsedTime / 1000).toFixed(2);
            const hashRate = (powCounter / elapsedTimeInSeconds).toFixed(2);

            console.log(`totalSuccess: ${totalSuccess} | totalPOW: ${totalPowCounter} | Hash rate: ${hashRate} H/s`);

            const senssionElapsedTime = Date.now() - sessionStart;
            const avgSuccessTime = senssionElapsedTime / success;
            const newDiff = mining.difficultyAdjustment({ index: success, difficulty: finalDifficulty }, avgSuccessTime);
            if (finalDifficulty === newDiff) continue; // no adjustment needed

            console.log(`New difficulty: ${newDiff} | Avg success time: ${avgSuccessTime.toFixed(2)}ms`);
            finalDifficulty = newDiff;
            powCounter = 0;
            success = 0;
            sessionStart = Date.now();
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
}

mineBlockUntilValid();