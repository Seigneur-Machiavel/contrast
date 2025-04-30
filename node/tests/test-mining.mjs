import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { conditionnals } from '../../utils/conditionnals.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';
import { convert } from '../../utils/converters.mjs';

const testStart = Date.now();
const speedHash = 32; // Used to faster test, but lower precision
const targetBlockTime = BLOCKCHAIN_SETTINGS.targetBlockTime / speedHash; // 2 min / 32 = 3.75 sec
//const targetBlockTime = 200; // 1 sec for testing
let baseDifficulty = 92;
let totalPowCounter = 0;
let totalSuccess = 0;

let sessionStart = Date.now();
let sessionFinalDiffs = [];
let sessionDiffWL = []; // diff including legitimacy
let powCounter = 0;
let posTimestamp = 0;
let success = 0;

const hashPerSecond = speedHash; // SIMULATION, set false for real mining
const expectedHashtime = 1000 / hashPerSecond; // 1000ms / 32 = 31.25ms
const adjustDiffEveryCrop = 0; // init: 30 blocks, then 15 + 15 = 30 blocks // 0 to disable adjustment
const betRange = { min: .7, max: .9 }
const disableBet = false; // disable bet time adjustment

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
function verify(HashBitsAsString = 'toto', finalDiff = 0) {
    const { zeros, adjust } = mining.decomposeDifficulty(finalDiff);

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

let pauseTime = 0;
async function simulatedPow(hps = 10) {
    const startTime = performance.now();
    const hash = rndHash(64);
    const bitsArray = convert.hex.toBits(hash);

    if (!pauseTime) pauseTime = 1000 / hps; // init
    else { // adjust to reach exactly the target hps
        const sessionElapsedTime = Date.now() - sessionStart;
        const hashRate = powCounter / (sessionElapsedTime / 1000);
        if (hashRate > hps) pauseTime *= 1.01; // increase pause time to slow down
        else pauseTime *= 0.99; // decrease pause time to speed up
        pauseTime = Math.max(1, pauseTime); // avoid negative pause time
    }

    
    await new Promise((resolve) => setTimeout(resolve, pauseTime));
    const time = performance.now() - startTime;
    //console.log(`Simulated hash time: ${Math.round(time)} ms | pauseTime: ${Math.round(pauseTime)} ms`);
    return bitsArray.join('');
}
async function realPow(limitHashPerSecond = 1) {
    const startTime = performance.now();
    const signatureHex = rndHash(64);
    const headerNonce = mining.generateRandomNonce().Hex;
    const coinbaseNonce = mining.generateRandomNonce().Hex;
    const nonce = `${headerNonce}${coinbaseNonce}`;
    const mined = await mineBlock(signatureHex, nonce);
    if (!mined) throw new Error('Invalid block hash');
    
    const elTime = performance.now() - startTime;
    if (limitHashPerSecond && elTime < 1000 / limitHashPerSecond)
        await new Promise((resolve) => setTimeout(resolve, 1000 / limitHashPerSecond - elTime));

    return mined.bitsArrayAsString;
}
async function mineBlockUntilValid(hps = hashPerSecond) {
    const hashRateCalculator = new hashrateCalculator();
    while (true) {
        try {
            async function computeHash() {
                const powStartTime = performance.now();
                const bitsArrayAsString = hps ? await simulatedPow(hps) : await realPow();
                hashRateCalculator.newHash(performance.now() - powStartTime);
                powCounter++;
                totalPowCounter++;
                return bitsArrayAsString;
            }
            
            // simulate the bet of miner logic to be more accurate
            const { min, max } = betRange;
            let betTime = mining.betPowTime(min, max); // rnd from .4 to .8 (randomize bet time)
            if (disableBet) betTime = 0; // disable bet time adjustment

            const bet = Math.round(posTimestamp + betTime + 1);
            let powTimestamp = Math.max(Date.now(), bet);
            //const powTimestamp = Date.now(); //? test: not betting

            const betBlockCandidate = { difficulty: baseDifficulty, legitimacy: 0, posTimestamp, timestamp: powTimestamp };
            let diffWL = baseDifficulty + (betBlockCandidate.legitimacy * MINING_PARAMS.diffAdjustPerLegitimacy);
            let finalDiff = mining.getBlockFinalDifficulty(betBlockCandidate, targetBlockTime).finalDifficulty;
            const conform = verify(await computeHash(), finalDiff);
            if (!conform) continue;
            
            // If powTimestamp the future, try normal pow (simulated pow only)
            while (hps && powTimestamp > Date.now() + expectedHashtime) {
                const noBetBlockCandidate = { difficulty: baseDifficulty, legitimacy: 0, posTimestamp, timestamp: Date.now() };
                const noBetFinalDiff = mining.getBlockFinalDifficulty(noBetBlockCandidate, targetBlockTime).finalDifficulty;
                const noBetConform = verify(await computeHash(), noBetFinalDiff);
                if (!noBetConform) continue;
                
                powTimestamp = noBetBlockCandidate.timestamp; // update powTimestamp with the new one
                finalDiff = noBetFinalDiff; // update finalDiff with the new one
                diffWL = baseDifficulty + (noBetBlockCandidate.legitimacy * MINING_PARAMS.diffAdjustPerLegitimacy);
                break;
            }

            // If powTimestamp the future, wait...
            if (powTimestamp > Date.now()) await new Promise((resolve) => setTimeout(resolve, powTimestamp - Date.now()));
            
            sessionFinalDiffs.push(finalDiff);
            sessionDiffWL.push(diffWL);
            posTimestamp = powTimestamp + 1;
            success++;
            totalSuccess++;
            const sessionElapsedTime = Date.now() - sessionStart;
            const hashRate = (powCounter / (sessionElapsedTime / 1000)).toFixed(2);
            const avgSuccessTime = sessionElapsedTime / success;
            const newDiff = mining.difficultyAdjustment({ index: success + adjustDiffEveryCrop, difficulty: baseDifficulty }, avgSuccessTime, targetBlockTime);
            const averageFinalDiff = sessionFinalDiffs.reduce((a, b) => a + b, 0) / sessionFinalDiffs.length;
            const avgDiffWL = sessionDiffWL.reduce((a, b) => a + b, 0) / sessionDiffWL.length;
            //const estGlobalHasrate = mining.estimateGlobalHashrate(averageFinalDiff, avgSuccessTime, targetBlockTime, success + adjustDiffEveryCrop);
            const estGlobalHasrate = mining.estimateGlobalHashrate(avgDiffWL, avgSuccessTime, targetBlockTime);
            console.log(`avgFD: ${averageFinalDiff.toFixed(2)} | EGH: ${estGlobalHasrate.toFixed(2)} H/s | betTime: ${betTime.toFixed(2)}`);
            
            //if (baseDifficulty === newDiff) continue; // no adjustment needed
            if (success + adjustDiffEveryCrop < MINING_PARAMS.blocksBeforeAdjustment) continue; // no adjustment needed

            const successRate = success / powCounter * 100;
            console.log(`New difficulty: ${newDiff} | Avg success time: ${(avgSuccessTime*.001).toFixed(3)}s | Hash rate: ${hashRate} H/s | tS/tPow: ${totalSuccess}/${totalPowCounter} | ${successRate.toFixed(2)}%`);

            baseDifficulty = newDiff;
            powCounter = 0;
            success = 0;
            sessionFinalDiffs = []; // reset sessionFinalDiffs
            sessionStart = Date.now();
            console.log('--- session data reset ---');
        } catch (error) { 
            await new Promise((resolve) => setTimeout(resolve, 10)) }
    }
}

posTimestamp = Date.now();
mineBlockUntilValid();