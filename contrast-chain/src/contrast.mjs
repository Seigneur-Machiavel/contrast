const logImports = true;

if (logImports) console.log('Loading Contrast libs...');
import utils from './utils.mjs';
if (logImports) console.log('utils loaded');
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
if (logImports) console.log('HashFunctions, AsymetricFunctions loaded');
import { BlockData, BlockUtils } from './block-classes.mjs';
if (logImports) console.log('BlockData, BlockUtils loaded');
import { Transaction_Builder } from './transaction.mjs';
if (logImports) console.log('Transaction_Builder loaded');
import { Wallet, Account } from './wallet.mjs';
if (logImports) console.log('Wallet loaded');
import { Node } from './node.mjs';
if (logImports) console.log('Node loaded');
import { Miner } from './miner.mjs';
if (logImports) console.log('Miner loaded');

const contrast = {
    HashFunctions,
    AsymetricFunctions,

    BlockData,
    BlockUtils,
    Transaction_Builder,
    Wallet,
    Account,
    Node,
    Miner,

    utils
};

export default contrast;