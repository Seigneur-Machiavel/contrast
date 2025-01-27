// EXPLORER SETTINGS INJECTIONS
window.explorerDOMAIN = 'pinkparrot.science'; // 'pinkparrot.observer';
window.explorerPORT = "27270";
window.explorerLOCAL = true;
window.explorerROLES = ['blockExplorer'];
window.explorerMagnetImgPath = 'dist(do not modify)/node/front/img/C_magnet.png';
window.explorerNB_OF_CONFIRMED_BLOCKS = 3;
console.log('EXPLORER SETTINGS INJECTED!');

// MODULES LOADER
import { convert } from '../dist(do not modify)/utils/converters.mjs';
window.convert = window.convert || convert;

import { typeValidation } from '../dist(do not modify)/utils/type-validation.mjs';
window.typeValidation = window.typeValidation || typeValidation;

import { addressUtils } from '../dist(do not modify)/utils/addressUtils.mjs';
window.addressUtils = window.addressUtils || addressUtils;

import { Wallet } from '../dist(do not modify)/node/src/wallet.mjs';
if (!window.Wallet) window.Wallet = Wallet;

import { Transaction, Transaction_Builder, utxoExtraction } from '../dist(do not modify)/node/src/transaction.mjs';
if (!window.Transaction) window.Transaction = Transaction;
if (!window.Transaction_Builder) window.Transaction_Builder = Transaction_Builder;
if (!window.utxoExtraction) window.utxoExtraction = utxoExtraction;

import { cryptoLight } from '../dist(do not modify)/utils/cryptoLight.js';
window.cryptoLight = window.cryptoLight || cryptoLight;

async function loadScriptAsText(url) {
    const response = await fetch(url);
    const text = await response.text();
    return text;
}

const accountWorkerCode = await loadScriptAsText('../dist(do not modify)/node/workers/account-worker-front.js');
window.accountWorkerCode = accountWorkerCode;

console.log('Modules loaded!');