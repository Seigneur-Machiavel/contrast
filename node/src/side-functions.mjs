import { Transaction_Builder } from '../src/transaction.mjs';
import { Wallet, Account } from '../src/wallet.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { Breather } from '../../utils/breather.mjs';

/**
 * @typedef {import('./apps.mjs').DashboardWsApp} DashboardWsApp
 */

// -------------------------------------------------
// -------------- FREEZE MONITOR -------------------
// -------------------------------------------------
const monitoringInterval = 1000;
let lastCheckTime = Date.now();
export function monitorPerformance() {
	// IF TIME ELAPSED IS GREATER THAN 500ms CONSIDER IT AS A POTENTIAL FREEZE
	const currentTime = Date.now();
	if (currentTime - lastCheckTime - monitoringInterval > 500)
	console.log(`|!| POTENTIAL FREEZE DETECTED: ${currentTime - lastCheckTime - monitoringInterval}ms`);

	lastCheckTime = currentTime;
}
setInterval(monitorPerformance, monitoringInterval);


// -------------------------------------------------
// --------------- STRESS TEST ---------------------
// -------------------------------------------------
const testMiniLogger = new MiniLogger('stress-test');
let txsTaskDoneThisBlock = {};
const testParams = {
    unsafeSpamMode: false,
    nbOfAccounts: 700, // minimum 25
    addressType: 'W',

    txsSeqs: {
        userSendToAllOthers: { active: true, start: 10, end: 100000, interval: 3 },
        userSendToNextUser: { active: true, start: 20, end: 100000, interval: 2 },
        stakeVss: { active: true, start: 80, end: 100, interval: 1 },
        simpleUserToUser: { active: true, start: 1, end: 100000, interval: 2 },
    },
}

export class StressTester {
    dashApp;
    /** @type {Account[]} */
    accounts = [];
    /** @type {Account} */
    mainAccount;

    /** @param {DashboardWsApp} dashApp */
    constructor(dashApp) {
        this.dashApp = dashApp;
    }
    async init() {
        while(!this.dashApp.extractNodeSetting()) { await new Promise(resolve => setTimeout(resolve, 200)); }
        console.log('nodeSetting ready -> Starting stress test');

        const nodeSetting = this.dashApp.extractNodeSetting();
        if (!nodeSetting || !nodeSetting.privateKey) { testMiniLogger.log(`Failed to extract nodeSetting.`, (m) => console.error(m)); return; }

        const wallet = new Wallet(nodeSetting.privateKey);
        await wallet.loadAccounts();

        const derivedAccounts = (await wallet.deriveAccounts(testParams.nbOfAccounts, testParams.addressType)).derivedAccounts;
        this.mainAccount = (await wallet.deriveAccounts(1, "C")).derivedAccounts[0];
        if (!derivedAccounts || !this.mainAccount) { testMiniLogger.log(`Failed to derive addresses.`, (m) => console.error(m)); return; }

        await wallet.saveAccounts();
        this.accounts = derivedAccounts;

        this.test();
    }

