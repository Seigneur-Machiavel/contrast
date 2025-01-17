process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });
import { parentPort, workerData } from 'worker_threads';
import { DashboardWsApp, ObserverWsApp } from '../src/apps.mjs';
import { Transaction_Builder } from '../src/transaction.mjs';
import { Wallet, Account } from '../src/wallet.mjs';
import { Storage } from '../../utils/storage-manager.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';

const nodePort = workerData.nodePort || 27260;
const dashboardPort = workerData.dashboardPort || 27271;
const observerPort = workerData.observerPort || 27270;

const dashApp = new DashboardWsApp(undefined, nodePort, dashboardPort);
while(!dashApp.node) { await new Promise(resolve => setTimeout(resolve, 1000)); }
const observApp = new ObserverWsApp(dashApp.node, observerPort);

async function stop() {
    try {
        await dashApp.stop();
        observApp.stop();
        parentPort.postMessage({ type: 'stopped' });
        parentPort.close();
        console.log('Dashboard worker stopped.');
    } catch (error) { console.error('Dashboard worker stop error:', error); }
}
async function stopIfDashAppStoppedLoop() {
    while(dashApp.stopped === false) { await new Promise(resolve => setTimeout(resolve, 1000)); }
    await stop();
}

parentPort.on('message', async (message) => { if (message.type === 'stop') { await stop(); } });
stopIfDashAppStoppedLoop();

// STRESS TEST
const testMiniLogger = new MiniLogger('stress-test');
const node = dashApp.node;
let txsTaskDoneThisBlock = {};
const testParams = {
    unsafeSpamMode: false,
    nbOfAccounts: 700, // minimum 25
    addressType: 'W',

    txsSeqs: {
        userSendToAllOthers: { active: true, start: 10, end: 100000, interval: 3 },
        userSendToNextUser: { active: true, start: 20, end: 100000, interval: 2 },
        stakeVss: { active: true, start: 30, end: 50, interval: 1 },
        simpleUserToUser: { active: true, start: 1, end: 100000, interval: 2 },
    },
}

