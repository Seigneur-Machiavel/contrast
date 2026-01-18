import { convert } from '../../utils/converters.mjs';
window.convert = window.convert || convert;

import { typeValidation } from '../../utils/type-validation.mjs';
window.typeValidation = window.typeValidation || typeValidation;

import { addressUtils } from '../../utils/addressUtils.mjs';
window.addressUtils = window.addressUtils || addressUtils;

import { Wallet } from '../../node/src/wallet.mjs';
if (!window.Wallet) window.Wallet = Wallet;

import { Transaction, Transaction_Builder, utxoExtraction } from '../../node/src/transaction.mjs';
if (!window.Transaction) window.Transaction = Transaction;
if (!window.Transaction_Builder) window.Transaction_Builder = Transaction_Builder;
if (!window.utxoExtraction) window.utxoExtraction = utxoExtraction;

import { CryptoLight } from '../../utils/cryptoLight.js';
if (!window.cryptoLight) window.cryptoLight = new CryptoLight();

/*import { FrontStorage } from '../../utils/storage-manager.mjs';
if (!window.FrontStorage) window.FrontStorage = FrontStorage;*/

window.modulesLoaded = true;
console.log('Modules loaded!');