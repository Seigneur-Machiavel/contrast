//import { Transaction_Builder, UTXO } from '../src/transaction.mjs';
import { convert } from '../../utils/converters.mjs';

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
    GET_NODE_INFO_INTERVAL: 2000,
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
        if (data && data.error) { console.info(message.error); }
        switch (message.type) {
            case 'error':
                if (data === 'No active node' && !modalOpen) {
                    openModal(ACTIONS.SETUP, {
                        message: 'No active node detected. Please set up your private key.',
                        inputLabel: 'Private Key:',
                        inputType: 'password',
                        showInput: true,
                        showToggle: true
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

async function getGetNodeInfoLoop() {
    while (true) {
        await new Promise((resolve) => { setTimeout(() => { resolve(); }, WS_SETTINGS.GET_NODE_INFO_INTERVAL); });
        if (!ws || ws.readyState !== 1) { continue; }
        try { ws.send(JSON.stringify({ type: 'get_node_info', data: Date.now() })) } catch (error) {};
    }
}; 
getGetNodeInfoLoop();
connectWS();

const eHTML = {
    dashboard: (nodeID) => document.getElementById(`dashboard-${nodeID}`),
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
    minerBalance: document.getElementById('minerBalance'),
    hashRate: document.getElementById('hashRate'),

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
    nodeState: document.getElementById('nodeState'),
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

// Function to display node information
function displayNodeInfo(data) {
    /** @type {StakeReference[]} */
    const validatorStakesReference = data.validatorStakes ? data.validatorStakes : false;
    const validatorStaked = validatorStakesReference ? validatorStakesReference.reduce((acc, stake) => acc + stake.amount, 0) : 0;
    const validatorBalance = data.validatorBalance ? data.validatorBalance : 0;
    const minerBalance = data.minerBalance ? data.minerBalance : 0;

    // Update roles
    eHTML.roles.textContent = data.roles.join(' - ');

    // Update Validator information
    eHTML.validatorAddress.textContent = data.validatorAddress ? data.validatorAddress : ''; 
    eHTML.validatorRewardAddress.textContent = data.validatorRewardAddress ? data.validatorRewardAddress : '';
    eHTML.validatorBalance.textContent = convert.formatNumberAsCurrency(validatorBalance);
    eHTML.validatorHeight.textContent = data.currentHeight ? data.currentHeight : 0;
    eHTML.validatorStaked.textContent = convert.formatNumberAsCurrency(validatorStaked);

    // Update Miner information
    eHTML.minerAddress.textContent = data.minerAddress ? data.minerAddress : '';
    eHTML.minerBalance.textContent = convert.formatNumberAsCurrency(minerBalance);
    eHTML.minerHeight.textContent = data.highestBlockIndex ? data.highestBlockIndex : 0;
    eHTML.minerThreads.input.value = data.minerThreads ? data.minerThreads : 1;
    eHTML.hashRate.textContent = data.minerHashRate ? data.minerHashRate.toFixed(2) : 0;

    // Update Global Information
    eHTML.peersConnected.textContent = data.peersConnected ? data.peersConnected : 0;
    eHTML.lastBlockInfo.textContent = data.lastBlockInfo ? data.lastBlockInfo : 'No Block Info';
    eHTML.txInMempool.textContent = data.txInMempool;
    eHTML.averageBlockTime.textContent = data.averageBlockTime ? `${data.averageBlockTime} seconds` : '0 seconds';
    eHTML.peerId.textContent = data.peerId ? data.peerId.replace('12D3KooW', '') : 'No Peer ID';
    eHTML.nodeState.textContent = data.nodeState ? data.nodeState : 'No State';
    if (Array.isArray(data.listenAddress) && data.listenAddress.length > 0) {
        eHTML.listenAddress.innerHTML = data.listenAddress.map(address => `<li>${address}</li>`).join('');
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

    if (data.repScores) {
        renderScores(data.repScores);
    }

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
        peerSpan.textContent = peerId.replace('12D3KooW', '');
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
        disconnectBtn.classList.add('disconnect-btn'); // Add class for styling
        disconnectBtn.dataset.peerId = peerId; // Store peerId for reference

        // Create Ban Button
        const banBtn = document.createElement('button');
        banBtn.textContent = 'Ban';
        banBtn.classList.add('ban-btn'); // Add class for styling
        banBtn.dataset.peerId = peerId; // Store peerId for reference

        // Create Ask Sync Button
        const askSyncBtn = document.createElement('button');
        askSyncBtn.textContent = 'Ask Sync';
        askSyncBtn.classList.add('ask-sync-btn'); // Add class for styling
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

function renderPeersHeight (peers) {
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
        peerSpan.textContent = `${peerId.replace('12D3KooW', '')}: `;
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
// Add event listener to the peersConnectedList for delegation
eHTML.peersConnectedList.addEventListener('click', (event) => {
    const target = event.target;

    // Check if Disconnect button was clicked
    if (target.classList.contains('disconnect-btn')) {
        const peerId = target.dataset.peerId;
        handleDisconnectPeer(peerId);
    }

    // Check if Ask Sync button was clicked
    if (target.classList.contains('ask-sync-btn')) {
        const peerId = target.dataset.peerId;
        handleAskSyncPeer(peerId);
    }

    // Check if Ban button was clicked

    if (target.classList.contains('ban-btn')) {
        const peerId = target.dataset.peerId;
        console.log('Ban button clicked for peer:', peerId);
        handleBanPeer(peerId);
    }
});

function handleDisconnectPeer(peerId) {
    console.log(`Disconnecting peer: ${peerId}`);
    currentAction = 'disconnect_peer';
    currentActionPeerId = peerId;
    openModal('disconnect_peer', {
        message: `Are you sure you want to disconnect peer ${peerId}?`,
        showInput: false
    });
}

function handleBanPeer(peerId) {
    console.log(`Banning peer: ${peerId}`);
    currentAction = 'ban_peer';
    currentActionPeerId = peerId;
    openModal('ban_peer', {
        message: `Are you sure you want to ban peer ${peerId}?`,
        showInput: false
    });
}


function handleAskSyncPeer(peerId) {
    console.log(`Asking peer ${peerId} to sync`);
    currentAction = 'ask_sync_peer';
    currentActionPeerId = peerId;
    openModal('ask_sync_peer', {
        message: `Do you want to request a sync from peer ${peerId}?`,
        showInput: false
    });
}


// Event listeners for modals
eHTML.modals.wrap.addEventListener('click', (event) => {
    if (event.target === eHTML.modals.modalsWrapBackground) { closeModal(); }
});

// Unified modal confirm button
eHTML.modals.unifiedModal.confirmBtn.addEventListener('click', () => {
    console.log('Confirm button clicked with action:', currentAction);
    switch (currentAction) {
        case ACTIONS.SETUP:
            console.log('Setup: setting private key');
            const setupPrivKey = eHTML.modals.unifiedModal.input.value.trim();
            if (!setupPrivKey) {
                alert('Private key is required for setup.');
                return;
            }
            ws.send(JSON.stringify({ type: 'set_private_key', data: setupPrivKey }));
            break;
        case ACTIONS.SET_VALIDATOR_ADDRESS:
            console.log('Set Validator Address:', eHTML.modals.unifiedModal.input.value.trim());
            const newValidatorAddress = eHTML.modals.unifiedModal.input.value.trim();
            if (!newValidatorAddress) {
                alert('Validator address cannot be empty.');
                return;
            }
            ws.send(JSON.stringify({ type: 'set_validator_address', data: newValidatorAddress }));
            break;
        case ACTIONS.SET_MINER_ADDRESS:
            console.log('Set Miner Address:', eHTML.modals.unifiedModal.input.value.trim());
            const newMinerAddress = eHTML.modals.unifiedModal.input.value.trim();
            if (!newMinerAddress) {
                alert('Miner address cannot be empty.');
                return;
            }
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
            if (!resetPrivKey) {
                alert('Private key is required to reset the wallet.');
                return;
            }
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
    currentAction = null;
    closeModal();
});

// Unified modal cancel button
eHTML.modals.unifiedModal.cancelBtn.addEventListener('click', () => {
    currentAction = null;
    closeModal();
});

// Toggle password visibility in unified modal
eHTML.modals.unifiedModal.toggleInputBtn.addEventListener('click', () => {
    togglePasswordVisibility(eHTML.modals.unifiedModal.input, eHTML.modals.unifiedModal.toggleInputBtn);
});

// Validator Address Edit Button
eHTML.validatorAddressEditBtn.addEventListener('click', () => {
    console.log('validatorAddressEditBtn clicked');
    openModal(ACTIONS.SET_VALIDATOR_ADDRESS, {
        message: 'Please enter the new Validator Address:',
        inputLabel: 'Validator Address:',
        inputType: 'text',
        inputPlaceholder: 'Enter new Validator Address',
        showInput: true,
        showToggle: false
    });
});


// Miner Address Edit Button
eHTML.minerAddressEditBtn.addEventListener('click', () => {
    console.log('minerAddressEditBtn clicked');
    openModal(ACTIONS.SET_MINER_ADDRESS, {
        message: 'Please enter the new Miner Address:',
        inputLabel: 'Miner Address:',
        inputType: 'text',
        inputPlaceholder: 'Enter new Miner Address',
        showInput: true,
        showToggle: false
    });
});

if (eHTML.ignoreBlocksToggle.button) {
    eHTML.ignoreBlocksToggle.button.addEventListener('click', () => {
        console.log('ignoreBlocksToggle button clicked');
        const currentState = eHTML.ignoreBlocksToggle.button.classList.contains('active');
        const newState = !currentState;
        
        // Send the new state to the backend
        ws.send(JSON.stringify({
            type: 'ignore_incoming_blocks',
            data: newState
        }));
        
        // Update the toggle state immediately for responsive UI
        updateToggle(newState, eHTML.ignoreBlocksToggle);
    });
}

if (eHTML.disabledSyncToggle.button) {
    eHTML.disabledSyncToggle.button.addEventListener('click', () => {
        console.log('disabledSyncToggle button clicked');
        const currentState = eHTML.disabledSyncToggle.button.classList.contains('active');
        const newState = !currentState;

        // Send the new state to the backend
        ws.send(JSON.stringify({
            type: 'disable_sync',
            data: newState
        }));

        // Update the toggle state immediately for responsive UI
        updateToggle(newState, eHTML.disabledSyncToggle);
    });
}
// Prevent form submission
document.addEventListener('submit', function(event) { event.preventDefault(); });

// Input validation
document.addEventListener('input', async (event) => {
    const amountInput = event.target.classList.contains('amountInput');
    if (amountInput) {
        console.log('amountInput input');
        event.target.value = event.target.value.replace(/[^\d.]/g, '');
        const nbOfDecimals = event.target.value.split('.')[1] ? event.target.value.split('.')[1].length : 0;
        if (nbOfDecimals > 6) { event.target.value = parseFloat(event.target.value).toFixed(6); }
    }
});

document.addEventListener('focusout', async (event) => {
    const amountInput = event.target.classList.contains('amountInput');
    if (amountInput) {
        console.log('amountInput focusout');
        if (isNaN(parseFloat(event.target.value))) { event.target.value = ''; return; }
        event.target.value = parseFloat(event.target.value).toFixed(6);

        const amountMicro = parseInt(event.target.value.replace('.',''));
        const formatedValue = convert.formatNumberAsCurrency(amountMicro);
        event.target.value = formatedValue;
    }
});

// Stake Input Confirm Button
eHTML.stakeInput.confirmBtn.addEventListener('click', async () => {
    console.warn('Stacking fnc() is disabled');
    return;

    const amountToStake = parseInt(eHTML.stakeInput.input.value.replace(",","").replace(".",""));
    const validatorAddress = eHTML.validatorAddress.textContent;
    console.log(`amountToStake: ${amountToStake} | validatorAddress: ${validatorAddress}`);
    
    console.log('UTXOs', validatorUTXOs);
    const senderAccount = { address: validatorAddress, UTXOs: validatorUTXOs };
    const transaction = await Transaction_Builder.createStakingVss(senderAccount, validatorAddress, amountToStake);

    ws.send(JSON.stringify({ type: 'new_unsigned_transaction', data: transaction }));
    eHTML.stakeInput.input.value = 0;
});

// Miner Threads Event Listeners
eHTML.minerThreads.input.addEventListener('change', () => {
    console.log('set_miner_threads', eHTML.minerThreads.input.value);
    ws.send(JSON.stringify({ type: 'set_miner_threads', data: eHTML.minerThreads.input.value }));
});
eHTML.minerThreads.decrementBtn.addEventListener('click', () => adjustInputValue(eHTML.minerThreads.input, -1));
eHTML.minerThreads.incrementBtn.addEventListener('click', () => adjustInputValue(eHTML.minerThreads.input, 1));

// Admin Panel Toggle Button
eHTML.toggleAdminPanelBtn.addEventListener('click', toggleAdminPanel);
function toggleAdminPanel() {
    const isHidden = eHTML.adminPanelButtons.classList.contains('hidden');

    if (isHidden) {
        // Show the panel
        console.log('toggleAdminPanelBtn clicked - Show');
        eHTML.adminPanelButtons.classList.remove('hidden');
        // Ensure the element is visible and has a maxHeight of 0 for the animation to start
        eHTML.adminPanelButtons.style.maxHeight = '0px';
        // Force a reflow to apply the maxHeight before animating
        eHTML.adminPanelButtons.offsetHeight; // This forces the browser to recognize the change

        // Get the full height of the panel
        const fullHeight = eHTML.adminPanelButtons.scrollHeight + 'px';

        anime({
            targets: eHTML.adminPanelButtons,
            maxHeight: [0, fullHeight],
            duration: 200,
            easing: 'easeInOutQuad',
            begin: () => {
                eHTML.toggleAdminPanelBtn.textContent = 'Hide Admin Panel';
                eHTML.adminPanelButtons.style.overflow = 'hidden'; // Ensure overflow is hidden during animation
            },
            complete: () => {
                // Optionally, remove the maxHeight to allow the panel to adjust dynamically if content changes
                eHTML.adminPanelButtons.style.maxHeight = 'none';
            }
        });
    } else {
        // Hide the panel
        console.log('toggleAdminPanelBtn clicked - Hide');
        // Get the current height to animate from
        const currentHeight = eHTML.adminPanelButtons.scrollHeight;

        anime({
            targets: eHTML.adminPanelButtons,
            maxHeight: [currentHeight + 'px', 0],
            duration: 200,
            easing: 'easeInOutQuad',
            begin: () => {
                eHTML.toggleAdminPanelBtn.textContent = 'Show Admin Panel';
                eHTML.adminPanelButtons.style.overflow = 'hidden'; // Ensure overflow is hidden during animation
            },
            complete: () => {
                eHTML.adminPanelButtons.classList.add('hidden');
                eHTML.adminPanelButtons.style.maxHeight = '0px';
                // Optionally, reset overflow
                eHTML.adminPanelButtons.style.overflow = '';
            }
        });
    }
}


// Admin Buttons Event Listeners
eHTML.forceRestartBtn.addEventListener('click', () => {
    console.log('forceRestartBtn clicked'); // Debugging line
    currentAction = ACTIONS.FORCE_RESTART;
    openModal(ACTIONS.FORCE_RESTART, {
        message: 'Are you sure you want to restart the node? This action may interrupt ongoing processes.',
        showInput: false
    });
});


eHTML.RevalidateBtn.addEventListener('click', () => {
    currentAction = ACTIONS.REVALIDATE;
    openModal(ACTIONS.REVALIDATE, {
        message: 'Are you sure you want to revalidate the blocks? This may take some time.',
        showInput: false
    });
});

eHTML.resetInfoBtn.addEventListener('click', () => {
    console.log('resetInfoBtn clicked');
    currentAction = ACTIONS.RESET_WALLET;
    openModal(ACTIONS.RESET_WALLET, {
        message: 'Are you sure you want to reset the wallet? Please enter your private key below.',
        inputLabel: 'Private Key:',
        inputType: 'password',
        showInput: true,
        showToggle: true
    });
});

eHTML.hardResetBtn.addEventListener('click', () => {
    console.log('hardResetBtn clicked');
    currentAction = ACTIONS.HARD_RESET;
    openModal(ACTIONS.HARD_RESET, {
        message: 'Are you sure you want to perform a hard reset? This will reset all data and resync the chain.',
        showInput: false
    });
});

eHTML.updateGitBtn.addEventListener('click', () => {
    console.log('updateGitBtn clicked');
    currentAction = ACTIONS.UPDATE_GIT;
    openModal(ACTIONS.UPDATE_GIT, {
        message: 'Do you want to update the client using Git?',
        showInput: false
    });
});

eHTML.modals.unifiedModal.cancelBtn.addEventListener('click', () => {
    console.log('Cancel button clicked');
    currentAction = null;
    closeModal();
});


// Function to open unified modal
function openModal(action, options) {
    if (modalOpen) { return; }
    modalOpen = true;
    currentAction = action;

    const modals = eHTML.modals;
    const modal = modals.unifiedModal;

    // Set the message
    modal.message.textContent = options.message || 'Are you sure?';

    // Handle dynamic input
    if (options.showInput) {
        modal.inputSection.style.display = 'block';
        modal.inputLabel.textContent = options.inputLabel || 'Input:';
        modal.input.type = options.inputType || 'text';
        modal.input.value = ''; // Clear previous value

        // Set placeholder dynamically
        if (options.inputPlaceholder) {
            modal.input.placeholder = options.inputPlaceholder;
        } else {
            // Default placeholder based on input type
            modal.input.placeholder = options.inputType === 'password' ? 'Enter your private key' : '';
        }

        if (options.inputType === 'password') {
            modal.toggleInputBtn.style.display = 'inline';
            modal.input.type = 'password';
            modal.toggleInputBtn.textContent = 'Show';
        } else {
            modal.toggleInputBtn.style.display = 'none';
        }
    } else {
        modal.inputSection.style.display = 'none';
        modal.input.value = '';
    }

    // Show the modal
    modals.wrap.classList.remove('hidden', 'fold'); // Remove both classes
    modal.wrap.classList.remove('hidden'); // Ensure modal is visible

    // Initialize animation properties
    modals.wrap.style.transform = 'scaleX(0) scaleY(0) skewX(0deg)';
    modals.wrap.style.opacity = 0;
    modals.wrap.style.clipPath = 'circle(6% at 50% 50%)';

    // Animate the modal appearance
    anime({
        targets: modals.wrap,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        duration: 1000,
        easing: 'easeOutQuad',
        complete: () => {
            if (options.showInput) {
                modal.input.focus();
                console.log('Focused on input field.');
            } else {
                modal.confirmBtn.focus();
                console.log('Focused on confirm button.');
            }
        }
    });
    anime({
        targets: modals.wrap,
        clipPath: 'circle(100% at 50% 50%)',
        delay: 200,
        duration: 800,
        easing: 'easeOutQuad',
    });
}


// Function to close unified modal
function closeModal() {
    if (!modalOpen) { return false; }
    modalOpen = false;
    const modals = eHTML.modals;
    const modal = modals.unifiedModal;
    const modalsWrap = modals.wrap;

    if (modalsWrap.classList.contains('fold')) { return false; }
    modalsWrap.classList.add('fold');

    anime({
        targets: modalsWrap,
        clipPath: 'circle(6% at 50% 50%)',
        duration: 600,
        easing: 'easeOutQuad',
    });
    anime({
        targets: modals.wrap,
        scaleX: 0,
        scaleY: 0,
        opacity: 0,
        duration: 800,
        easing: 'easeOutQuad',
        complete: () => {
            if (!modalsWrap.classList.contains('fold')) { return; }

            modals.wrap.classList.add('hidden');
            modal.input.value = '';
            modal.inputSection.style.display = 'none';
            modalsWrap.classList.remove('fold'); // Reset for next use
        }
    });
}

function togglePasswordVisibility(inputElement, toggleButton) {
    if (inputElement.type === 'password') {
        inputElement.type = 'text';
        toggleButton.textContent = 'Hide';
    } else {
        inputElement.type = 'password';
        toggleButton.textContent = 'Show';
    }
}
function adjustInputValue(targetInput, delta, min = 1, max = 4) {
    const currentValue = parseInt(targetInput.value);
    if (isNaN(currentValue)) {
        targetInput.value = min;
    } else {
        if (delta < 0) {
            targetInput.value = Math.max(currentValue + delta, min);
        } else {
            targetInput.value = Math.min(currentValue + delta, max);
        }
    }
    targetInput.dispatchEvent(new Event('change'));
}
