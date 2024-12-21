export const UTXO_RULES_GLOSSARY = {
    sig: { code: 0, description: 'Simple signature verification' },
    sigOrSlash: { code: 1, description: "Open right to slash the UTXO if validator's fraud proof is provided", withdrawLockBlocks: 144 },
    lockUntilBlock: { code: 2, description: 'UTXO locked until block height', lockUntilBlock: 0 },
    multiSigCreate: { code: 3, description: 'Multi-signature creation' },
    p2pExchange: { code: 4, description: 'Peer-to-peer exchange' },
    lightHousePause: { code: 6, description: 'LightHouse pause' },
    lightHouseResume: { code: 7, description: 'LightHouse resume' },
};
export const UTXO_RULESNAME_FROM_CODE = {
    0: 'sig',
    1: 'sigOrSlash',
    2: 'lockUntilBlock',
    3: 'multiSigCreate',
    4: 'p2pExchange'
};