    /** Simple user to user transaction @param {Account} senderAccount @param {string} receiverAddress @param {number} amount */
    async userSendToUser(senderAccount, receiverAddress, amount = 1_000_000) {
        txsTaskDoneThisBlock['userSendToUser'] = true;
    
        let broadcasted = 0;
        try {
            const { signedTx, error } = await Transaction_Builder.createAndSignTransfer(senderAccount, amount, receiverAddress);
            if (signedTx) {
                testMiniLogger.log(`[TEST-USTU] SEND: ${senderAccount.address} -> ${amount} -> ${receiverAddress} | txID: ${signedTx.id}`, (m) => console.log(m));
                const result = await this.dashApp.node.pushTransaction(signedTx);
                if (result.broadcasted) { broadcasted++; }
            } else { throw new Error(error); }
        } catch (error) {
            if (error.message === 'No UTXO to spend') {
                testMiniLogger.log(`[TEST-USTU] No UTXO to spend`, (m) => console.info(m));
            } else {
                testMiniLogger.log(`[TEST-USTU] Can't send to user: ${error.message}`, (m) => console.error(m));
            }
        }
    
        if (broadcasted === 0) { return; }
        testMiniLogger.log(`[TEST-USTU] sent ${amount} to ${receiverAddress} | Broadcasted: ${broadcasted}`, (m) => console.info(m));
    }
    /** All users send to the next user */
    async userSendToNextUser() {
        txsTaskDoneThisBlock['userSendToNextUser'] = true;
    
        let startTime = Date.now();
        const breather = new Breather();
    
        const transferPromises = [];
        for (let i = 0; i < this.accounts.length; i++) {
            const senderAccount = this.accounts[i];
            const receiverAccount = i + 1 === this.accounts.length ? this.accounts[0] : this.accounts[i + 1];
            const amountToSend = 1_000; //Math.floor(Math.random() * (1_000) + 1000);
            transferPromises.push(Transaction_Builder.createAndSignTransfer(senderAccount, amountToSend, receiverAccount.address));
            await breather.breathe();
            if (i % 50 === 0) { await new Promise(resolve => setTimeout(resolve, 1000)); }
        }
        
        const pushPromises = [];
        let errorIsMissingUtxos = false;
        for (let i = 0; i < transferPromises.length; i++) {
            await breather.breathe();
            const promise = transferPromises[i];
            const { signedTx, error } = await promise;
            if (error.message === 'No UTXO to spend') { errorIsMissingUtxos = true;}
            if (error) { continue; }
            pushPromises.push(this.dashApp.node.pushTransaction(signedTx));
            if (i % 50 === 0) { await new Promise(resolve => setTimeout(resolve, 1000)); }
        }
    
        let broadcasted = 0;
        for (const promise of pushPromises) {
            await breather.breathe();
            const result = await promise;
            if (result.broadcasted) { broadcasted++; }
        }
        const elapsedTime = Date.now() - startTime;
    
        if (errorIsMissingUtxos) { testMiniLogger.log(`[TEST-USTNU] Missing UTXOs`, (m) => console.error(m)); }
        testMiniLogger.log(`[TEST-USTNU] Nb broadcasted Txs: ${broadcasted} | timeToCreate: ${(elapsedTime).toFixed(2)}s [${breather.breath} breaths]`, (m) => console.info(m));
    }
    /** User send to all other accounts @param {number} senderAccountIndex */
    async userSendToAllOthers(senderAccountIndex = 0) {
        txsTaskDoneThisBlock['userSendToAllOthers'] = true;
        if (this.accounts.length * 10_000 > this.accounts[senderAccountIndex].balance) { return; } // ensure sender has enough funds
    
        const startTime = Date.now();
        const senderAccount = this.accounts[senderAccountIndex];
        let totalAmount = 0;
        const transfers = [];
        for (let i = 0; i < this.accounts.length; i++) {
            if (i === senderAccountIndex) { continue; }
            // from 5_000 to 10_000
            const amount = 10_000; Math.floor(Math.random() * 5_000 + 5_000);
            totalAmount += amount;
            const transfer = { recipientAddress: this.accounts[i].address, amount };
            transfers.push(transfer);
        }
    
        try {
            const transaction = await Transaction_Builder.createTransfer(senderAccount, transfers);
            const signedTx = await senderAccount.signTransaction(transaction);
    
            if (signedTx) {
                testMiniLogger.log(`[TEST-USTAO] SEND: ${senderAccount.address} -> rnd() -> ${transfers.length} users | txID: ${signedTx.id}`, (m) => console.log(m));
                testMiniLogger.log(`[TEST-USTAO] Pushing transaction: ${signedTx.id} to mempool.`, (m) => console.log(m));
                const result = await this.dashApp.node.pushTransaction(signedTx);
                if (!result.broadcasted) throw new Error(`Transaction not broadcasted`);
            } else { testMiniLogger.log(`[TEST-USTAO] Can't sign transaction`, (m) => console.error(m)); }
        } catch (error) {
            testMiniLogger.log(`[TEST-USTAO] Can't send to all others: ${error.message}`, (m) => console.error(m));
            return;
        }
        
        testMiniLogger.log(`[TEST-USTAO] sent ${totalAmount} to ${transfers.length} addresses | Time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`, (m) => console.info(m));
    }
    /** User stakes in VSS @param {number} senderAccountIndex @param {number} amountToStake */
    async userStakeInVSS(senderAccountIndex = 0, amountToStake = 2_000) {
        txsTaskDoneThisBlock['userStakeInVSS'] = true;
    
        const senderAccount = this.accounts[senderAccountIndex];
        const stakingAddress = senderAccount.address;
    
        let broadcasted = 0;
        try {
            const transaction = await Transaction_Builder.createStakingVss(senderAccount, stakingAddress, amountToStake);
            const signedTx = await senderAccount.signTransaction(transaction);
            if (signedTx) {
                testMiniLogger.log(`[TEST-USIV] STAKE: ${senderAccount.address} -> ${amountToStake} | txID: ${signedTx.id}`, (m) => console.log(m));
                testMiniLogger.log(`[TEST-USIV] Pushing transaction: ${signedTx.id} to mempool.`, (m) => console.log(m));
                const result = await this.dashApp.node.pushTransaction(signedTx);
                if (result.broadcasted) { broadcasted++; }
            } else { testMiniLogger.log(`[TEST-USIV] Can't sign transaction`, (m) => console.error(m)); }
        } catch (error) {
            if (error.message === 'No UTXO to spend') {
                testMiniLogger.log(`[TEST-USIV] No UTXO to spend`, (m) => console.info(m));
            } else {
                testMiniLogger.log(`[TEST-USIV] Can't stake in VSS: ${error.message}`, (m) => console.error(m));
            }
        }
        
        if (broadcasted === 0) { return; }
        testMiniLogger.log(`[TEST-USIV] staked ${amountToStake} in VSS | ${stakingAddress} | Broadcasted: ${broadcasted}`, (m) => console.info(m));
    }
    /** Refresh all balances of the accounts @param {Account[]} accounts */
    refreshAllBalances(accounts) {
        for (let i = 0; i < accounts.length; i++) {
            const { spendableBalance, balance, UTXOs } = this.dashApp.node.getAddressUtxos(accounts[i].address);
            const spendableUtxos = [];
            for (const utxo of UTXOs) {
                if (this.dashApp.node.memPool.transactionByAnchor[utxo.anchor] !== undefined) { continue; }
                spendableUtxos.push(utxo);
            }
            accounts[i].setBalanceAndUTXOs(balance, spendableUtxos);
        }
    }
    async test() {
        refreshAllBalances(this.accounts);
        refreshAllBalances([this.mainAccount]);
        
        // INFO MESSAGE
        testMiniLogger.log(`--------------------------------------------
    [TEST] Starting stress test with ${testParams.nbOfAccounts} accounts.
    [TEST] ${this.accounts[0].address} should be funded with at least ${10000 * testParams.nbOfAccounts} mc. (balance: ${this.accounts[0].balance})
    --------------------------------------------`, (m) => console.info(m));
    
        const lastBlockIndexAndTime = { index: 0, time: Date.now() };
        for (let i = 0; i < 1_000_000; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
    
            const currentHeight = this.dashApp.node.blockchain.currentHeight;
            if (!this.dashApp?.node?.syncAndReady) { continue; }
            if (this.dashApp.node.syncHandler.isSyncing) { continue; }
    
            if (currentHeight > lastBlockIndexAndTime.index) { // on new block only
                lastBlockIndexAndTime.index = currentHeight;
                for (let key in txsTaskDoneThisBlock) { // delete txsTaskDoneThisBlock if the operation is done(value=true)
                    if (txsTaskDoneThisBlock.hasOwnProperty(key) && testParams.unsafeSpamMode) { delete txsTaskDoneThisBlock[key]; break; } // Will spam event if intensive computation
                    if (txsTaskDoneThisBlock.hasOwnProperty(key) && txsTaskDoneThisBlock[key] === true) { delete txsTaskDoneThisBlock[key]; }
                }
            }
    
            this.refreshAllBalances(this.accounts);
            this.refreshAllBalances([this.mainAccount]);
    
            // user send to all others
            if (testParams.txsSeqs.userSendToAllOthers.active && currentHeight >= testParams.txsSeqs.userSendToAllOthers.start && (currentHeight - 1) % testParams.txsSeqs.userSendToAllOthers.interval === 0 && txsTaskDoneThisBlock['userSendToAllOthers'] === undefined) {
                txsTaskDoneThisBlock['userSendToAllOthers'] = false;
                try { await this.userSendToAllOthers(); } catch (error) { console.error(error); }
            }
    
            // users Send To Next Users
            if (testParams.txsSeqs.userSendToNextUser.active && currentHeight >= testParams.txsSeqs.userSendToNextUser.start && (currentHeight - 1) % testParams.txsSeqs.userSendToNextUser.interval === 0 && txsTaskDoneThisBlock['userSendToNextUser'] === undefined) {
                txsTaskDoneThisBlock['userSendToNextUser'] = false;
                try { await this.userSendToNextUser(); } catch (error) { console.error(error); }
            }
    
            // user stakes in VSS
            if (testParams.txsSeqs.stakeVss.active && currentHeight >= testParams.txsSeqs.stakeVss.start && currentHeight < testParams.txsSeqs.stakeVss.end && txsTaskDoneThisBlock['userStakeInVSS'] === undefined) {
                txsTaskDoneThisBlock['userStakeInVSS'] = false;
                const senderAccountIndex = currentHeight + 1 - testParams.txsSeqs.stakeVss.start;
                try { await this.userStakeInVSS(senderAccountIndex); } catch (error) { console.error(error); }
            }
    
            // simple user to user transactions
            if (testParams.txsSeqs.simpleUserToUser.active && currentHeight >= testParams.txsSeqs.simpleUserToUser.start && (currentHeight - 1) % testParams.txsSeqs.simpleUserToUser.interval === 0 && txsTaskDoneThisBlock['userSendToUser'] === undefined) {
                txsTaskDoneThisBlock['userSendToUser'] = false;
                try { await this.userSendToUser(this.mainAccount, this.accounts[0].address); } catch (error) { console.error(error); }
            }
        }
    }
}