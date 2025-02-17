import { CryptoLight } from './utils/cryptoLight.mjs';

const rndSeedHex = CryptoLight.generateRndHex(64);
console.log(`Your random seed:`);
console.log(rndSeedHex);