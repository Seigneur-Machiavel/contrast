export const BLOCKCHAIN_SETTINGS = {
    // BLOCK
    targetBlockTime: 120_000, // 120_000, // 2 min
    maxBlockSize: 200_000, // ~100KB
    maxTransactionSize: 100_000, // ~100KB
    
    // DISTRIBUTION
    // 1 000 000mC = 1 Contrast
    // In the code we only speak in mC, but in the UI we will use the Contrast unit
    rewardMagicNb1: 102_334_155, // Fibonacci n+2
    rewardMagicNb2: 63_245_986, // Fibonacci n+1
    blockReward: 102_334_155 - 63_245_986, // Fibonacci n = 39_088_169
    minBlockReward: 1,
    halvingInterval: 262_980, // 1 year at 2 min per block
    maxSupply: 27_000_000_000_000, // last 6 zeros are considered as decimals ( can be stored as 8 bytes )

    // TRANSACTION
    minTransactionFeePerByte: 1,
    unspendableUtxoAmount: 200
};

export const MINING_PARAMS = {
    // a difficulty incremented by 16 means 1 more zero in the hash - then 50% more difficult to find a valid hash
    // a difference of 1 difficulty means 3.125% harder to find a valid hash
    argon2: {
        time: 1,
        mem: 2 ** 19,
        parallelism: 1,
        type: 2,
        hashLen: 32,
    },
    nonceLength: 4,
    initialDifficulty: 27,
    blocksBeforeAdjustment: 30, // ~120sec * 30 = ~3600 sec = ~1 hour
    thresholdPerDiffIncrement: 3.2, // meaning 3.2% threshold for 1 diff point
    maxDiffIncrementPerAdjustment: 32, // 32 diff points = 100% of diff
    diffAdjustPerLegitimacy: 16, // 16 diff points = 50% of diff
    maxTimeDifferenceAdjustment: 128, // in difficutly points, affect max penality, but max bonus is infinite
};