import { Transaction_Builder, UTXO } from '../src/transaction.mjs';
import { convert } from '../../utils/converters.mjs';
//import { BlockExplorerWidget } from './explorerScript.mjs';

/**
 * @typedef {import("../src/block-classes.mjs").BlockData} BlockData
 * @typedef {import("./transaction.mjs").Transaction} Transaction
 * @typedef {import("../src/vss.mjs").StakeReference} StakeReference
 */

let ws;
const WS_SETTINGS = {
    PROTOCOL: window.location.protocol === "https:" ? "wss:" : "ws:",
    DOMAIN: window.location.hostname,
    PORT: window.location.port,
    RECONNECT_INTERVAL: 5000,
    GET_NODE_INFO_INTERVAL: 5000,
}

let nodeId;
/** @type {UTXO[]} */
let validatorUTXOs = [];
let minerUTXOs = [];
let modalOpen = false;
let currentAction = null;
let currentActionPeerId = null;
const ACTIONS = {
    HARD_RESET: 'hard_reset',
    UPDATE_GIT: 'update_git',
    FORCE_RESTART: 'force_restart',
    REVALIDATE: 'revalidate',
    RESET_WALLET: 'reset_wallet',
    SETUP: 'setup',
    SET_VALIDATOR_ADDRESS: 'set_validator_address',
    SET_MINER_ADDRESS: 'set_miner_address'
};


