import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from '../src/conCrypto.mjs';
import { conditionnals } from '../../utils/conditionnals.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';

const testStart = Date.now();
let baseDifficulty = 77;
let totalPowCounter = 0;
let totalSuccess = 0;

let sessionStart = Date.now();
let sessionFinalDiffs = [];
let powCounter = 0;
let posTimestamp = 0;
let success = 0;
const limitHashPerSecond = 1; // limit to 1H/s for testing (doesn't affect simulation's hasrate)
const hashPerSecond = 16; // SIMULATION, set false for real mining

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
    if (!pauseTime) pauseTime = 1000 / hps; // init
    else { // adjust to reach exactly the target hps
        const sessionElapsedTime = Date.now() - sessionStart;
        const hashRate = powCounter / (sessionElapsedTime / 1000);
        if (hashRate > hps) pauseTime *= 1.01; // increase pause time to slow down
        else pauseTime *= 0.99; // decrease pause time to speed up
        pauseTime = Math.max(1, pauseTime); // avoid negative pause time
    }

    const rndBitsArray = [];
    for (let i = 0; i < 256; i++) rndBitsArray.push(Math.floor(Math.random() * 2));

    const rndBitsArrayStr = rndBitsArray.join('');
    //console.log(`rndBitsArray: ${rndBitsArrayStr}`);

    await new Promise((resolve) => setTimeout(resolve, pauseTime));
    return rndBitsArrayStr;
}
async function mineBlockUntilValid(hps = false) {
    const hashRateCalculator = new hashrateCalculator();
    while (true) {
        try {
            const startTime = performance.now();
            //const signatureHex = '0005d5e180e8127d04514319fc65b9a1b3cd8beff052ff9a85e813ec801296ff';
            let bitsArrayAsString = '';
            if (hps) { // SIMULATION
                bitsArrayAsString = await simulatedPow(hps);
            } else { // REAL MINING
                const signatureHex = rndHash(64);
                const headerNonce = mining.generateRandomNonce().Hex;
                const coinbaseNonce = mining.generateRandomNonce().Hex;
                const nonce = `${headerNonce}${coinbaseNonce}`;
                const mined = await mineBlock(signatureHex, nonce);
                if (!mined) throw new Error('Invalid block hash');
                
                const elTime = performance.now() - startTime;
                if (limitHashPerSecond && elTime < 1000 / limitHashPerSecond)
                    await new Promise((resolve) => setTimeout(resolve, 1000 / limitHashPerSecond - elTime));
                bitsArrayAsString = mined.bitsArrayAsString;
            }
    
            hashRateCalculator.newHash(performance.now() - startTime);
            powCounter++;
            totalPowCounter++;
            
            // simulate the bet of miner logic to be more accurate
            // rnd from .4 to .8
            const rnd = Math.random() * 0.4 + 0.4;
            const bet = posTimestamp + (BLOCKCHAIN_SETTINGS.targetBlockTime * rnd);
            const powTimestamp = Math.max(Date.now(), bet);

            //const powTimestamp = Date.now(); //? not bet
            const differenceRatio = (powTimestamp - posTimestamp) / BLOCKCHAIN_SETTINGS.targetBlockTime;

            const timeDiffAdjustment = MINING_PARAMS.maxTimeDifferenceAdjustment - Math.round(differenceRatio * MINING_PARAMS.maxTimeDifferenceAdjustment);
            const finalDiff = Math.max(baseDifficulty + timeDiffAdjustment, 1); // cap at 1 minimum
            const conform = verify(bitsArrayAsString, finalDiff);
            if (!conform) continue;
            
            //const conform = verify(bitsArrayAsString, 0);
            // If bet the future, wait until the bet time
            if (bet > Date.now()) await new Promise((resolve) => setTimeout(resolve, bet - Date.now()));
            
            sessionFinalDiffs.push(finalDiff);
            posTimestamp = powTimestamp + 1;
            success++;
            totalSuccess++;
            const sessionElapsedTime = Date.now() - sessionStart;
            const hashRate = (powCounter / (sessionElapsedTime / 1000)).toFixed(2);
            //console.log(`totalSuccess: ${totalSuccess} | totalPOW: ${totalPowCounter} | Hash rate: ${hashRate} H/s`);

            const avgSuccessTime = sessionElapsedTime / success;
            const newDiff = mining.difficultyAdjustment({ index: success, difficulty: baseDifficulty }, avgSuccessTime);
            
            if (sessionFinalDiffs.length === 30) {
                const averageFinalDiff = sessionFinalDiffs.reduce((a, b) => a + b, 0) / sessionFinalDiffs.length;
                const estGlobalHasrate = mining.estimateGlobalHashrate(averageFinalDiff);
                console.log(`Estimated global hashrate: ${estGlobalHasrate} H/s`);
                sessionFinalDiffs = [];
            }
            
            if (baseDifficulty === newDiff) continue; // no adjustment needed

            console.log(`New difficulty: ${newDiff} | Avg success time: ${(avgSuccessTime*.001).toFixed(3)}s | Hash rate: ${hashRate} H/s | tS/tPow: ${totalSuccess}/${totalPowCounter}`);
            baseDifficulty = newDiff;
            powCounter = 0;
            success = 0;
            sessionStart = Date.now();
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
}

posTimestamp = Date.now();
mineBlockUntilValid(hashPerSecond);