// @ts-check
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const workerData 	= JSON.parse(process.env.NODE_WORKER_DATA || '{}');
const seed      	= workerData.seed;
const isStaker  	= workerData.isStaker || false;
const isSpammer 	= workerData.isSpammer || false;
const nbReceipients = workerData.nbReceipients || 0;	// Number of receipient addresses in multi output transaction
const nbOfSenders 	= workerData.nbOfSenders || 0; 	// Number of single output transactions to send (should be higher than nbReceipients)
const clearOnStart 	= workerData.clearOnStart;	// RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!
const bootstraps = ['ws://localhost:27260']; // bootstrap node URL(s) to connect to

if (isStaker && isSpammer) throw new Error('A client cannot be both a staker and a spammer');
if (!seed) throw new Error('Please provide a seed with -seed <seed>');

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { Wallet } from '../../node/src/wallet.mjs';
import { Transfer } from "../../types/transaction.mjs";
import { serializer } from '../../utils/serializer.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { createContrastNode } from '../../node/src/node.mjs';
import { HIVE_P2P_CONFIG } from '../../config/hive-p2p-config.mjs';
import { Transaction_Builder } from '../../node/src/transaction.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

const clientStorage = new ContrastStorage(seed);
if (clearOnStart) clientStorage.clear(); // start fresh
const clientWallet = new Wallet(seed);
await clientWallet.deriveAccounts(2 + Math.max(nbReceipients, nbOfSenders), 'C', clientStorage);

const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
const clientNode = await createContrastNode({ cryptoCodex: clientCodex, storage: clientStorage, bootstraps, controllerPort: false });
await clientNode.start(clientWallet);

// STAKER / SPAMMER BEHAVIOR
let stakeHeight = -1;
/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const tryStaking = async (block) => {
	if (block.index === stakeHeight) return; // already processed
	stakeHeight = block.index;
	if (!clientNode.account) return; // account not ready
	if (!clientNode.sync.isSynced) return; // only stake when synced to avoid staking on old blocks on every new peer connection

	// UPDATE ACCOUNT BALANCE & UTXOS
	const r = clientNode.account.address;
	const ledger = await clientNode.blockchain.ledgersStorage.getAddressLedger(r);
	if (!ledger.ledgerUtxos) return; // no UTXO
	
	clientNode.account.setBalanceAndUTXOs(clientNode.account.balance, ledger.ledgerUtxos);
	const sigUtxos = clientNode.account.filteredUtxos(undefined, undefined, ['sig']);
	const availableAmount = sigUtxos.reduce((a, b) => a + b.amount, 0);
	if (availableAmount < 10_000_000 * 2) return; // not enough to stake
	
	// CREATE STAKING TRANSACTION
	const { tx } = Transaction_Builder.createStakingVss(clientNode.account, 1);
	const signedTx = clientNode.account.signTransaction(tx);
	if (!signedTx) return; // failed to create tx

	// PUSH TRANSACTION
	//console.log(`Pushing staking transaction spending: ${signedTx.inputs.join(', ')}`);
	const serialized = serializer.serialize.transaction(signedTx);
	//console.log(`txBytes: ${serialized.length} | data.length: ${signedTx.data?.length || 0}`);
	clientNode.p2p.broadcast(serialized, { topic: 'transaction' });
	//console.log('Transaction broadcasted.');
}

let spamHeight = -1;
/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const trySpamming = async (block) => {
    if (block.index === spamHeight) return;
    spamHeight = block.index;
    if (!clientNode.account) return; // account not ready
	if (!clientNode.sync.isSynced) return; // only spam when synced to avoid spamming old blocks on every new peer connection

	const { address } = clientNode.account;
    if (block.index % 2 === 0) { // EVEN BLOCKS: one multi-output tx
        const ledger = await clientNode.blockchain.ledgersStorage.getAddressLedger(address);
        if (!ledger?.ledgerUtxos) return;
        clientNode.account.setBalanceAndUTXOs(clientNode.account.balance, ledger.ledgerUtxos);

		const identityStore = clientNode.blockchain.identityStore;
        const transfers = [];
		let data;
        for (let i = 0; i < nbReceipients; i++) {
			const a = clientWallet.accounts[i].address;
			const pk = clientWallet.accounts[i].pubKey;
			const d = identityStore.buildIdentityEntry(a, [pk]);
			
			// VERIFY IDENTITY CORRESPONDANCE => IF NOT IDENTIFY => CREATE IDENTITY
			const r = identityStore.resolveIdentity(a, [pk]);
			if (r === 'MISMATCH') throw new Error('Validator reward address known but pubkey(s) mismatch in identity store');
			if (r === 'UNKNOWN') data = Transaction_Builder.mergeIdentityData(d, data);

			transfers.push(new Transfer(clientWallet.accounts[i].address, 1_000)); // self, patch recipients here
		}

        const { tx } = Transaction_Builder.createTransaction(clientNode.account, transfers, 1, data);
        const signedTx = clientNode.account.signTransaction(tx);
        if (!signedTx) return;
        try {
            clientNode.p2p.broadcast(serializer.serialize.transaction(signedTx), { topic: 'transaction' });
            console.log(`[SPAMMER] block #${block.index} — multi-output tx (${nbReceipients} outputs)`);
        } catch (/** @type {any} */ error) { console.error('[SPAMMER] multi-output failed:', error.message); }
        return;
    }

    // ODD BLOCKS: flood single-output txs
	if (block.index % 2 === 0) return; // only on odd blocks

	const receipient = clientWallet.accounts[0].address; // send back to main account
	let txs = [];
	for (let i = 2; i < nbOfSenders; i++) {
		const sender = clientWallet.accounts[i];
		const ledger = await clientNode.blockchain.ledgersStorage.getAddressLedger(sender.address);
		if (!ledger?.ledgerUtxos) continue;
		sender.setBalanceAndUTXOs(sender.balance, ledger.ledgerUtxos);

		const signedTx2 = Transaction_Builder.createAndSignTransaction(sender, 100, receipient, 1)?.signedTx;
		if (signedTx2) txs.push(signedTx2);
	}

	if (txs.length > 0) console.log(`[SPAMMER] block #${block.index} — prepared ${txs.length} single-output txs to send`);
	let nbSent = 0;
	for (const tx of txs) { // FLOOD!
		try {
			const s = serializer.serialize.transaction(tx);
			clientNode.p2p.broadcast(s, { topic: 'transaction' });
			nbSent++;
		} catch (/** @type {any} */ error) { console.error('[SPAMMER] Failed to push transaction to mempool:', error.message); }
	}
	
	if (nbSent > 0) console.log(`[SPAMMER] block #${block.index} — sent ${nbSent} single-output txs`);
}

if (isStaker) clientNode.on('onBlockConfirmed', tryStaking);
if (isSpammer) clientNode.on('onBlockConfirmed', trySpamming);