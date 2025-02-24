import { Wallet } from './node/src/wallet.mjs';
import { CryptoLight } from './utils/cryptoLight.mjs';
import { Storage } from './utils/storage-manager.mjs';

const rndSeedHex = CryptoLight.generateRndHex(64);
console.log(`Your random seed:`);
console.log(rndSeedHex);

const wallet = new Wallet(rndSeedHex);
const { derivedAccounts } = await wallet.deriveAccounts(1000, 'W');

const walletInfo = {
    seed: rndSeedHex,
    accounts: derivedAccounts
};
Storage.saveJSON('generated_wallet', walletInfo);