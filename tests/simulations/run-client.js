// @ts-check
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const workerData 	= JSON.parse(process.env.NODE_WORKER_DATA || '{}');
const seed      	= workerData.seed;
const isStaker  	= workerData.isStaker || false;
const isSpammer 	= workerData.isSpammer || false;
const nbReceipients = workerData.nbReceipients || 0;	// Number of recipient addresses in multi output transaction
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

const clientWallet = await Wallet.initializedWallet(clientStorage, undefined, seed);
const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
const clientNode = await createContrastNode({ cryptoCodex: clientCodex, storage: clientStorage, bootstraps, controllerPort: false });
await clientNode.start(clientWallet);

// STAKER / SPAMMER BEHAVIOR
let stakeHeight = -1;
/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const tryStaking = async (block) => {
	if (block.index === stakeHeight) return; // already processed
	stakeHeight = block.index;

	const senderAccount = clientNode.wallet?.accounts[0];
	if (!senderAccount || !senderAccount.address) return; // account not ready
	if (!clientNode.sync.isSynced.sameHeight) return; // only stake when synced to avoid staking on old blocks on every new peer connection

	// UPDATE ACCOUNT BALANCE & UTXOS
	const recipient = senderAccount.address;
	const ledger = clientNode.blockchain.ledgersStorage.getAddressLedger(recipient);
	senderAccount.setBalanceAndUTXOs(senderAccount.balance, ledger.getUtxos);
	const sigUtxos = senderAccount.filteredUtxos(undefined, undefined, ['sig']);
	const availableAmount = sigUtxos.reduce((a, b) => a + b.amount, 0);
	if (availableAmount < 10_000_000 * 2) return; // not enough to stake
	
	// CREATE STAKING TRANSACTION
	const { tx } = Transaction_Builder.createStakingVss(senderAccount, 1);
	const signedTx = await senderAccount.parentWallet.signTransaction(tx);
	if (!signedTx) return; // failed to create tx

	// PUSH TRANSACTION
	//console.log(`Pushing staking transaction spending: ${signedTx.inputs.join(', ')}`);
	const serialized = serializer.serialize.transaction(signedTx);
	clientNode.p2p.broadcast(serialized, { topic: 'transaction' });
	//console.log(`txBytes: ${serialized.length} | data.length: ${signedTx.data?.length || 0}`);
	//console.log('Transaction broadcasted.');
}

let spamHeight = -1;
/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const trySpamming = async (block) => {
    if (block.index === spamHeight) return;
    spamHeight = block.index;
	const senderAccount = clientNode.wallet?.accounts[0];
    if (!senderAccount || !senderAccount.address) return; // account not ready
	if (!clientNode.sync.isSynced.sameHeight) return; // only spam when synced to avoid spamming old blocks on every new peer connection
	
    if (block.index % 2 === 0) { // EVEN BLOCKS: one multi-output tx
        const ledger = clientNode.blockchain.ledgersStorage.getAddressLedger(senderAccount.address);
        senderAccount.setBalanceAndUTXOs(senderAccount.balance, ledger.getUtxos);

		const identityStore = clientNode.blockchain.identityStore;
		const identityEntries = []; 
		const transfers = [];
		for (let i = 2; i < 2 + nbReceipients; i++) {
			const a = clientWallet.accounts[i].address;
			const pks = [clientWallet.hybridKeyHex];
			if (!a) throw new Error('Address not found for recipient account');
			if (pks.length === 0) throw new Error('Pubkey not found for recipient account');
			
			// VERIFY IDENTITY CORRESPONDANCE => IF NOT IDENTIFY => CREATE IDENTITY
			const identityCountBefore = identityEntries.length;
			const identityStatus = identityStore.verify(a, pks);
			if (identityStatus === 'MISMATCH') throw new Error('Validator reward address known but pubkey(s) mismatch in identity store');
			if (identityStatus === 'UNKNOWN') identityEntries.push(identityStore.buildEntry(pks)); // if identity is unknown, we need to create it and attach it to the coinbase transaction for it to be valid (if not, the block will be rejected because of unknown identity)

			try { // create TX to check size, if too big it will throw, then we stop adding outputs
				transfers.push(new Transfer(a, 1_000));
				Transaction_Builder.createTransaction(senderAccount, transfers, undefined, 1, identityEntries); // test if transaction can be created with current data size, if not stop adding outputs
			} catch (/** @type {any} */ error) {
				transfers.pop(); // remove last transfer that caused failure
				if (identityCountBefore < identityEntries.length) identityEntries.pop(); // if we added an identity entry for this recipient, we need to remove it as well
				break; // stop adding outputs if failed (most likely because of size limit)
			}
		}

        const { tx } = Transaction_Builder.createTransaction(senderAccount, transfers, undefined, 1, identityEntries);
        const signedTx = await senderAccount.parentWallet.signTransaction(tx);
        if (!signedTx) return;

		const s = serializer.serialize.transaction(signedTx);
		clientNode.p2p.broadcast(s, { topic: 'transaction' });
		console.log(`[SPAMMER] block #${block.index} — multi-output tx (${nbReceipients} outputs) - ${identityEntries.length} identity entries.`);
    }

    // ODD BLOCKS: flood single-output txs
	if (block.index % 2 === 0) return; // only on odd blocks

	const recipient = clientWallet.accounts[0].address; // send back to main account
	if (!recipient) return; // account not ready
	
	let txs = [];
	for (let i = 2; i < nbOfSenders; i++) {
		const sender = clientWallet.accounts[i];
		if (!sender?.address) continue; // account not ready

		const ledger = 
		clientNode.blockchain.ledgersStorage.getAddressLedger(sender.address);
		sender.setBalanceAndUTXOs(sender.balance, ledger.getUtxos);

		const signedTx2 = (await Transaction_Builder.createAndSignTransaction(sender, 'max', recipient, 1))?.signedTx;
		if (signedTx2) txs.push(signedTx2);
	}

	if (txs.length === 0) return; // no tx to send
	else console.log(`[SPAMMER] block #${block.index} — prepared ${txs.length} single-output txs to send`);
	
	// SPEND EVERYTHING AT ONCE
	clientNode.p2p.broadcast(serializer.serialize.transactions(txs), { topic: 'transactions' });
}

if (isStaker) clientNode.on('onBlockConfirmed', tryStaking);
if (isSpammer) clientNode.on('onBlockConfirmed', trySpamming);