/** Simple user to user transaction @param {Account} senderAccount @param {string} receiverAddress @param {number} amount */
async function userSendToUser(senderAccount, receiverAddress, amount = 1_000_000) {
    txsTaskDoneThisBlock['userSendToUser'] = true;

    let broadcasted = 0;
    const { signedTx, error } = await Transaction_Builder.createAndSignTransfer(senderAccount, amount, receiverAddress);
    if (signedTx) {
        testMiniLogger.log(`[TEST-USTU] SEND: ${senderAccount.address} -> ${amount} -> ${receiverAddress} | txID: ${signedTx.id}`, (m) => console.log(m));
        const result = await node.pushTransaction(signedTx);
        if (result.broadcasted) { broadcasted++; }
    } else { testMiniLogger.log(error, (m) => console.error(m)); return; }

    testMiniLogger.log(`[TEST-USTU] sent ${amount} to ${receiverAddress} | Broadcasted: ${broadcasted}`, (m) => console.info(m));
}
/** All users send to the next user @param {Account[]} accounts */
async function userSendToNextUser(accounts) {
    txsTaskDoneThisBlock['userSendToNextUser'] = true;

    let startTime = Date.now();
    const pauseEach = 50; // txs

    const transferPromises = [];
    for (let i = 0; i < accounts.length; i++) {
        if (i % pauseEach === 0) { await new Promise(resolve => setTimeout(resolve, 40)); }
        const senderAccount = accounts[i];
        const receiverAccount = i + 1 === accounts.length ? accounts[0] : accounts[i + 1];
        const amountToSend = 1_000; //Math.floor(Math.random() * (1_000) + 1000);
        transferPromises.push(Transaction_Builder.createAndSignTransfer(senderAccount, amountToSend, receiverAccount.address));
    }
    
    const pushPromises = [];
    let errorIsMissingUtxos = false;
    for (const promise of transferPromises) {
        const { signedTx, error } = await promise;
        if (error.message === 'No UTXO to spend') { errorIsMissingUtxos = true;}
        if (error) { continue; }
        pushPromises.push(node.pushTransaction(signedTx));
    }

    const timeToCreateAndSignAllTxs = Date.now() - startTime;
    startTime = Date.now();

    let broadcasted = 0;
    for (const promise of pushPromises) {
        const result = await promise;
        if (result.broadcasted) { broadcasted++; }
    }
    const timeToPushAllTxsToMempool = Date.now() - startTime;

    if (errorIsMissingUtxos) { testMiniLogger.log(`[TEST-USTNU] Missing UTXOs`, (m) => console.error(m)); }
    testMiniLogger.log(`[TEST-USTNU] Nb broadcasted Txs: ${broadcasted} | timeToCreate: ${(timeToCreateAndSignAllTxs / 1000).toFixed(2)}s | timeToBroadcast: ${(timeToPushAllTxsToMempool / 1000).toFixed(2)}s`, (m) => console.info(m));
}
/** User send to all other accounts @param {Account[]} accounts @param {number} senderAccountIndex */
async function userSendToAllOthers(accounts, senderAccountIndex = 0) {
    txsTaskDoneThisBlock['userSendToAllOthers'] = true;
    if (accounts.length * 10_000 > accounts[senderAccountIndex].balance) { return; } // ensure sender has enough funds

    const startTime = Date.now();
    const senderAccount = accounts[senderAccountIndex];
    let totalAmount = 0;
    const transfers = [];
    for (let i = 0; i < accounts.length; i++) {
        if (i === senderAccountIndex) { continue; }
        // from 5_000 to 10_000
        const amount = 10_000; Math.floor(Math.random() * 5_000 + 5_000);
        totalAmount += amount;
        const transfer = { recipientAddress: accounts[i].address, amount };
        transfers.push(transfer);
    }

    try {
        const transaction = await Transaction_Builder.createTransfer(senderAccount, transfers);
        const signedTx = await senderAccount.signTransaction(transaction);

        if (signedTx) {
            testMiniLogger.log(`[TEST-USTAO] SEND: ${senderAccount.address} -> rnd() -> ${transfers.length} users | txID: ${signedTx.id}`, (m) => console.log(m));
            testMiniLogger.log(`[TEST-USTAO] Pushing transaction: ${signedTx.id} to mempool.`, (m) => console.log(m));
            const result = await node.pushTransaction(signedTx);
            if (!result.broadcasted) throw new Error(`Transaction not broadcasted`);
        } else { testMiniLogger.log(`[TEST-USTAO] Can't sign transaction`, (m) => console.error(m)); }
    } catch (error) {
        testMiniLogger.log(`[TEST-USTAO] Can't send to all others: ${error.message}`, (m) => console.error(m));
        return;
    }
    
    testMiniLogger.log(`[TEST-USTAO] sent ${totalAmount} to ${transfers.length} addresses | Time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`, (m) => console.info(m));
}
/** User stakes in VSS @param {Account[]} accounts @param {number} senderAccountIndex @param {number} amountToStake */
async function userStakeInVSS(accounts, senderAccountIndex = 0, amountToStake = 2_000) {
    txsTaskDoneThisBlock['userStakeInVSS'] = true;

    const senderAccount = accounts[senderAccountIndex];
    const stakingAddress = senderAccount.address;

    let broadcasted = 0;
    try {
        const transaction = await Transaction_Builder.createStakingVss(senderAccount, stakingAddress, amountToStake);
        const signedTx = await senderAccount.signTransaction(transaction);
        if (signedTx) {
            testMiniLogger.log(`[TEST-USIV] STAKE: ${senderAccount.address} -> ${amountToStake} | txID: ${signedTx.id}`, (m) => console.log(m));
            testMiniLogger.log(`[TEST-USIV] Pushing transaction: ${signedTx.id} to mempool.`, (m) => console.log(m));
            const result = await node.pushTransaction(signedTx);
            if (result.broadcasted) { broadcasted++; }
        } else { testMiniLogger.log(`[TEST-USIV] Can't sign transaction`, (m) => console.error(m)); }
    } catch (error) {
        testMiniLogger.log(`[TEST-USIV] Can't stake in VSS: ${error.message}`, (m) => console.error(m));
        return;
    }
    
    if (broadcasted === 0) { return; }
    testMiniLogger.log(`[TEST-USIV] staked ${amountToStake} in VSS | ${stakingAddress} | Broadcasted: ${broadcasted}`, (m) => console.info(m));
}
/** @param {Account[]} accounts */
function refreshAllBalances(accounts) {
    for (let i = 0; i < accounts.length; i++) {
        const { spendableBalance, balance, UTXOs } = node.getAddressUtxos(accounts[i].address);
        const spendableUtxos = [];
        for (const utxo of UTXOs) {
            if (node.memPool.transactionByAnchor[utxo.anchor] !== undefined) { continue; }
            spendableUtxos.push(utxo);
        }
        accounts[i].setBalanceAndUTXOs(balance, spendableUtxos);
    }
}