function connectWS() {
    ws = new WebSocket(`${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
    //console.log(`Connecting to ${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
  
    ws.onopen = function() {
        console.log('Connection opened');
        ws.send(JSON.stringify({ type: 'get_node_info', data: Date.now() })); // do it once at the beginning
    };
    ws.onclose = function() {
        console.info('Connection closed');
        setTimeout(connectWS, WS_SETTINGS.RECONNECT_INTERVAL); // retry connection
    };
    ws.onerror = function(error) { console.info('WebSocket error: ' + error); };
  
    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        const trigger = message.trigger;
        const data = message.data;
        if (data && data.error) { console.info(data.error); }
        switch (message.type) {
            case 'error':
                if (data === 'No active node' && !modalOpen) {
                    openModal(ACTIONS.SETUP, {
                        message: 'No active node detected. Please set up your private key.',
                        inputLabel: 'Private Key:',
                        inputType: 'password',
                        showInput: true
                    });
                    console.log('No active node, opening setup modal');
                }
                break;
            case 'node_info':
                if (data.error === 'No active node') { return; }

                displayNodeInfo(data);
                nodeId = data.nodeId;
                validatorUTXOs = data.validatorUTXOs;
                minerUTXOs = data.minerUTXOs;
                
                break;
            case 'state_updated':
                if (typeof data !== 'string') { console.error('state_update: data is not a string'); return; }
                eHTML.nodeState.textContent = data;
                break;
            case 'node_restarting':
                console.log('node_restarting', data);
                break;
            case 'node_restarted':
                console.log('node_restarted', data);
                break;
            case 'broadcast_new_candidate':
                console.log('broadcast_new_candidate', data);
                break;
            case 'broadcast_finalized_block':
                //console.log('broadcast_finalized_block', data);
                break;
            case 'transaction_broadcasted':
                console.log('transaction_broadcasted', data);
                break;
            case 'hash_rate_updated':
                if (isNaN(data)) { console.error(`hash_rate_updated: ${data} is not a number`); return; }
                eHTML.hashRate.textContent = data.toFixed(2);
                break;
            case 'balance_updated':
                //console.log('balance_updated', data);
                return; // not used anymore, we fetch node_info frequently
                if(trigger === eHTML.validatorAddress.textContent) { eHTML.validatorBalance.textContent = convert.formatNumberAsCurrency(data); }
                if(trigger === eHTML.minerAddress.textContent) { eHTML.minerBalance.textContent = convert.formatNumberAsCurrency(data); }
                break;
            default:
                console.error(`Unknown message type: ${message.type}`);
                break;
        }
    };
}

(async() => {
    while (true) {
        await new Promise((resolve) => { setTimeout(() => resolve(), WS_SETTINGS.GET_NODE_INFO_INTERVAL); });
        if (!ws || ws.readyState !== 1) continue;
        try { ws.send(JSON.stringify({ type: 'get_node_info', data: Date.now() })) } catch (error) {};
    }
})(); // INIT ANONYMOUS FUNCTION -> await ws then send "get_node_info"
connectWS();

const eHTML = {
    roles: document.getElementById('roles'),
    syncClock: document.getElementById('syncClock'),
    forceRestartBtn: document.getElementById('forceRestart'),
    RevalidateBtn: document.getElementById('Revalidate'),

    modals: {
        wrap: document.getElementsByClassName('modalsWrap')[0],
        modalsWrapBackground: document.getElementsByClassName('modalsWrapBackground')[0],
        unifiedModal: {
            wrap: document.getElementById('unifiedModalWrap'),
            modal: document.getElementById('unifiedModalWrap').getElementsByClassName('modal')[0],
            form: document.getElementById('unifiedModalForm'),
            message: document.getElementById('modalMessage'),
            inputSection: document.getElementById('modalInputSection'),
            inputLabel: document.getElementById('modalInputLabel'),
            input: document.getElementById('modalInput'),
            toggleInputBtn: document.getElementById('toggleModalInput'),
            confirmBtn: document.getElementById('modalConfirmBtn'),
            cancelBtn: document.getElementById('modalCancelBtn'),
        }
    },

    nodeState: document.getElementById('nodeState'),
    validatorAddress: document.getElementById('validatorAddress'),
    validatorRewardAddress: document.getElementById('validatorRewardAddress'),
    validatorAddressEditBtn: document.getElementById('validatorAddressEditBtn'),
    validatorHeight: document.getElementById('validatorHeight'),
    validatorBalance: document.getElementById('validatorBalance'),
    validatorStaked: document.getElementById('staked'),
    stakeInput: {
        wrap: document.getElementById('stakeInputWrap'),
        input: document.getElementById('stakeInputWrap').getElementsByTagName('input')[0],
        confirmBtn: document.getElementById('stakeInputWrap').getElementsByTagName('button')[0],
    },

    minerAddress: document.getElementById('minerAddress'),
    minerRewardAddress: document.getElementById('minerRewardAddress'), // Assuming this exists if needed
    minerAddressEditBtn: document.getElementById('minerAddressEditBtn'),
    minerHeight: document.getElementById('minerHeight'),
    minerLegitimacy: document.getElementById('minerLegitimacy'),
    minerBalance: document.getElementById('minerBalance'),
    globalHashRate: document.getElementById('globalHashRate'),
    hashRate: document.getElementById('hashRate'),
    miningDailyReward: document.getElementById('miningDailyReward'),

    minerThreads: {
        wrap: document.getElementById('minerThreadsIncrementalInput'),
        input: document.getElementById('minerThreadsIncrementalInput').getElementsByTagName('input')[0],
        decrementBtn: document.getElementById('minerThreadsIncrementalInput').getElementsByTagName('button')[0],
        incrementBtn: document.getElementById('minerThreadsIncrementalInput').getElementsByTagName('button')[1],
    },
    peersConnected: document.getElementById('peersConnected'),
    lastBlockInfo: document.getElementById('lastBlockInfo'),
    txInMempool: document.getElementById('txInMempool'),
    averageBlockTime: document.getElementById('averageBlockTime'),
    adminPanelButtons: document.querySelector('#topBar .btnWrap'),
    toggleAdminPanelBtn : document.getElementById('toggleAdminPanel'),

    resetInfoBtn: document.getElementById('resetInfo'),
    peerId: document.getElementById('peerId'),
    peersConnectedList: document.getElementById('peersConnectedList'),
    hardResetBtn: document.getElementById('hardReset'),
    updateGitBtn: document.getElementById('updateGit'),
    repScoresList: document.getElementById('repScoreList'),
    peersHeightList: document.getElementById('peersHeightList'),
    listenAddress: document.getElementById('listenAddress'),
    lastLegitimacy: document.getElementById('lastLegitimacy'),
    ignoreBlocksToggle: {
        wrap: document.getElementById('ignoreBlocksWrap'),
        button: document.getElementById('ignoreBlocksToggle'),
        status: document.getElementById('ignoreBlocksStatus')
    },
    disabledSyncToggle: {
        wrap: document.getElementById('disabledSyncWrap'),
        button: document.getElementById('disabledSyncToggle'),
        status: document.getElementById('disabledSyncStatus')
    }
}
window.eHTML = eHTML;

function readableId(peerIdStr) { return peerIdStr.replace('12D3KooW', '').slice(0, 12) }
function displayNodeInfo(data) {
    /** @type {StakeReference[]} */
    const validatorStakesReference = data.validatorStakes ? data.validatorStakes : false;
    const validatorStaked = validatorStakesReference ? validatorStakesReference.reduce((acc, stake) => acc + stake.amount, 0) : 0;
    const validatorBalance = data.validatorBalance ? data.validatorBalance : 0;
    const minerBalance = data.minerBalance ? data.minerBalance : 0;
    if (!data.roles) { console.info('Roles not found in data:', data); return; }

    // Update roles
    //eHTML.roles.textContent = data.roles.join(' - ');

    // Update Validator information
    eHTML.validatorAddress.textContent = data.validatorAddress ? data.validatorAddress : ''; 
    eHTML.validatorRewardAddress.textContent = data.validatorRewardAddress ? data.validatorRewardAddress : '';
    eHTML.validatorBalance.textContent = convert.formatNumberAsCurrency(validatorBalance);
    eHTML.validatorHeight.textContent = data.currentHeight ? data.currentHeight : 0;
    eHTML.validatorStaked.textContent = convert.formatNumberAsCurrency(validatorStaked);

    // Update Miner information
    eHTML.minerAddress.textContent = data.minerAddress ? data.minerAddress : '';
    eHTML.minerBalance.textContent = convert.formatNumberAsCurrency(minerBalance);
    eHTML.minerHeight.textContent = data.bestCandidateIndex || 0;
    eHTML.minerLegitimacy.textContent = `Legitimacy: ${data.bestCandidateLegitimacy || 0}`;
    eHTML.globalHashRate.textContent = data.globalHashRate ? data.globalHashRate.toFixed(2) : 0;
    eHTML.hashRate.textContent = data.minerHashRate ? data.minerHashRate.toFixed(2) : 0;
    eHTML.miningDailyReward.textContent = data.miningDailyReward || 'na';
    eHTML.minerThreads.input.value = data.minerThreads ? data.minerThreads : 0;
    updateMinerThreadsDisabledButtons();

    // Update Global Information
    eHTML.peersConnected.textContent = data.peersConnected ? data.peersConnected : 0;
    eHTML.lastBlockInfo.textContent = data.lastBlockInfo ? data.lastBlockInfo : 'No Block Info';
    eHTML.txInMempool.textContent = data.txInMempool;
    eHTML.averageBlockTime.textContent = data.averageBlockTime ? `${data.averageBlockTime} seconds` : '0 seconds';
    eHTML.peerId.textContent = data.peerId ? readableId(data.peerId) : 'No Peer ID';
    eHTML.nodeState.textContent = data.nodeState ? data.nodeState : 'No State';
    if (Array.isArray(data.listenAddress) && data.listenAddress.length > 0) {
        let cleanedAddresses = [];
        for (const address of data.listenAddress) {
            cleanedAddresses.push(`<li>${address.split('/').slice(0, -1).join('/')}</li>`);
        }
        cleanedAddresses = cleanedAddresses.join('').split('certhash/').join('certhash/\n');
        eHTML.listenAddress.innerHTML = cleanedAddresses;
        //eHTML.listenAddress.innerHTML = data.listenAddress.map(address => `<li>${address}</li>`).join('');
    } else {
        eHTML.listenAddress.innerHTML = '<li>No Listen Address</li>';
    }
    eHTML.lastLegitimacy.textContent = data.lastLegitimacy;
    if (data.peers) {
        renderPeers(data.peers);
    } else {
        console.warn('peerIds is not an array:', data.peerIds);
        eHTML.peersConnectedList.innerHTML = '<li>No peers available.</li>';
    }

    renderPeersHeight(data.peerHeights);

    /*if (data.repScores) {
        renderScores(data.repScores);
    }*/

    if (data.ignoreIncomingBlocks !== undefined) {
        updateToggle(data.ignoreIncomingBlocks, eHTML.ignoreBlocksToggle);
    }

    if (data.disabledSync !== undefined) {
        updateToggle(data.disabledSync, eHTML.disabledSyncToggle);
    }
}
function updateToggle(isIgnoring, eHTML_object) {
    const button = eHTML_object.button;
    const status = eHTML_object.status;
    
    if (isIgnoring) {
        button.classList.add('active');
        button.setAttribute('aria-pressed', 'true');
        status.textContent = 'ON';
        status.classList.add('bg-purple-600', 'text-white');
        status.classList.remove('bg-gray-600', 'text-gray-100');
    } else {
        button.classList.remove('active');
        button.setAttribute('aria-pressed', 'false');
        status.textContent = 'OFF';
        status.classList.add('bg-gray-600', 'text-gray-100');
        status.classList.remove('bg-purple-600', 'text-white');
    }
}
function renderPeers(peers) {
    eHTML.peersConnectedList.innerHTML = ''; // Clear existing list

    const peerEntries = Object.entries(peers);

    if (peerEntries.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No peers connected.';
        eHTML.peersConnectedList.appendChild(li);
        return;
    }

    peerEntries.forEach(([peerId, peerInfo]) => {
        const li = document.createElement('li');
        li.classList.add('peer-item'); // Optional: Add a class for styling

        // Create a span to hold the peer ID
        const peerSpan = document.createElement('span');
        peerSpan.textContent = readableId(peerId);
        peerSpan.classList.add('peer-id'); // Optional: Add a class for styling

        // Create a div to hold peer information
        const infoDiv = document.createElement('div');
        infoDiv.classList.add('peer-info');

        // Add peer status
        const statusSpan = document.createElement('span');
        statusSpan.textContent = `Status: ${peerInfo.status || 'Unknown'}`;
        statusSpan.classList.add('peer-status');

        // Add peer address
        const addressSpan = document.createElement('span');
        addressSpan.textContent = `Address: ${peerInfo.address || 'N/A'}`;
        addressSpan.classList.add('peer-address');

        // Add dialable info
        const dialableSpan = document.createElement('span');
        const isDialable = peerInfo.dialable ? 'Yes' : 'No';
        dialableSpan.textContent = `Dialable: ${isDialable}`;
        dialableSpan.classList.add('peer-dialable');

        // Append info to infoDiv
        infoDiv.appendChild(statusSpan);
        infoDiv.appendChild(document.createElement('br')); // Line break
        infoDiv.appendChild(addressSpan);
        infoDiv.appendChild(document.createElement('br')); // Line break
        infoDiv.appendChild(dialableSpan);

        // Create Disconnect Button
        const disconnectBtn = document.createElement('button');
        disconnectBtn.textContent = 'Disconnect';
        disconnectBtn.classList.add('disconnect-peer-btn'); // Add class for styling
        disconnectBtn.dataset.peerId = peerId; // Store peerId for reference

        // Create Ban Button
        const banBtn = document.createElement('button');
        banBtn.textContent = 'Ban';
        banBtn.classList.add('ban-peer-btn'); // Add class for styling
        banBtn.dataset.peerId = peerId; // Store peerId for reference

        // Create Ask Sync Button
        const askSyncBtn = document.createElement('button');
        askSyncBtn.textContent = 'Ask Sync';
        askSyncBtn.classList.add('ask-peer-sync-btn'); // Add class for styling
        askSyncBtn.dataset.peerId = peerId; // Store peerId for reference

        // Append elements to the list item
        li.appendChild(peerSpan);
        li.appendChild(infoDiv);
        li.appendChild(disconnectBtn);
        li.appendChild(banBtn);
        li.appendChild(askSyncBtn);

        eHTML.peersConnectedList.appendChild(li);
    });
}
function renderPeersHeight(peers) {
    eHTML.peersHeightList.innerHTML = ''; // Clear existing list

    if (Object.keys(peers).length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No peer heights available.';
        eHTML.peersHeightList.appendChild(li);
        return;
    }

    for (const [peerId, height] of Object.entries(peers)) {
        const li = document.createElement('li');
        li.classList.add('peer-height-item');

        const peerSpan = document.createElement('span');
        peerSpan.textContent = `${readableId(peerId)}: `;
        peerSpan.classList.add('peer-id');

        const heightSpan = document.createElement('span');
        heightSpan.textContent = height;
        heightSpan.classList.add('peer-height');

        li.appendChild(peerSpan);
        li.appendChild(heightSpan);

        eHTML.peersHeightList.appendChild(li);
    }

}
function renderScores(scores) {
    eHTML.repScoresList.innerHTML = ''; // Clear existing list

    if (scores.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No reputation scores available.';
        eHTML.repScoresList.appendChild(li);
        return;
    }

    scores.forEach(score => {
        const li = document.createElement('li');
        li.textContent = score.identifier.replace('12D3KooW', '') + ': ' + score.score;
        eHTML.repScoresList.appendChild(li);
    });
}
/**
 * @typedef {Object} ModalOptions
 * @property {string} [message] - default 'Are you sure?'
 * @property {string} [inputLabel] - default 'Input:'
 * @property {string} [inputType] - default 'text'
 * @property {string} [inputPlaceholder] - default ''
 * @property {boolean} [showInput] - default false */
/** @param {string} action @param {ModalOptions} options */
function openModal(action, options) {
    if (modalOpen) { return; }
    modalOpen = true;
    currentAction = action;

    const modal = eHTML.modals.unifiedModal;
    modal.message.textContent = options.message || 'Are you sure?';
    modal.inputSection.classList.add('hidden');
    if (options.showInput) { modal.inputSection.classList.remove('hidden'); }
    modal.inputLabel.textContent = options.inputLabel || 'Input:';
    
    modal.input.value = '';
    modal.input.type = options.inputType || 'text';
    modal.input.placeholder = options.inputPlaceholder || options.inputType === 'password' ? 'Enter your private key' : '';
    
    modal.toggleInputBtn.textContent = 'Show';
    modal.toggleInputBtn.style.display = options.inputType === 'password' ? 'inline' : 'none';

    eHTML.modals.wrap.classList.remove('hidden', 'fold'); // Remove both classes
    modal.wrap.classList.remove('hidden'); // Ensure modal is visible

    eHTML.modals.wrap.style.transform = 'scaleX(0) scaleY(0) skewX(0deg)';
    eHTML.modals.wrap.style.opacity = 0;
    eHTML.modals.wrap.style.clipPath = 'circle(6% at 50% 50%)';

    anime({
        targets: eHTML.modals.wrap,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        duration: 400,
        easing: 'easeOutQuad',
        complete: () => { if (options.showInput) { modal.input.focus(); } else { modal.confirmBtn.focus(); } }
    });
    anime({
        targets: eHTML.modals.wrap,
        clipPath: 'circle(100% at 50% 50%)',
        duration: 800,
        easing: 'easeOutQuad',
    });
}
function confirmModal() {
    console.log('Confirm button clicked with action:', currentAction);
    switch (currentAction) {
        case ACTIONS.SETUP:
            console.log('Setup: setting private key');
            const setupPrivKey = eHTML.modals.unifiedModal.input.value.trim();
            if (!setupPrivKey) { alert('Private key is required for setup.'); return; }
            ws.send(JSON.stringify({ type: 'set_private_key', data: setupPrivKey }));
            break;
        case ACTIONS.SET_VALIDATOR_ADDRESS:
            console.log('Set Validator Address:', eHTML.modals.unifiedModal.input.value.trim());
            const newValidatorAddress = eHTML.modals.unifiedModal.input.value.trim();
            if (!newValidatorAddress) { alert('Validator address cannot be empty.'); return; }
            ws.send(JSON.stringify({ type: 'set_validator_address', data: newValidatorAddress }));
            break;
        case ACTIONS.SET_MINER_ADDRESS:
            console.log('Set Miner Address:', eHTML.modals.unifiedModal.input.value.trim());
            const newMinerAddress = eHTML.modals.unifiedModal.input.value.trim();
            if (!newMinerAddress) { alert('Miner address cannot be empty.'); return; }
            ws.send(JSON.stringify({ type: 'set_miner_address', data: newMinerAddress }));
            break;
        case ACTIONS.HARD_RESET:
            console.log('Hard Reset:', nodeId);
            ws.send(JSON.stringify({ type: 'hard_reset', data: nodeId }));
            break;
        case ACTIONS.UPDATE_GIT:
            console.log('Update Git:', nodeId);
            ws.send(JSON.stringify({ type: 'update_git', data: nodeId }));
            break;
        case ACTIONS.FORCE_RESTART:
            ws.send(JSON.stringify({ type: 'force_restart', data: nodeId }));
            break;
        case ACTIONS.REVALIDATE:
            ws.send(JSON.stringify({ type: 'force_restart_revalidate_blocks', data: nodeId }));
            break;
        case ACTIONS.RESET_WALLET:
            const resetPrivKey = eHTML.modals.unifiedModal.input.value.trim();
            if (!resetPrivKey) { alert('Private key is required to reset the wallet.'); return; }
            ws.send(JSON.stringify({ type: 'reset_wallet', data: resetPrivKey }));
            break;

        case 'disconnect_peer':
            const disconnectPeerId = currentActionPeerId; 
            console.log('Disconnecting peer:', disconnectPeerId);
            ws.send(JSON.stringify({ type: 'disconnect_peer', data: disconnectPeerId }));
            break;
        case 'ask_sync_peer':
            const askSyncPeerId = currentActionPeerId; 
            console.log('Asking peer to sync:', askSyncPeerId);
            ws.send(JSON.stringify({ type: 'ask_sync_peer', data: askSyncPeerId }));
            break;
        case 'ban_peer':
            const banPeerId = currentActionPeerId;
            console.log('Banning peer:', banPeerId);
            ws.send(JSON.stringify({ type: 'ban_peer', data: banPeerId }));
            break;  
        default:
            console.error('Unknown action:', currentAction);
    }
    closeModal();
};
function closeModal() {
    if (!modalOpen) return;
    modalOpen = false;
    currentAction = null;

    if (eHTML.modals.wrap.classList.contains('fold')) return;
    eHTML.modals.wrap.classList.add('fold');

    anime({
        targets: eHTML.modals.wrap,
        clipPath: 'circle(6% at 50% 50%)',
        scaleX: 0,
        scaleY: 0,
        opacity: 0,
        duration: 800,
        easing: 'easeOutQuad',
        complete: () => {
            if (!eHTML.modals.wrap.classList.contains('fold')) return;
            eHTML.modals.wrap.classList.add('hidden');
            eHTML.modals.wrap.classList.remove('fold'); // Reset for next use
        }
    });
}

// EVENT LISTENERS
document.addEventListener('submit', function(event) { event.preventDefault(); });
document.addEventListener('input', async (event) => {
    if (event.target.classList.contains('amountInput')) {
        event.target.value = event.target.value.replace(/[^\d.]/g, '');
        const nbOfDecimals = event.target.value.split('.')[1] ? event.target.value.split('.')[1].length : 0;
        if (nbOfDecimals > 6) { event.target.value = parseFloat(event.target.value).toFixed(6); }
    }
});
document.addEventListener('focusin', async (event) => {
    if (event.target.classList.contains('amountInput')) { event.target.value = ''; }
});
document.addEventListener('focusout', async (event) => {
    if (event.target.classList.contains('amountInput')) {
        if (isNaN(parseFloat(event.target.value))) { event.target.value = ''; return; }
        event.target.value = parseFloat(event.target.value).toFixed(6);

        const amountMicro = parseInt(event.target.value.replace('.',''));
        const formatedValue = convert.formatNumberAsCurrency(amountMicro);
        event.target.value = formatedValue;
    }
});
eHTML.minerThreads.input.addEventListener('change', async (event) => {
    console.log('set_miner_threads', eHTML.minerThreads.input.value);
    ws.send(JSON.stringify({ type: 'set_miner_threads', data: eHTML.minerThreads.input.value }));
});
document.addEventListener('click', async (event) => {
    if (window.parent && window !== window.parent) window.parent.postMessage({ type: 'iframeClick' }, 'file://');

    const target = event.target;
    switch (target) {
        case eHTML.stakeInput.confirmBtn:
            console.log('Stake Confirm Button clicked');
            const amountToStake = parseInt(eHTML.stakeInput.input.value.replaceAll(",","").replaceAll(".",""));
            const validatorAddress = eHTML.validatorAddress.textContent;
            console.log(`amountToStake: ${amountToStake} | validatorAddress: ${validatorAddress}`);
            
            console.log('UTXOs', validatorUTXOs);
            const senderAccount = { address: validatorAddress, UTXOs: validatorUTXOs };
            const transaction = await Transaction_Builder.createStakingVss(senderAccount, validatorAddress, amountToStake);

            ws.send(JSON.stringify({ type: 'new_unsigned_transaction', data: transaction }));
            eHTML.stakeInput.input.value = '';
            break;
        case eHTML.minerThreads.decrementBtn:
            adjustInputValue(eHTML.minerThreads.input, -1);
            updateMinerThreadsDisabledButtons();
            break;
        case eHTML.minerThreads.incrementBtn:
            adjustInputValue(eHTML.minerThreads.input, 1);
            updateMinerThreadsDisabledButtons();
            break;
        case eHTML.minerAddressEditBtn:
            console.log('minerAddressEditBtn clicked');
            openModal(ACTIONS.SET_MINER_ADDRESS, {
                message: 'Please enter the new Miner Address:',
                inputLabel: 'Miner Address:',
                inputType: 'text',
                inputPlaceholder: 'Enter new Miner Address',
                showInput: true
            });
            break;
        case eHTML.validatorAddressEditBtn:
            console.log('validatorAddressEditBtn clicked');
            openModal(ACTIONS.SET_VALIDATOR_ADDRESS, {
                message: 'Please enter the new Validator Address:',
                inputLabel: 'Validator Address:',
                inputType: 'text',
                inputPlaceholder: 'Enter new Validator Address',
                showInput: true
            });
            break;
        case target.classList.contains('disconnect-peer-btn'):
            currentActionPeerId = target.dataset.peerId;
            openModal('disconnect_peer', { message: `Are you sure you want to disconnect peer ${target.dataset.peerId}?`, showInput: false });
            break;
        case target.classList.contains('ask-peer-sync-btn'):
            currentActionPeerId = target.dataset.peerId;
            openModal('ask_sync_peer', { message: `Do you want to request a sync from peer ${target.dataset.peerId}?`, showInput: false });
            break;
        case target.classList.contains('ban-peer-btn'):
            currentActionPeerId = target.dataset.peerId;
            openModal('ban_peer', { message: `Are you sure you want to ban peer ${target.dataset.peerId}?`, showInput: false });
            break;
        case eHTML.modals.unifiedModal.toggleInputBtn:
            togglePasswordVisibility(eHTML.modals.unifiedModal.input, eHTML.modals.unifiedModal.toggleInputBtn);
            break;
        case eHTML.modals.unifiedModal.confirmBtn:
            confirmModal();
            break;
        case eHTML.modals.unifiedModal.cancelBtn:
            console.log('Cancel button clicked');
            closeModal();
            break;
        case eHTML.modals.modalsWrapBackground:
            console.log('Modal-Background clicked');
            closeModal();
            break;
        case eHTML.ignoreBlocksToggle.button:
            console.log('ignoreBlocksToggle button clicked');
            ws.send(JSON.stringify({
                type: 'ignore_incoming_blocks',
                data: !eHTML.ignoreBlocksToggle.button.classList.contains('active')
            }));
            updateToggle(newState, eHTML.ignoreBlocksToggle);
            break;
        case eHTML.disabledSyncToggle.button:
            console.log('disabledSyncToggle button clicked');
            ws.send(JSON.stringify({
                type: 'disable_sync',
                data: !eHTML.disabledSyncToggle.button.classList.contains('active')
            }));
            updateToggle(newState, eHTML.disabledSyncToggle);
            break;
    }
});
window.addEventListener('message', function(event) {
    const data = event.data;
    if (data.type === 'darkMode' && typeof data.value === 'boolean') {
        if (data.value) { document.body.classList.add('dark-mode'); } else { document.body.classList.remove('dark-mode'); }
    }
});
document.addEventListener('mouseover', function(event) {
    if (event.target.dataset.infokey) window.parent.postMessage({ eventType: 'mouseHover', infokey: event.target.dataset.infokey }, '*');
});

function togglePasswordVisibility(inputElement, toggleButton) {
    if (inputElement.type === 'password') {
        inputElement.type = 'text';
        toggleButton.textContent = 'Hide';
    } else {
        inputElement.type = 'password';
        toggleButton.textContent = 'Show';
    }
}
function adjustInputValue(targetInput, delta, min = 0, max = 4) {
    const currentValue = parseInt(targetInput.value);
    if (isNaN(currentValue)) {
        targetInput.value = min;
    } else {
        targetInput.value = delta < 0 ? Math.max(currentValue + delta, min) : Math.min(currentValue + delta, max);
    }

    targetInput.dispatchEvent(new Event('change'));
}
function updateMinerThreadsDisabledButtons(min = 0, max = 4) {
    eHTML.minerThreads.decrementBtn.classList.remove('disabled');
    eHTML.minerThreads.incrementBtn.classList.remove('disabled');
    if (parseInt(eHTML.minerThreads.input.value) <= min) { eHTML.minerThreads.decrementBtn.classList.add('disabled'); }
    if (parseInt(eHTML.minerThreads.input.value) >= max) { eHTML.minerThreads.incrementBtn.classList.add('disabled'); }
}

/*let resizingTimeout;
window.addEventListener('resize', function() {
    clearTimeout(resizingTimeout);
    document.body.style.pointerEvents = 'none';
    resizingTimeout = setTimeout(() => {
        document.body.style.pointerEvents = 'auto';
    }, 800);
});*/