async function test() {
    const nodeSettings = Storage.loadJSON('nodeSettings');
    if (!nodeSettings || Object.keys(nodeSettings).length === 0) { testMiniLogger.log(`No nodes settings found`, (m) => console.error(m)); return; }

    const wallet = new Wallet(nodeSettings[node.id].privateKey);
    wallet.loadAccounts();

    const { derivedAccounts, avgIterations } = await wallet.deriveAccounts(testParams.nbOfAccounts, testParams.addressType);
    const mainAccount = (await wallet.deriveAccounts(1, "C")).derivedAccounts[0];
    if (!derivedAccounts || !mainAccount) { testMiniLogger.log(`Failed to derive addresses.`, (m) => console.error(m)); return; }

    wallet.saveAccounts();

    const accounts = derivedAccounts;
    const account0Address = derivedAccounts[0].address;
    refreshAllBalances(accounts);
    refreshAllBalances([mainAccount]);
    
    // INFO MESSAGE
    testMiniLogger.log(`--------------------------------------------
[TEST] Starting stress test with ${testParams.nbOfAccounts} accounts.
[TEST] ${account0Address} should be funded with at least ${10000 * testParams.nbOfAccounts} mc. (balance: ${derivedAccounts[0].balance})
--------------------------------------------`, (m) => console.info(m));

    const lastBlockIndexAndTime = { index: 0, time: Date.now() };
    for (let i = 0; i < 1_000_000; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const currentHeight = node.blockchain.currentHeight;
        if (!node.syncAndReady) { continue; }
        if (node.syncHandler.isSyncing) { continue; }

        if (currentHeight > lastBlockIndexAndTime.index) { // on new block only
            lastBlockIndexAndTime.index = currentHeight;
            for (let key in txsTaskDoneThisBlock) { // delete txsTaskDoneThisBlock if the operation is done(value=true)
                if (txsTaskDoneThisBlock.hasOwnProperty(key) && testParams.unsafeSpamMode) { delete txsTaskDoneThisBlock[key]; break; } // Will spam event if intensive computation
                if (txsTaskDoneThisBlock.hasOwnProperty(key) && txsTaskDoneThisBlock[key] === true) { delete txsTaskDoneThisBlock[key]; }
            }
        }

        refreshAllBalances(accounts);
        refreshAllBalances([mainAccount]);

        // user send to all others
        if (testParams.txsSeqs.userSendToAllOthers.active && currentHeight >= testParams.txsSeqs.userSendToAllOthers.start && (currentHeight - 1) % testParams.txsSeqs.userSendToAllOthers.interval === 0 && txsTaskDoneThisBlock['userSendToAllOthers'] === undefined) {
            txsTaskDoneThisBlock['userSendToAllOthers'] = false;
            try { await userSendToAllOthers(accounts); } catch (error) { console.error(error); }
        }

        // users Send To Next Users
        if (testParams.txsSeqs.userSendToNextUser.active && currentHeight >= testParams.txsSeqs.userSendToNextUser.start && (currentHeight - 1) % testParams.txsSeqs.userSendToNextUser.interval === 0 && txsTaskDoneThisBlock['userSendToNextUser'] === undefined) {
            txsTaskDoneThisBlock['userSendToNextUser'] = false;
            try { await userSendToNextUser(accounts); } catch (error) { console.error(error); }
        }

        // user stakes in VSS
        if (testParams.txsSeqs.stakeVss.active && currentHeight >= testParams.txsSeqs.stakeVss.start && currentHeight < testParams.txsSeqs.stakeVss.end && txsTaskDoneThisBlock['userStakeInVSS'] === undefined) {
            txsTaskDoneThisBlock['userStakeInVSS'] = false;
            const senderAccountIndex = currentHeight + 1 - testParams.txsSeqs.stakeVss.start;
            try { await userStakeInVSS(accounts, senderAccountIndex); } catch (error) { console.error(error); }
        }

        // simple user to user transactions
        if (testParams.txsSeqs.simpleUserToUser.active && currentHeight >= testParams.txsSeqs.simpleUserToUser.start && (currentHeight - 1) % testParams.txsSeqs.simpleUserToUser.interval === 0 && txsTaskDoneThisBlock['userSendToUser'] === undefined) {
            txsTaskDoneThisBlock['userSendToUser'] = false;
            try { await userSendToUser(mainAccount, account0Address); } catch (error) { console.error(error); }
        }
    }
}
await new Promise(resolve => setTimeout(resolve, 10000));
test();