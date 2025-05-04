await new Promise((resolve) => { setTimeout(() => { resolve(); }, 1); });
console.log('run/explorerScript.mjs');
if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const anime = require('animejs');
    const Plotly = require('plotly.js-dist-min');
}

//import { StakeReference } from '../src/vss.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { convert } from '../../utils/converters.mjs';
import { typeValidation } from '../../utils/type-validation.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';
import { Transaction_Builder, utxoExtraction } from '../src/transaction.mjs';

/**
* @typedef {import("../src/block-classes.mjs").BlockHeader} BlockHeader
* @typedef {import("../src/block-classes.mjs").BlockInfo} BlockInfo
* @typedef {import("../src/block-classes.mjs").BlockData} BlockData
* @typedef {import("../src/transaction.mjs").Transaction} Transaction
* @typedef {import("../src/transaction.mjs").UTXO} UTXO
* @typedef {Object} StakeReference
* @property {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
* @property {string} anchor - Example: "0:bdadb7ab:0"
* @property {number} amount - Example: 100
* 
* @typedef {Object<string, StakeReference | undefined>} Spectrum
*/

const isIFrame = window.parent && window !== window.parent;
let pageFocused = true;
document.addEventListener("visibilitychange", function() { pageFocused = document.visibilityState === 'visible'; });
/** @type {WebSocket} */
let ws;
async function readyWS() {
    return new Promise((resolve, reject) => {
        if (ws.readyState === 1) resolve();
        let interval = setInterval(() => {
            if (ws.readyState === 1) {
                clearInterval(interval);
                resolve();
            }
        }, 100);
    });
}
async function sendWsWhenReady(message) {
    await readyWS();
    ws.send(JSON.stringify(message));
}
const SETTINGS = {
    HTTP_PROTOCOL: "http", // http or https
    WS_PROTOCOL: window.location.protocol === "https:" ? "wss" : "ws",
    DOMAIN: window.explorerDOMAIN || window.location.hostname,
    PORT: window.explorerPORT || window.location.port,

    LOCAL_DOMAIN: "localhost",
    LOCAL_PORT: "27270",
    //LOCAL: window.explorerLOCAL || false,
    LOCAL: (window.parent && window !== window.parent) || window.location.hostname === 'localhost' ? true : false,
    //LOCAL: window.location.hostname === 'localhost' ? true : false,
    RECONNECT_INTERVAL: 2000,
    GET_CURRENT_HEIGHT_INTERVAL: window.location.hostname === 'localhost' ? 1000 : 5000,
    ROLES: window.explorerROLES || ['chainExplorer', 'blockExplorer'],

    AUTO_CHOSE_BEST_NODES: false, // window.location.hostname === 'localhost' ? false : true, // EXPERIMENTAL
    CURRENT_NODE_INDEX: 0,
    NODES_LIST: [ // used for redondant connections
        'ws://localhost:27270',
        'ws://pinkparrot.observer',
        'ws://pinkparrot.science:27270',
        'wss://contrast.observer',
        'ws://pariah.monster:27270'
    ],

    NB_OF_CONFIRMED_BLOCKS: window.explorerNB_OF_CONFIRMED_BLOCKS || 3, //5,
    NB_OF_UNCONFIRMED_BLOCKS: window.explorerNB_OF_UNCONFIRMED_BLOCKS || 2,
}
//#region WEB SOCKET
function onOpen() {
    console.log('Connection opened');
    ws.send(JSON.stringify({ type: 'get_cached_blocks_timestamps' }));
    ws.send(JSON.stringify({ type: 'get_round_legitimacies' }));
    ws.send(JSON.stringify({ type: 'get_vss_spectrum' }));
    ws.send(JSON.stringify({ type: 'get_biggests_holders_balances' }));
}
function onClose(url = '') {
    console.info(`Connection closed: ${url}`);
    ws = null;
}
function onError(error) {
    console.info('WebSocket error: ' + error);
}
async function onMessage(event) {
    if (!pageFocused) return;
    const message = JSON.parse(event.data);
    const trigger = message.trigger;
    const data = message.data;
    
    /** @type {BlockExplorerWidget} */
    const blockExplorerWidget = window.blockExplorerWidget;
    if (!blockExplorerWidget) return;

    const lastBlockInfoIndex = blockExplorerWidget.lastBlockInfoIndex;
    switch (message.type) {
        case 'blocks_timestamps_requested':
            if (!data || typeof data !== 'object') return;
            displayBlocksTimestampsChart(data);
            //displayBlocksTimestampsChartD3(data);
            break;
        case 'current_height':
            console.info(`current_height #${data} | lastBlockIndex #${lastBlockInfoIndex} -> `);
            //if (lastBlockInfoIndex === -1) return;
            if (data === lastBlockInfoIndex) return;
            if (data === lastBlockInfoIndex + 1) { // need the new block
                console.info(`get_new_block_confirmed #${data} sent`);
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'get_new_block_confirmed', data: data }))
                return;
            }

            if (data !== lastBlockInfoIndex) {
                console.info(`current_height #${data} !== lastBlockIndex #${lastBlockInfoIndex} || lastBlockIndex+1 #${lastBlockInfoIndex+1} -> ws.close()`);
                try { ws.close() } catch (error) {};
                return;
            }
            break;
        case 'last_confirmed_blocks':
            if (!data || !data[data.length - 1]) return;
            //console.log(`last_confirmed_block from ${data[0].header.index} to ${data[data.length - 1].header.index}`);
            //console.log('last_confirmed_block', data[data.length - 1]);
            const blocksToDisplay = data.length > SETTINGS.NB_OF_CONFIRMED_BLOCKS ? data.slice(data.length - SETTINGS.NB_OF_CONFIRMED_BLOCKS) : data;
            displayLastConfirmedBlock(blocksToDisplay[blocksToDisplay.length - 1].header);
            for (const blockInfo of blocksToDisplay) blockExplorerWidget.fillBlockInfo(blockInfo);
            break;
        case 'broadcast_new_candidate':
            //console.log('broadcast_new_candidate', data);
            ws.send(JSON.stringify({ type: 'get_round_legitimacies' }));
            break;
        case 'round_legitimacies_requested':
            //console.log('round_legitimacies_requested', data);
            eHTML.legHeight.textContent = data.height;
            displayRoundLegitimaciesChart(data.roundLegitimacies);
            break;
        case 'vss_spectrum_requested':
            //console.log('vss_spectrum_requested', data);
            displayVssChart(data);
            break;
        case 'biggests_balances_requested':
            // [{address, balance}, ...]
            //console.log('biggests_balances_requested', data);
            if (!data || data.length === 0) return;
            displayBiggestsHoldersBalancesChart(data);
            break;
        case 'new_block_confirmed':
            //console.log('new_block_confirmed', data);
            if (!data) return;
            if (data.header.index === lastBlockInfoIndex) return;
            if (data.header.index !== lastBlockInfoIndex + 1) {
                console.info('new_block_confirmed n+1 -> ws.close()');
                try { ws.close() } catch (error) {};
                return;
            }
            displayLastConfirmedBlock(data.header);
            blockExplorerWidget.fillBlockInfo(data);
            ws.send(JSON.stringify({ type: 'get_cached_blocks_timestamps' }));
            ws.send(JSON.stringify({ type: 'get_round_legitimacies' }));
            break;
        case 'blocks_data_requested':
            for (const blockData of data) { blockExplorerWidget.saveBlockData(blockData); }
            // if request was for only one block, fill the modal content
            if (data.length === 1) { blockExplorerWidget.navigateUntilTarget(false); }
            break;
        case 'block_data_requested':
            blockExplorerWidget.saveBlockData(data);
            blockExplorerWidget.navigateUntilTarget(false);
            break;
        case 'address_utxos_requested': // DEPRECATED
            // { address, UTXOs }
            blockExplorerWidget.addressesExhaustiveData[data.address] = new AddressInfo(data.UTXOs);

            blockExplorerWidget.navigateUntilTarget(true);
            break;
        case 'address_exhaustive_data_requested':
            // { address, addressUTXOs, addressTxsReferences }
            blockExplorerWidget.addressesExhaustiveData[data.address] = new AddressExhaustiveData(data.addressUTXOs.UTXOs, data.addressTxsReferences.reverse());
            blockExplorerWidget.navigateUntilTarget(true);
            break;
        case 'transaction_requested':
            console.log('transaction_requested', data);
            // { transaction, balanceChange, inAmount, outAmount, fee, txReference }
            const transactionWithDetails = data.transaction;
            transactionWithDetails.balanceChange = data.balanceChange;
            transactionWithDetails.inAmount = data.inAmount;
            transactionWithDetails.outAmount = data.outAmount;
            transactionWithDetails.fee = data.fee;
            transactionWithDetails.timestamp = data.timestamp;
            blockExplorerWidget.transactionsByReference[data.txReference] = transactionWithDetails;
            // set html
            blockExplorerWidget.fillAddressTxRow(data.txReference, data.balanceChange, data.fee, data.timestamp);
            break;
        default:
            break;
    }
}
function connectWS() {
    try { if (ws) { ws.close(); } } catch (error) {};
    let url = `${SETTINGS.WS_PROTOCOL}://${SETTINGS.DOMAIN}${SETTINGS.PORT ? ':' + SETTINGS.PORT : ''}`;
    if (SETTINGS.LOCAL) { url = `${SETTINGS.WS_PROTOCOL}://${SETTINGS.LOCAL_DOMAIN}:${SETTINGS.LOCAL_PORT}`; }

    if (SETTINGS.AUTO_CHOSE_BEST_NODES) {
        url = `${SETTINGS.NODES_LIST[SETTINGS.CURRENT_NODE_INDEX]}`;
        SETTINGS.CURRENT_NODE_INDEX++;
        if (SETTINGS.CURRENT_NODE_INDEX >= SETTINGS.NODES_LIST.length) { SETTINGS.CURRENT_NODE_INDEX = 0; }
    }

    console.log(`Connecting to ${url}`);
    ws = new WebSocket(url);
    ws.onopen = () => { onOpen(); };
    ws.onclose = () => { onClose(url); };
    ws.onerror = (error) => { onError(error); };
    ws.onmessage = (event) => { onMessage(event); };
}

async function connectWSLoop() {
    connectWS();
    while (true) {
        await new Promise((resolve) => { setTimeout(() => resolve(), SETTINGS.RECONNECT_INTERVAL); });
        if (ws && ws.readyState === 1) continue; // already connected
        // if connecting, wait... 
        while(ws && ws.readyState === 0) await new Promise(resolve => setTimeout(resolve, 100));

        console.info('--- reseting blockExplorerWidget >>>');

        const clonedData = window.blockExplorerWidget.getCloneBeforeReset();

        const newBlockExplorerWidget = new BlockExplorerWidget('cbe-contrastBlocksWidget', clonedData.blocksDataByHash, clonedData.blocksDataByIndex, clonedData.blocksInfo);
        if (clonedData.modalContainer) newBlockExplorerWidget.cbeHTML.containerDiv.appendChild(clonedData.modalContainer);
        window.blockExplorerWidget = newBlockExplorerWidget;

        connectWS();
    }
}; connectWSLoop();
async function getHeightsLoop() {
    while (true) {
        await new Promise((resolve) => { setTimeout(() => { resolve(); }, SETTINGS.GET_CURRENT_HEIGHT_INTERVAL); });
        if (!ws || ws.readyState !== 1) continue;
        try { ws.send(JSON.stringify({ type: 'get_height' })) } catch (error) {};
    }
}; getHeightsLoop();
//#endregion

const eHTML = {
    contrastBlocksWidget: document.getElementById('cbe-contrastBlocksWidget'),
    contrastExplorer: document.getElementById('cbe-contrastExplorer'),
    chainHeight: document.getElementById('cbe-chainHeight'),
    circulatingSupply: document.getElementById('cbe-circulatingSupply'),
    circulatingSupplyPercent: document.getElementById('cbe-circulatingSupplyPercent'),
    lastBlocktime: document.getElementById('cbe-lastBlocktime'),

    averageBlocksTimeGap: document.getElementById('cbe-averageBlocksTimeGap'),
    cacheBlocksTimesChart: document.getElementById('cbe-cacheBlocksTimesChart'),
    cacheBlocksValidatorsChart: document.getElementById('cbe-cacheBlocksValidatorsChart'),

    legHeight: document.getElementById('cbe-legHeight'),
    roundLegitimaciesChart: document.getElementById('cbe-roundLegitimaciesChart'),
    vssChart: document.getElementById('cbe-vssChart'),
    biggestsHoldersBalancesChart: document.getElementById('cbe-biggestsHoldersBalancesChart'),
}
//#region HTML ONE-SHOT FILLING -------------------------------------------
if (SETTINGS.ROLES.includes('chainExplorer')) {
    document.getElementById('cbe-maxSupply').textContent = convert.formatNumberAsCurrency(BLOCKCHAIN_SETTINGS.maxSupply)
    document.getElementById('cbe-targetBlocktime').textContent = `${BLOCKCHAIN_SETTINGS.targetBlockTime / 1000}s`;
    //document.getElementById('cbe-targetBlockday').textContent = `${(24 * 60 * 60) / (BLOCKCHAIN_SETTINGS.targetBlockTime / 1000)}`;
}
//#endregion --------------------------------------------------------------

const HTML_ELEMENTS_ATTRIBUTES = {
    modalContent: { widthPerc: .9, heightPerc: .9 },
}

export class BlockExplorerWidget {
    lastBlockInfoIndex = -1;
    lastCirculatingSupply = 0;
    constructor(divToInjectId = 'cbe-contrastBlocksWidget', blocksDataByHash = {}, blocksDataByIndex = {}, blocksInfo = []) {
        /** @type {Object<string, HTMLElement>} */
        this.cbeHTML = {
            containerDiv: document.getElementById(divToInjectId),
            // ELEMENTS CREATED BY THE BLOCK EXPLORER WIDGET (in javascript)
            searchMenuBtn: () => { return document.getElementById('cbe-searchMenuBtn') },
            chainWrap: () => { return document.getElementById('cbe-chainWrap') },
            modalContainer: () => { return document.getElementById('cbe-modalContainer') },
            modalContent: () => { return document.getElementById('cbe-modalContent') },
            modalContentWrap: () => { return document.getElementById('cbe-modalContentWrap') },
            txsTable: () => { return document.getElementsByClassName('cbe-TxsTable')[0] },
            txDetails: () => { return document.getElementById('cbe-TxDetails') },
        }
        /** @type {BlockChainElementsManager} */
        this.bcElmtsManager = new BlockChainElementsManager();
        //window.bcElmtsManager = this.bcElmtsManager;
        /** @type {Object<string, BlockData>} */
        this.blocksDataByHash = blocksDataByHash;
        /** @type {Object<number, BlockData>} */
        this.blocksDataByIndex = blocksDataByIndex;
        /** @type {BlockInfo[]} */
        this.blocksInfo = blocksInfo;
        /** @type {BlockInfo[]} */
        this.incomingBlocksInfo = [];
        /** @type {Object<string, AddressExhaustiveData>} */
        this.addressesExhaustiveData = {};
        /** @type {Object<string, Transaction>} */
        this.transactionsByReference = {};
        this.blocksTimeInterval = [];
        this.nbOfConfirmedBlocks = SETTINGS.NB_OF_CONFIRMED_BLOCKS; // Number of confirmed blocks to display in the block explorer
        this.targetTxIdWhileBlockModalOpenned = null;
        this.targetOutputIndexWhileTxReached = null;
        this.navigationTarget = {
            /** @type {number | string} - block index or block hash */
            blockReference: null,
            /** @type {string} */
            txId: null,
            /** @type {number} */
            outputIndex: null,
            /** @type {string} */
            address: null
        };

        this.animations = {
            newBlockDuration: 1000,
            modalDuration: 200,
            modalContainerAnim: null,
            modalContentWrapScrollAnim: null,
            modalContentSizeAnim: null,
            modalContentPositionAnim: null,
        }
        /** @type {Object<string, Function>} */
        this.clickEventsListeners = {
            'cbe-modalContainer': (event) => {
                if (event.target.id !== 'cbe-TxDetails') {
                    const cbeTxDetailsElement = this.cbeHTML.txDetails();
                    if (cbeTxDetailsElement) { cbeTxDetailsElement.remove(); }
                }

                // ensure the click is on the modal container and not on its children
                if (event.target.id !== 'cbe-modalContainer') return;

                const modalContainer = this.cbeHTML.modalContainer();
                if (!modalContainer) return;
                modalContainer.style.opacity = 0;

                this.animations.modalContainerAnim = anime({
                    targets: modalContainer,
                    backdropFilter: 'blur(0px)',
                    duration: this.animations.modalDuration * .5,
                    easing: 'easeInOutQuad',
                    delay: this.animations.modalDuration * .2,
                    complete: () => { modalContainer.remove(); }
                });
            },
            'cbe-modalContentWrap': (event) => {
                if (event.target.id === 'cbe-TxDetails') return;
                const cbeTxDetailsElement = this.cbeHTML.txDetails();
                if (cbeTxDetailsElement) { cbeTxDetailsElement.remove(); }
            },
            'cbe-blockSquare': (event) => {
                const modalContainer = this.cbeHTML.modalContainer();
                if (modalContainer) { modalContainer.remove(); }

                const blockSquare = event.target.closest('.cbe-blockSquare');
                const blockIndex = Number(blockSquare.querySelector('.cbe-blockIndex').textContent.replace('#', ''));
                if (isNaN(blockIndex)) { console.info(`todo: handle n+x blocks`); return }
        
                const blockRect = blockSquare.getBoundingClientRect();
                const blockCenter = { x: blockRect.left + blockRect.width / 2, y: blockRect.top + blockRect.height / 2 };
                
                this.newModalContainer();
                this.newModalContent(blockRect.width, blockRect.height, blockCenter);
                this.navigationTarget.blockReference = blockIndex;

                // we prepared the container and target, we can send the request
                if (this.getBlockDataFromMemoryOrSendRequest(blockIndex) === 'request sent') return;
                
                this.navigateUntilTarget(false);
            },
            'cbe-blockHash': (event) => {
                const blockHash = event.target.textContent;
                copyClipboardOrPostMessageToParent(blockHash);
            },
            'cbe-addressSpan': (event) => {
                const address = event.target.textContent;
                console.log('address span clicked', address);

                this.navigationTarget.address = address;
                sendWsWhenReady({ type: 'get_address_exhaustive_data', data: address });
                //if (this.getAddressExhaustiveDataFromMemoryOrSendRequest(address) === 'request sent') return;

                // display address infos
                //this.navigateUntilTarget(true);
            },
            'cbe-anchorSpan': (event) => {
                const anchor = event.target.textContent;
                console.log('anchor span clicked', anchor);
                this.navigationTarget.blockReference = Number(anchor.split(':')[0]);
                this.navigationTarget.txId = anchor.split(':')[1];
                this.navigationTarget.outputIndex = Number(anchor.split(':')[2]);

                if (this.getBlockDataFromMemoryOrSendRequest(this.navigationTarget.blockReference) === 'request sent') return;

                this.navigateUntilTarget(true);
            },
            'cbe-TxRow': (event) => {
                try {
                    if (this.cbeHTML.txDetails()) { this.cbeHTML.txDetails().remove(); }
        
                    const modalContentWrap = this.cbeHTML.modalContentWrap();
                    const blockIndex = modalContentWrap.getElementsByClassName('cbe-blockIndex')[0].textContent.replace('#', '');
                    const blockData = this.blocksDataByIndex[blockIndex];
                    
                    /** @type {HTMLDivElement} */
                    const rowElement = event.target.closest('.cbe-TxRow');
                    const td = rowElement.querySelector('td');
                    const txIndex = Number(td.textContent.split(' ')[0]);
                    const tx = blockData.Txs[txIndex];
                    console.log('tx', tx);
        
                    const txDetails = this.#createTransactionDetailsElement(tx);
                    rowElement.insertAdjacentElement('afterend', txDetails); // inject txDetails under row line
                } catch (error) {
                    console.error('cbe-TxRow event error:', error);
                }
            },
            'cbe-folderWrap': (event) => {
                const folderWrap = event.target.closest('.cbe-folderWrap');

                console.log(`folderWrap clicked, event target: ${event.target.className}`);
                // cbe-spacedText:first-child -> is the button
                const folderButton = folderWrap.querySelector('.cbe-spacedText:first-child');
                if (!folderButton || event.target !== folderButton) return;

                // '▼' -> '▲'
                const arrowBtn = folderButton.getElementsByClassName('.cbe-arrowBtn')[0];
                if (!arrowBtn) { console.error('folderWrap event error: arrowBtn not found'); return; }

                const isArrowDown = arrowBtn.textContent === '▼';
                arrowBtn.textContent = isArrowDown ? '▲' : '▼';
                const targetContent = isArrowDown ? folderWrap.querySelector('.cbe-folded') : folderWrap.querySelector('.cbe-unfolded');
                if (!targetContent) { console.error('folderWrap event error: targetContent not found'); return; }

                targetContent.classList.remove(isArrowDown ? 'cbe-folded' : 'cbe-unfolded');
                targetContent.classList.add(isArrowDown ? 'cbe-unfolded' : 'cbe-folded');
            },
            'cbe-addressTxRow': (event) => {
                try {
                    if (this.cbeHTML.txDetails()) this.cbeHTML.txDetails().remove();
        
                    const rowElement = event.target.closest('.cbe-addressTxRow');
                    const txReference = rowElement.querySelector('.cbe-addressTxReference').textContent;
                    const address = document.querySelector('.cbe-addressTitle').textContent;
                    const transaction = this.getTransactionFromMemoryOrSendRequest(txReference, address);
                    if (transaction === 'request sent') return;
        
                    const txDetails = this.#createTransactionDetailsElement(transaction);
                    rowElement.insertAdjacentElement('afterend', txDetails); // inject txDetails under row line
                } catch (error) {
                    console.error('cbe-addressTxRow event error:', error);
                }
            },
        }
        this.inputEventsListeners = {
            'cbe-searchInput': (event) => {
                const inputText = event.target.value.replace(/\s/g, '');

                if (event.key !== 'Enter') return;

                // find the search type (height: number, hash: 64chars, address: conformAddres, txReference, anchor...)

                const isNumber = !isNaN(inputText);
                const isHash = inputText.length === 64;
                const isAnchor = typeValidation.isConformAnchor(inputText);
                const isTxReference = typeValidation.isConformTxReference(inputText);

                if (isNumber) { this.navigationTarget.blockReference = Number(inputText); }
                if (isHash) { this.navigationTarget.blockReference = inputText; }
                if (isAnchor) { this.navigationTarget.outputIndex = Number(inputText.split(':')[2]); }
                if (isAnchor || isTxReference) {
                    this.navigationTarget.blockReference = Number(inputText.split(':')[0]);
                    this.navigationTarget.txId = inputText.split(':')[1];
                }

                if (isNumber || isHash || isAnchor || isTxReference) {
                    if (this.getBlockDataFromMemoryOrSendRequest(this.navigationTarget.blockReference) === 'request sent') { return; }

                    this.navigateUntilTarget(true);
                    return;
                }

                try {
                    addressUtils.conformityCheck(inputText); // throw error if not conform
                    console.log('address conform:', inputText);

                    this.navigationTarget.address = inputText;
                    sendWsWhenReady({ type: 'get_address_exhaustive_data', data: address });
                    //if (this.getAddressExhaustiveDataFromMemoryOrSendRequest(inputText) === 'request sent') 
                        //return;
    
                    // display address infos
                    //this.navigateUntilTarget(true);
                } catch (error) {
                    
                }
            },
        }
        this.hoverEventsListeners = {
            'cbe-addressTxRow': (event) => {
                /** @type {HTMLDivElement} */
                const rowElement = event.target.closest('.cbe-addressTxRow');
                const txAmountElement = rowElement.querySelector('.cbe-addressTxAmount');
                const txAmount = txAmountElement.textContent;
                if (txAmount !== '...') return; // already filled

                const address = document.querySelector('.cbe-addressTitle').textContent;
                const txReference = rowElement.querySelector('.cbe-addressTxReference').textContent;
                const transaction = this.getTransactionFromMemoryOrSendRequest(txReference, address);
                if (transaction === 'request sent') return;

                txAmountElement.textContent = convert.formatNumberAsCurrencyChange(transaction.balanceChange);
            }
        }
        this.initBlockExplorerContent();
        this.#updateBlockTimeLoop();
        this.#blockFillingLoop();
    }
    initBlockExplorerContent() {
        const containerDiv = this.cbeHTML.containerDiv;
        containerDiv.innerHTML = '';

        createHtmlElement('div', 'cbe-blockExplorerWrapUpperBackground', [], containerDiv);
        const relativeWrap = createHtmlElement('div', 'cbe-relativeWrap', [], containerDiv);
        const wrap = createHtmlElement('div', 'cbe-blockExplorerWrap', [], relativeWrap);

        this.#createSearchMenuBtn(wrap);

        const chainWrap = createHtmlElement('div', 'cbe-chainWrap', [], wrap);
        chainWrap.style = 'blur(0px)';

        // fill chainWrap with empty blocks
        this.bcElmtsManager.createChainOfEmptyBlocksUntilFillTheDiv(chainWrap);
    }
    // SETTERS -------------------------------------------------------------
    /** suppose the blockData is already in memory */
    async navigateUntilTarget() { //rebuildModal = true) {
        let modalContentCreated = false;
        const { blockReference, txId, outputIndex, address } = this.navigationTarget;
        this.navigationTarget = { blockReference: null, txId: null, outputIndex: null, address: null };
        
        if (!address && blockReference === null)
            { console.info('navigateUntilTarget => blockReference === null'); return }

        if (address) console.info('navigateUntilTarget =>', address);
        else console.info('navigateUntilTarget =>', isNaN(blockReference) ? blockReference : blockReference, txId, outputIndex);
        
        const rebuildModal = txId || outputIndex || address;
        if (rebuildModal && this.cbeHTML.modalContainer()) { //TODO: to test
            this.cbeHTML.modalContainer().click();
            await new Promise((resolve) => { setTimeout(() => { resolve(); }, this.animations.modalDuration); });
        }
        if (!this.cbeHTML.modalContent()) {
            this.#modalContainerFromSearchMenuBtn();
            modalContentCreated = true;
        }

        // if address is set, fill the modal content with address data
        if (address) { this.#fillModalContentWithAddressData(address); return; }
        
        // fill the modal content with the block data
        const blockData = isNaN(blockReference) ? this.blocksDataByHash[blockReference] : this.blocksDataByIndex[blockReference];
        if (!blockData) { console.info('navigateUntilTarget => error: blockData not found'); return; }
        this.#fillModalContentWithBlockData(blockData);
        if (!txId) return;

        await new Promise((resolve) => { setTimeout(() => { resolve(); }, modalContentCreated ? 1000 : 200); });

        // wait for txs table to be filled
        await new Promise((resolve) => { setTimeout(() => { resolve(); }, 800); });
        // scroll to the tx line
        const modalContentWrap = this.cbeHTML.modalContentWrap();
        const txRow = this.#getTxRowElement(txId, modalContentWrap);
        if (!txRow) { console.error('navigateUntilTarget => error: txRow not found'); return; }

        const scrollDuration = this.animations.modalDuration * 2;
        this.#scrollUntilVisible(txRow, modalContentWrap, scrollDuration);
        this.#blinkElementScaleY(txRow, 200, scrollDuration, () => { 
            txRow.click();
            if (outputIndex === null) return;

            const txDetails = this.cbeHTML.txDetails();
            if (!txDetails) { console.error('navigateUntilTarget => error: txDetails not found'); return; }
            const outputRow = txDetails.getElementsByClassName('cbe-TxOutput')[outputIndex];
            if (!outputRow) { console.error('navigateUntilTarget => error: outputRow not found'); return; }
            this.#scrollUntilVisible(outputRow, txDetails, scrollDuration);
            this.#blinkElementScaleY(outputRow, 200, scrollDuration, () => { outputRow.style.fontWeight = 'bold'; });
        });
    }
    #scrollUntilVisible(element, parentToScroll, duration = 200, callback = () => {}) {
        const elementRect = element.getBoundingClientRect();
        const parentRect = parentToScroll.getBoundingClientRect();
        
        if (elementRect.top >= parentRect.top && elementRect.bottom <= parentRect.bottom) { return; } // already visible

        let newScrollTop = parentToScroll.scrollTop;
        if (elementRect.top < parentRect.top) { newScrollTop -= parentRect.top - elementRect.top; }
        if (elementRect.bottom > parentRect.bottom) { newScrollTop += elementRect.bottom - parentRect.bottom; }

        this.animations.modalContentWrapScrollAnim = anime({
            targets: parentToScroll,
            scrollTop: newScrollTop,
            duration: duration,
            easing: 'easeInOutQuad',
            complete: callback
        });
    }
    #blinkElementScaleY(element, duration = 200, delay = 0, callback = () => {}) {
        setTimeout(() => {
            const initTransform = getComputedStyle(element).transform;
            const initFilter = getComputedStyle(element).filter;
            anime({
                targets: element,
                scaleY: 1.4,
                filter: 'brightness(1.5)',
                duration: duration,
                easing: 'easeInOutQuad',
                direction: 'alternate',
                loop: 4,
                complete: () => { 
                    element.style.transform = initTransform;
                    element.style.filter = initFilter;
                    callback();
                }
            });
        }, delay);
    }
    #updateBlockTimeLoop() {
        this.blocksTimeInterval = setInterval(() => {
            for (const blockInfo of this.blocksInfo) {
                const blockSquare = this.bcElmtsManager.getCorrespondingBlockElement(blockInfo.header.index);
                if (!blockSquare) continue;

                const timeAgo = blockSquare.querySelector('.cbe-timeAgo');
                timeAgo.textContent = getTimeSinceBlockConfirmedString(blockInfo.header.timestamp);
            }
        }, 1000);
    }
    /** @param {BlockData} blockData */
    saveBlockData(blockData) {
        if (!blockData || !blockData.hash || isNaN(blockData.index)) { 
            console.error('saveBlockData() error: blockData hash or index not found');
            console.info(blockData);
            return; 
        }
        this.blocksDataByHash[blockData.hash] = blockData;
        this.blocksDataByIndex[blockData.index] = blockData;
    }
    async #blockFillingLoop() {
        let canTryToModifyNbOfConfirmedBlocks = true;
        while (true) {
            let numberOfConfirmedBlocksShown = this.bcElmtsManager.getNumberOfConfirmedBlocksShown();
            let isFilled = numberOfConfirmedBlocksShown > this.nbOfConfirmedBlocks;
            await new Promise((resolve) => { setTimeout(() => { resolve(); }, isFilled ? 1000 : 100); });

            /** @type {HTMLDivElement} */
            const chainWrap = this.cbeHTML.chainWrap();
            if (!chainWrap) { console.error('fillBlockInfo() error: chainWrap not found'); continue; }

            if (this.incomingBlocksInfo.length === 0) continue;
            
            const blockInfo = this.incomingBlocksInfo.shift();
            for (let i = 0; i < this.blocksInfo; i++) { //TODO: find a better way to avoid empty blocks in the chain
                const blockInfo = this.blocksInfo[i];
                let blockElement = undefined;
                for (const block of chainWrap.children) {
                    if (block.querySelector('.cbe-blockIndex').textContent === `#${blockInfo.header.index}`) {
                        blockElement = block;
                        break;
                    }
                }
                if (blockElement) continue;
    
                console.info(`Missing block ${blockInfo.header.index}, trying to recover...`);
                this.bcElmtsManager.createChainOfEmptyBlocksUntilFillTheDiv(chainWrap);
                for (const blockInfo of this.blocksInfo) this.fillBlockInfo(blockInfo);
    
                console.info('recovered');
                break;
            }
    
            if (blockInfo.header.index <= this.lastBlockInfoIndex) { console.info(`already have block ${blockInfo.header.index}`); continue; }
            
            this.lastBlockInfoIndex = blockInfo.header.index;
            this.lastCirculatingSupply = blockInfo.header.supply + blockInfo.header.coinBase;
            this.blocksInfo.push(blockInfo);
            this.bcElmtsManager.fillFirstEmptyBlockElement(blockInfo);
            
            numberOfConfirmedBlocksShown = this.bcElmtsManager.getNumberOfConfirmedBlocksShown();
            isFilled = numberOfConfirmedBlocksShown > this.nbOfConfirmedBlocks;
            if (!isFilled) continue;
    
            this.blocksInfo.shift();
            const nbOfBlocksInQueue = this.incomingBlocksInfo.length;
            const suckDuration = Math.min(this.animations.newBlockDuration, Math.max(500, 1000 - (nbOfBlocksInQueue * 250)));
            this.bcElmtsManager.suckFirstBlockElement(this.cbeHTML.chainWrap(), suckDuration);
            await new Promise((resolve) => { setTimeout(() => { resolve(); }, suckDuration); });
            canTryToModifyNbOfConfirmedBlocks = true;
        }
    }
    /** @param {BlockInfo} blockInfo */
    fillBlockInfo(blockInfo) {
        this.incomingBlocksInfo.push(blockInfo); // add to the queue
    }
    /** @param {BlockData} blockData */
    #fillModalContentWithBlockData(blockData) {
        addressUtils.conformityCheck(blockData.minerAddress); // throw error if not conform
        addressUtils.conformityCheck(blockData.validatorAddress); // throw error if not conform
        console.log(blockData);
        
        const modalContent = this.cbeHTML.modalContent();
        if (!modalContent) { console.error('error: modalContent not found'); return; }
        modalContent.classList.add('cbe-blockDataContent');

        const contentWrap = this.cbeHTML.modalContentWrap();

        // A block is in the modal content ? We add a separator before injecting the new block
        if (this.cbeHTML.txsTable()) { createHtmlElement('div', undefined, ['cbe-modalContentSeparator'], contentWrap); }

        const fixedTopElement = createSpacedTextElement(blockData.hash, ['cbe-blockHash'], `#${blockData.index}`, ['cbe-blockIndex'], contentWrap);
        
        // spacing the contentWrap to avoid the fixedTopElement to hide the content
        contentWrap.style = 'margin-top: 56px; padding-top: 0; height: calc(100% - 76px);';
        fixedTopElement.classList.add('cbe-fixedTop');
        
        const twoContainerWrap = createHtmlElement('div', undefined, ['cbe-twoContainerWrap'], contentWrap);

        const leftContainer = createHtmlElement('div', undefined, ['cbe-leftContainer'], twoContainerWrap);
        //createSpacedTextElement('Supply', [], `${convert.formatNumberAsCurrency(blockData.supply)}`, [], leftContainer);
        
        const readableLocalDate = new Date(blockData.timestamp).toLocaleString();
        createSpacedTextElement('Date', [], readableLocalDate, [], leftContainer);
        createSpacedTextElement('Size', [], `${(blockData.blockBytes / 1024).toFixed(2)} KB`, [], leftContainer);
        createSpacedTextElement('Transactions', [], `${blockData.nbOfTxs}`, [], leftContainer);
        createSpacedTextElement('Total fees', [], `${convert.formatNumberAsCurrency(blockData.totalFees)}`, [], leftContainer);
        
        const minerAddressElmnt = createSpacedTextElement('Miner', [], '', [], leftContainer);
        const minerAddressDiv = minerAddressElmnt.children[1];
        const minerAddressSpanElmnt = createHtmlElement('span', undefined, ['cbe-addressSpan'], minerAddressDiv);
        minerAddressSpanElmnt.textContent = blockData.minerAddress;

        const validatorAddressElmnt = createSpacedTextElement('Validator', [], '', [], leftContainer);
        const validatorAddressDiv = validatorAddressElmnt.children[1];
        const validatorAddressSpanElmnt = createHtmlElement('span', undefined, ['cbe-addressSpan'], validatorAddressDiv);
        validatorAddressSpanElmnt.textContent = blockData.validatorAddress;
        
        const rightContainer = createHtmlElement('div', undefined, ['cbe-rightContainer'], twoContainerWrap);
        createSpacedTextElement('Legitimacy', [], blockData.legitimacy, [], rightContainer);
        createSpacedTextElement('CoinBase', [], `${convert.formatNumberAsCurrency(blockData.coinBase)}`, [], rightContainer);
        createSpacedTextElement('Lower fee', [], `${convert.formatNumberAsCurrency(blockData.lowerFeePerByte)}c/byte`, [], rightContainer);
        createSpacedTextElement('Higher fee', [], `${convert.formatNumberAsCurrency(blockData.higherFeePerByte)}c/byte`, [], rightContainer);
        createSpacedTextElement('Miner reward', [], `${convert.formatNumberAsCurrency(blockData.powReward)}`, [], rightContainer);
        createSpacedTextElement('Validator reward', [], `${convert.formatNumberAsCurrency(blockData.posReward)}`, [], rightContainer);
        
        this.#createTransactionsTableElement(blockData, ['cbe-TxsTable', 'cbe-Table'], contentWrap);
    }
    #fillModalContentWithAddressData(address) {
        const addressExhaustiveData = this.addressesExhaustiveData[address];
        if (!addressExhaustiveData) { console.error('error: addressExhaustiveData not found'); return; }

        const modalContent = this.cbeHTML.modalContent();
        if (!modalContent) { console.error('error: modalContent not found'); return; }

        const contentWrap = this.cbeHTML.modalContentWrap();
        const addressTitle = createHtmlElement('div', undefined, ['cbe-addressTitle', 'cbe-fixedTop'], contentWrap);
        addressTitle.textContent = address;

        contentWrap.style = 'margin-top: 56px; padding-top: 0; height: calc(100% - 76px);';
        this.#createAddressInfoElement(addressExhaustiveData, 'cbe-addressExhaustiveData', contentWrap);
    }
    fillAddressTxRow(txReference, balanceChange, fee, timestamp) {
        const addressTxRows = document.querySelectorAll(`.cbe-addressTxRow`);
        for (const addressTxRow of addressTxRows) {
            if (addressTxRow.querySelector('.cbe-addressTxReference').textContent !== txReference) continue;
            addressTxRow.querySelector('.cbe-addressTxAmount').textContent = convert.formatNumberAsCurrencyChange(balanceChange);
            addressTxRow.querySelector('.cbe-addressTxFee').textContent = convert.formatNumberAsCurrency(fee);
            addressTxRow.querySelector('.cbe-addressTxDate').textContent = new Date(timestamp).toLocaleString();
            return;
        }

        console.error('fillAddressTxRow => error: txReference not found');
    }
    // MODAL CONTENT CREATION ----------------------------------------------
    #createSearchMenuBtn(divToInject) {
        const searchMenuBtn = createHtmlElement('div', 'cbe-searchMenuBtn', [], divToInject);
        const img = createHtmlElement('img', 'cbe-C-magnet-img', [], searchMenuBtn);
        img.src = window.explorerMagnetImgPath || 'front/img/C_magnet.png';
        img.alt = 'C magnet';

        const searchMenu = createHtmlElement('div', 'cbe-searchMenu', [], searchMenuBtn);
        const searchTarget = createHtmlElement('div', 'cbe-searchTarget', [], searchMenu);
        const searchMenuWrap = createHtmlElement('div', 'cbe-searchMenuWrap', [], searchMenu);
        const searchBox = createHtmlElement('div', 'cbe-searchBox', [], searchMenuWrap);
        const searchInput = createHtmlElement('input', 'cbe-searchInput', [], searchBox);
        searchInput.placeholder = 'height, hash, address, txReference, anchor...';
    }
    #modalContainerFromSearchMenuBtn() {
        const searchMenuBtn = this.cbeHTML.searchMenuBtn();
        const searchMenuBtnRect = searchMenuBtn.getBoundingClientRect();
        const searchMenuBtnCenter = { x: searchMenuBtnRect.left + searchMenuBtnRect.width / 2, y: searchMenuBtnRect.top + searchMenuBtnRect.height / 2 };
        
        this.newModalContainer();
        this.newModalContent(searchMenuBtnRect.width, searchMenuBtnRect.height, searchMenuBtnCenter);
    }
    newModalContainer() {
        const modalContainer = createHtmlElement('div', 'cbe-modalContainer', [], this.cbeHTML.containerDiv);
        modalContainer.style.backdropFilter = 'blur(0px)';
        modalContainer.style.opacity = 1;
        
        this.animations.modalContainerAnim = anime({
            targets: modalContainer,
            backdropFilter: 'blur(2px)',
            duration: this.animations.modalDuration * .4,
            delay: this.animations.modalDuration,
            easing: 'easeInOutQuad',
        });
    }
    /** @param {number} fromWidth @param {number} fromHeight @param {{ x: number, y: number }} fromPosition */
    newModalContent(fromWidth, fromHeight, fromPosition) {
        const modalContainer = this.cbeHTML.modalContainer();
        if (!modalContainer) { console.error('newModalContent() error: modalContainer not found'); return; }

        const modalContent = createHtmlElement('div', 'cbe-modalContent', [], modalContainer);
        createHtmlElement('div', 'cbe-modalContentWrap', [], modalContent);

        const modalContentPadding = Number(getComputedStyle(modalContent).padding.replace('px', ''));
        const startWidth = `${fromWidth - (modalContentPadding * 2)}px`;
        const startHeight = `${fromHeight - (modalContentPadding * 2)}px`;
        modalContent.style.width = startWidth;
        modalContent.style.height = startHeight;
        modalContent.style.left = `${fromPosition.x}px`;
        modalContent.style.top = `${fromPosition.y}px`;

        const modalContainerRect = modalContainer.getBoundingClientRect();
        const finalWidth = `${HTML_ELEMENTS_ATTRIBUTES.modalContent.widthPerc * modalContainerRect.width}px`;
        const finalHeight = `${HTML_ELEMENTS_ATTRIBUTES.modalContent.heightPerc * modalContainerRect.height}px`;

        modalContent.style.opacity = 1;
        this.animations.modalContentPositionAnim = anime({
            targets: modalContent,
            left: `${modalContainerRect.width / 2}px`,
            top: `${modalContainerRect.height / 2}px`,
            duration: this.animations.modalDuration,
            delay: this.animations.modalDuration,
            easing: 'easeInOutQuad',
        });
        this.animations.modalContentSizeAnim = anime({
            targets: modalContent,
            width: finalWidth,
            height: finalHeight,
            duration: this.animations.modalDuration,
            delay: this.animations.modalDuration * 1.6,
            easing: 'spring(.8, 80, 20, -100)',
        });
    }
    /** @param {BlockData} blockData @param {HTMLElement} divToInject */
    #createTransactionsTableElement(blockData, tableClasses = ['cbe-TxsTable', 'cbe-Table'], divToInject) {
        const table = createHtmlElement('table', undefined, tableClasses, divToInject);
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const headers = ['Index', 'Transaction id', 'Total amount spent', '(bytes) Weight'];
        for (const headerText of headers) 
            createHtmlElement('th', undefined, [], headerRow).textContent = headerText;

        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const Txs = blockData.Txs;
        setTimeout(() => { 
            for (let i = 0; i < Txs.length; i++) {
                const tx = Txs[i];
                const delay = Math.min(i * 10, 600);
                setTimeout(() => { this.#createTransactionOfTableElement(i, tx, tbody); }, delay);
            }
        }, 600);

        table.appendChild(tbody);
        divToInject.appendChild(table);
        return table;
    }
    /** @param {number} txIndex @param {Transaction} tx @param {HTMLElement} tbodyDiv */
    #createTransactionOfTableElement(txIndex, tx, tbodyDiv) {
        const outputsAmount = tx.outputs.reduce((a, b) => a + b.amount, 0);
        const specialTx = txIndex < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false;
        const weight = Transaction_Builder.getTxWeight(tx, specialTx);

        const row = document.createElement('tr');
        row.classList.add('cbe-TxRow');

        const indexElmnt = createHtmlElement('td', undefined, [], row)
        indexElmnt.textContent = txIndex;
        if (txIndex === 0) indexElmnt.textContent = indexElmnt.textContent + ' (CoinBase)';
        if (txIndex === 1) indexElmnt.textContent = indexElmnt.textContent + ' (Validator)';

        createHtmlElement('td', undefined, [], row).textContent = tx.id;
        createHtmlElement('td', undefined, [], row).textContent = `${convert.formatNumberAsCurrency(outputsAmount)} c`;
        createHtmlElement('td', undefined, [], row).textContent = `${weight} B`;

        tbodyDiv.appendChild(row);
        return row;
    }
    /** @param {Transaction} tx @param {string} id */
    #createTransactionDetailsElement(tx, id = 'cbe-TxDetails', killExisting = true) {
        const cbeTxDetailsElement = this.cbeHTML.txDetails();
        if (killExisting && cbeTxDetailsElement) cbeTxDetailsElement.remove();

        const txDetails = createHtmlElement('div', id);
        
        const isMinerTx = tx.inputs.length === 1 && tx.inputs[0].split(':').length === 1;
        if (!isMinerTx) {
            const witnessesWrap = createHtmlElement('div', undefined, ['cbe-TxWitnessesWrap'], txDetails);
            createHtmlElement('h3', undefined, [], witnessesWrap).textContent = tx.witnesses.length > 1 ? `Witnesses (${tx.witnesses.length})` : 'Witness';
            for (const witness of tx.witnesses) {
                const sigText = `Sig: ${witness.split(':')[0]}`;
                const pubKeyText = `PubKey: ${witness.split(':')[1]}`;
                const witnessDiv = createHtmlElement('div', undefined, ['cbe-TxWitness'], witnessesWrap);
                createHtmlElement('div', undefined, [], witnessDiv).textContent = sigText;
                createHtmlElement('div', undefined, [], witnessDiv).textContent = pubKeyText;
            }
        }

        const threeContainerWrap = createHtmlElement('div', undefined, ['cbe-threeContainerWrap'], txDetails);
        const TxInfoWrap = createHtmlElement('div', undefined, ['cbe-TxInfoWrap'], threeContainerWrap);
        createHtmlElement('h3', undefined, [], TxInfoWrap).textContent = `Info`;
        createSpacedTextElement('Id:', [], tx.id, [], TxInfoWrap);
        createSpacedTextElement('Version:', [], tx.version, [], TxInfoWrap);
        //createHtmlElement('div', undefined, [], TxInfoWrap).textContent = `Tx: ${tx.id}`;
        //createHtmlElement('div', undefined, [], TxInfoWrap).textContent = `Version: ${tx.version}`;
        
        const inputsWrap = createHtmlElement('div', undefined, ['cbe-TxInputsWrap'], threeContainerWrap);
        const isValidatorTx = tx.inputs[0].split(':').length === 2;
        const titleText = isMinerTx ? 'Miner nonce' : isValidatorTx ? 'Validator Tx (no input)' : `Inputs (${tx.inputs.length})`;
        createHtmlElement('h3', undefined, [], inputsWrap).textContent = titleText;
        for (const anchor of tx.inputs) {
            if (isValidatorTx) continue;
            const inputDiv = createHtmlElement('div', `cbe-TxInput-${anchor}`, ['cbe-TxInput'], inputsWrap);
            if (isMinerTx) { inputDiv.textContent = anchor; continue; }
            // check conformity of anchor to avoid code injection
            if (!typeValidation.isConformAnchor(anchor)) { console.error(`Invalid anchor: ${anchor}`); return; }
            const anchorSpan = createHtmlElement('span', undefined, ['cbe-anchorSpan'], inputDiv);
            anchorSpan.textContent = anchor;
        }

        const outputsWrap = createHtmlElement('div', undefined, ['cbe-TxOutputsWrap'], threeContainerWrap);
        createHtmlElement('h3', undefined, [], outputsWrap).textContent = `(${tx.outputs.length}) Outputs`;
        for (const output of tx.outputs) {
            const { address, amount, rule } = output;
            if (typeof amount !== 'number') { console.error(`Invalid amount: ${amount}`); return; }
            if (typeof rule !== 'string') { console.error(`Invalid rule: ${rule}`); return; }
            if (!addressUtils.conformityCheck(address)) { console.error(`Invalid address: ${address}`); return; }
            const outputDiv = createHtmlElement('div', undefined, ['cbe-TxOutput'], outputsWrap);
            const addressSpanAsText = `<span class="cbe-addressSpan">${address}</span>`;
            outputDiv.innerHTML = `${convert.formatNumberAsCurrency(amount)} >>> ${addressSpanAsText} (${rule})`;
        }
        if (tx.fee) {
            const feeDiv = createHtmlElement('div', undefined, ['cbe-TxFee'], outputsWrap);
            feeDiv.textContent = `Fee: ${convert.formatNumberAsCurrency(tx.fee)}`;
        } else { console.info('tx fee not found'); }

        return txDetails;
    }
    /** @param {AddressExhaustiveData} addressExhaustiveData @param {string} id @param {HTMLElement} divToInject */
    async #createAddressInfoElement(addressExhaustiveData, id = 'cbe-addressExhaustiveData', divToInject = undefined) {
        console.log('addressInfo', addressExhaustiveData);

        const addressInfoElement = createHtmlElement('div', id);
        const balancesWrap = createHtmlElement('div', 'cbe-balancesWrap', [], addressInfoElement);
        createHtmlElement('h3', undefined, [], balancesWrap).textContent = 'Balances';
        //for (const { key, value } of addressInfo.balances) { // misstake, we need to iterate over the object
        for (const key in addressExhaustiveData.balances) {
            const value = addressExhaustiveData.balances[key];
            createSpacedTextElement(key, [], `${convert.formatNumberAsCurrency(value)}`, [], balancesWrap);
        }

        //createHtmlElement('div', undefined, ['cbe-modalContentSeparator'], addressInfoElement);

        // create transaction history folded element
        const wrap1 = createHtmlElement('div', undefined, ['cbe-folderWrap'], addressInfoElement);
        createSpacedTextElement('History', [], '▼', ['.cbe-arrowBtn'], wrap1);

        const txHistoryWrap = createHtmlElement('div', undefined, ['cbe-TxHistoryWrap', 'cbe-folded'], wrap1);
        setTimeout(() => this.#createTxHistoryFilledWithTxsReferencesElement(addressExhaustiveData, txHistoryWrap), 1000);

        // create UTXOs folded element
        const wrap2 = createHtmlElement('div', undefined, ['cbe-folderWrap'], addressInfoElement);
        createSpacedTextElement('UTXOs', [], '▼', ['.cbe-arrowBtn'], wrap2);

        const utxosWrap = createHtmlElement('div', undefined, ['cbe-utxosWrap', 'cbe-folded'], wrap2);
        for (const rule in addressExhaustiveData.UTXOsByRules) {
            /** @type {UTXO[]} */
            const UTXOsByRule = addressExhaustiveData.UTXOsByRules[rule];
            const ruleWrap = createHtmlElement('div', `cbe-utxosRuleWrap-${rule}`, ['cbe-utxosRuleWrap'], utxosWrap);
            createHtmlElement('h4', undefined, ['cbe-utxosRuleTitle'], ruleWrap).textContent = rule;
            setTimeout(() => { this.#createAndFillUtxosTableElement(UTXOsByRule, ruleWrap) }, 1000);
        }
        
        if (divToInject) { divToInject.appendChild(addressInfoElement); }
        return addressInfoElement;
    }
    /** @param {AddressExhaustiveData} addressExhaustiveData @param {HTMLElement} divToInject */
    #createTxHistoryFilledWithTxsReferencesElement(addressExhaustiveData, divToInject) {
        // FILLING THE ADDRESS TXS HISTORY
        const table = createHtmlElement('table', undefined, ['cbe-TxHistoryTable', 'cbe-Table'], divToInject);
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        createHtmlElement('th', undefined, [], headerRow).textContent = 'Amount';
        createHtmlElement('th', undefined, [], headerRow).textContent = 'Fee';
        createHtmlElement('th', undefined, [], headerRow).textContent = 'Anchor';
        createHtmlElement('th', undefined, [], headerRow).textContent = 'Date';
        
        thead.appendChild(headerRow);
        table.appendChild(thead);
        
        const tbody = document.createElement('tbody');
        const txsReferences = addressExhaustiveData.addressTxsReferences;
        for (const txReference of txsReferences) {
            const transaction = this.transactionsByReference[txReference];
            const row = createHtmlElement('tr', undefined, ['cbe-addressTxRow'], tbody);
            const amountText = createHtmlElement('td', undefined, ['cbe-addressTxAmount'], row);
            amountText.textContent = transaction ? convert.formatNumberAsCurrencyChange(transaction.balanceChange) : '...';
            const feeText = createHtmlElement('td', undefined, ['cbe-addressTxFee'], row);
            feeText.textContent = transaction ? convert.formatNumberAsCurrency(transaction.fee) : '...';
            createHtmlElement('td', undefined, ['cbe-addressTxReference'], row).textContent = txReference;
            const dateText = createHtmlElement('td', undefined, ['cbe-addressTxDate'], row);
            dateText.textContent = transaction ? new Date(transaction.timestamp).toLocaleString() : '...';
        }
        
        table.appendChild(tbody);
        divToInject.appendChild(table);
        return table;
    }
    /** @param {UTXO[]} UTXOs @param {HTMLElement} divToInject */
    #createAndFillUtxosTableElement(UTXOs, divToInject) {
        const table = createHtmlElement('table', undefined, ['cbe-utxosTable', 'cbe-Table'], divToInject);
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        createHtmlElement('th', undefined, [], headerRow).textContent = 'Anchor';
        createHtmlElement('th', undefined, [], headerRow).textContent = 'Amount';
        
        thead.appendChild(headerRow);
        table.appendChild(thead);
        
        const tbody = document.createElement('tbody');
        for (const UTXO of UTXOs) {
            if (typeof UTXO.amount !== 'number') { console.error(`Invalid amount: ${UTXO.amount}`); return; }
            if (!typeValidation.isConformAnchor(UTXO.anchor)) { console.error(`Invalid anchor: ${UTXO.anchor}`); return; }
            const row = document.createElement('tr');
            createHtmlElement('td', undefined, ['cbe-anchorSpan'], row).textContent = UTXO.anchor;
            createHtmlElement('td', undefined, [], row).innerHTML = `${convert.formatNumberAsCurrency(UTXO.amount)} c`;
            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        divToInject.appendChild(table);
        return table;
    }
    // GETTERS -------------------------------------------------------------
    #getTxRowElement(txId, parentElement) {
        const txRows = parentElement.getElementsByClassName('cbe-TxRow');
        for (const row of txRows)
            for (const td of row.children)
                if (td.textContent === txId) return row;
            
        return null;
    }
    /** @param {string | number} blockReference block hash or block index */
    getBlockDataFromMemoryOrSendRequest(blockReference = 0) {
        const referenceIsHash = typeof blockReference === 'string';

        const fromMemory = referenceIsHash ? this.blocksDataByHash[blockReference] : this.blocksDataByIndex[blockReference];
        if (fromMemory) return fromMemory;

        // get the block data from the server
        const requestType = referenceIsHash ? 'get_blocks_data_by_hash' : 'get_blocks_data_by_height';
        console.log(`requesting block data by ${requestType}: ${blockReference}`);
        ws.send(JSON.stringify({ type: requestType, data: blockReference }));
        return 'request sent';
    }
    /** @param {string} txReference @param {string} address - optional */
    getTransactionFromMemoryOrSendRequest(txReference, address = undefined) {
        let comply = true;
        const fromMemory = this.transactionsByReference[txReference];
        if (fromMemory && address) comply = fromMemory.balanceChange !== undefined;
        if (fromMemory && comply) return fromMemory;

        console.log(`requesting tx data: ${txReference}`);
        if (address)
            ws.send(JSON.stringify({ type: 'get_transaction_with_balanceChange_by_reference', data: { txReference, address } }));
        else
            ws.send(JSON.stringify({ type: 'get_transaction_by_reference', data: txReference }));
        
        return 'request sent';
    }
    /** @param {string} address */
    getAddressExhaustiveDataFromMemoryOrSendRequest(address) {
        const fromMemory = this.addressesExhaustiveData[address];
        if (fromMemory) return fromMemory;

        console.log(`requesting address exhaustive data: address: ${address}`);
        sendWsWhenReady({ type: 'get_address_exhaustive_data', data: address });
        return 'request sent';
    }
    getCloneBeforeReset() {
        const cloned = {
            /** @type {HTMLDivElement} */
            modalContainer: this.cbeHTML.modalContainer() ? this.cbeHTML.modalContainer().cloneNode(true) : null,
            /** @type {Object<string, BlockData>} */
            blocksDataByHash: JSON.parse(JSON.stringify(this.blocksDataByHash)),
            /** @type {Object<number, BlockData>} */
            blocksDataByIndex: JSON.parse(JSON.stringify(this.blocksDataByIndex)),
            /** @type {BlockInfo[]} */
            blocksInfo: JSON.parse(JSON.stringify(this.blocksInfo)),
        }

        return cloned;
    }
}
class AddressInfo {
    /** @param {UTXO[]} UTXOs */
    constructor(UTXOs) {
        this.UTXOs = utxoExtraction.balances(UTXOs);
        this.UTXOsByRules = utxoExtraction.byRules(UTXOs);
    }
}
export class AddressExhaustiveData {
    /** @param {UTXO[]} UTXOs @param {string[]} addressTxsReferences */
    constructor(UTXOs, addressTxsReferences) {
        this.balances = utxoExtraction.balances(UTXOs);
        this.UTXOsByRules = utxoExtraction.byRules(UTXOs);
        /** @type {Object<string, string[]>} */
        this.addressTxsReferences = addressTxsReferences;
    }
    /** @param {UTXO[]} UTXOs */
    mergeNewUTXOs(UTXOs) {
        const newBalances = utxoExtraction.balances(UTXOs);
        for (const key in newBalances) {
            if (this.balances[key]) this.balances[key] += newBalances[key];
            else this.balances[key] = newBalances[key];
        }
       
        const newUTXOsByRules = utxoExtraction.byRules(UTXOs);
        for (const rule in newUTXOsByRules) {
            if (this.UTXOsByRules[rule]) this.UTXOsByRules[rule].push(...newUTXOsByRules[rule]);
            else this.UTXOsByRules[rule] = newUTXOsByRules[rule];
        }
    }
    /** @param {string[]} txsReferences */
    mergeNewTxsReferences(newTxsReferences) {
        for (const txReference of newTxsReferences) {
            if (this.addressTxsReferences.includes(txReference)) continue;
            this.addressTxsReferences.push(txReference);
        }
    }
    /** @param {AddressExhaustiveData} newData @param {boolean} replaceBalances */
    mergeAddressExhaustiveData(newData, replaceBalances = true) {
        for (const key in newData.balances) {
            if (!replaceBalances) continue;
            this.balances[key] = newData.balances[key];
        }

        for (const rule in newData.UTXOsByRules) {
            if (this.UTXOsByRules[rule]) this.UTXOsByRules[rule].push(...newData.UTXOsByRules[rule]);
            else this.UTXOsByRules[rule] = newData.UTXOsByRules[rule];
        }

        this.mergeNewTxsReferences(newData.addressTxsReferences);
    }

    highestKnownUTXOsHeight() {
        let highestHeight = 0;
        for (const rule in this.UTXOsByRules) {
            for (const UTXO of this.UTXOsByRules[rule]) {
                const height = UTXO.anchor.split(':')[0];
                if (height > highestHeight) highestHeight = UTXO.height;
            }
        }
        return highestHeight;
    }
    highestKnownTxsHeight() {
        return this.addressTxsReferences.length === 0 ? 0 : this.addressTxsReferences[this.addressTxsReferences.length - 1];
    }
}
class BlockChainElementsManager {
    constructor() {
        /** @type {HTMLDivElement[]} */
        this.blocksElements = [];
        this.firstBlockAnimation = null;
        this.chainWrapAnimation = null;
        this.isSucking = false;
    }
    /** @param {HTMLElement} chainWrap @param {number} nbBlocks */
    createChainOfEmptyBlocksUntilFillTheDiv(chainWrap, nbBlocks = SETTINGS.NB_OF_CONFIRMED_BLOCKS + SETTINGS.NB_OF_UNCONFIRMED_BLOCKS) {
        const parentRect = chainWrap.parentElement.parentElement.getBoundingClientRect();
        for (let i = 0; i < nbBlocks; i++) {
            const block = this.createEmptyBlockElement();
            chainWrap.appendChild(block);

            const blockRect = block.getBoundingClientRect();
            if (blockRect.left > parentRect.right) break;
        }
    }
    createEmptyBlockElement() {
        /** @type {HTMLDivElement} */
        const wrap = createHtmlElement('div', undefined, ['cbe-blockWrap']);
        const blockSquare = createHtmlElement('div', undefined, ['cbe-blockSquare'], wrap);

        const blockMiniHash = createHtmlElement('div', undefined, ['cbe-blockMiniHash'], blockSquare);
        blockMiniHash.textContent = this.#splitHash('................................................................', 16).join(' ');
        
        const blockIndex = createHtmlElement('div', undefined, ['cbe-blockIndex'], blockSquare);
        blockIndex.textContent = '#...';

        const weight = createHtmlElement('div', undefined, ['cbe-weight'], blockSquare);
        weight.textContent = '... KB';

        const timeAgo = createHtmlElement('div', undefined, ['cbe-timeAgo'], blockSquare);
        timeAgo.textContent = `...`;

        const nbTx = createHtmlElement('div', undefined, ['cbe-nbTx'], blockSquare);
        nbTx.textContent = '... transactions';

        //wrap.appendChild(blockSquare);

        this.blocksElements.push(wrap);
        return wrap;
    }
    /** @param {BlockInfo} blockInfo */
    fillFirstEmptyBlockElement(blockInfo) {
        const blockElement = this.#getFirstEmptyBlockElement();
        if (!blockElement) return;

        const blockSquare = blockElement.querySelector('.cbe-blockSquare');

        const blockMiniHash = blockSquare.querySelector('.cbe-blockMiniHash');
        blockMiniHash.textContent = this.#splitHash(blockInfo.header.hash, 16).join(' ');

        const blockIndex = blockSquare.querySelector('.cbe-blockIndex');
        blockIndex.textContent = `#${blockInfo.header.index}`;

        const weight = blockSquare.querySelector('.cbe-weight');
        weight.textContent = `${(blockInfo.blockBytes / 1024).toFixed(2)} KB`;

        const timeAgo = blockSquare.querySelector('.cbe-timeAgo');
        timeAgo.textContent = getTimeSinceBlockConfirmedString(blockInfo.header.timestamp);

        const nbTx = blockSquare.querySelector('.cbe-nbTx');
        nbTx.textContent = `${blockInfo.nbOfTxs} transactions`;

        blockSquare.classList.add('filled');
    }
    #splitHash(hash, nbOfCharsPerLine = 16) {
        const hashSplitted = [];
        for (let i = 0; i < hash.length; i += nbOfCharsPerLine)
            hashSplitted.push(hash.slice(i, i + nbOfCharsPerLine));

        return hashSplitted;
    }
    #getFirstEmptyBlockElement() {
        return this.blocksElements.find(block => block.querySelector('.cbe-blockIndex').textContent === '#...');
    }
    getCorrespondingBlockElement(blockHeight) {
        return this.blocksElements.find(block => block.querySelector('.cbe-blockIndex').textContent === `#${blockHeight}`);
    }
    getNumberOfConfirmedBlocksShown() {
        return this.blocksElements.filter(block => block.querySelector('.cbe-blockIndex').textContent !== '#...').length;
    }
    /** @param {HTMLElement} chainWrap @param {number} duration */
    suckFirstBlockElement(chainWrap, duration = 1000) {
        this.isSucking = true;

        
        // suck the first block
        this.firstBlockAnimation = anime({
            targets: this.blocksElements[0],
            translateX: '-100%',
            filter: 'blur(6px)',
            width: 0,
            scale: 0.5,
            opacity: 0,
            duration,
            easing: 'easeInOutQuad',
            begin: () => {
                chainWrap.style.width = `${chainWrap.getBoundingClientRect().width}px`; // lock the width of the wrap
            },
            complete: () => {
                this.removeFirstBlockElement();
                chainWrap.appendChild(this.createEmptyBlockElement());
                chainWrap.style.width = 'auto'; // unlock the width of the wrap
                this.isSucking = false;
            }
        });
        
        // blur the wrap
        this.chainWrapAnimation = anime({
            targets: chainWrap,
            filter: ['blur(.6px)', 'blur(.5px)', 'blur(.6px)'],
            duration: duration - 200,
            complete: () => { 
                anime({
                    targets: chainWrap,
                    filter: 'blur(0px)',
                    duration: 400,
                    easing: 'easeInOutQuad',
                });
            }
        });
    }
    removeFirstBlockElement() {
        this.blocksElements[0].remove();
        this.blocksElements.shift();
    }
}

window.blockExplorerWidget = new BlockExplorerWidget('cbe-contrastBlocksWidget');

//#region FUNCTIONS -------------------------------------------------------
function getTimeSinceBlockConfirmedString(timestamp) {
    const minuteSince = Math.floor((Date.now() - timestamp) / 60000);
    if (minuteSince >= 1) return `~${minuteSince} min ago`;

    const secondsSince = Math.floor((Date.now() - timestamp) / 1000);
    return `~${secondsSince} s ago`;
}
/** @param {BlockData} blockHeader */
function displayLastConfirmedBlock(blockHeader) {
    // 1. contrastChainExplorer
    if (SETTINGS.ROLES.includes('chainExplorer')) {
        eHTML.chainHeight.textContent = blockHeader.index;
        eHTML.circulatingSupply.textContent = convert.formatNumberAsCurrency(blockHeader.supply + blockHeader.coinBase);
        const percent = ((blockHeader.supply + blockHeader.coinBase) / BLOCKCHAIN_SETTINGS.maxSupply * 100).toFixed(2);
        eHTML.circulatingSupplyPercent.textContent = `~${percent}`;

        const readableLocalDate = new Date(blockHeader.timestamp).toLocaleString();
        const agoText = `${((blockHeader.timestamp - blockHeader.posTimestamp) / 1000).toFixed(2)}s`;
        eHTML.lastBlocktime.textContent = `${readableLocalDate} (${agoText})`;
    }

    // 2. contrastBlocksWidget
    if (SETTINGS.ROLES.includes('blockExplorer')) {
        
        
    }
}
function createHtmlElement(tag, id, classes = [], divToInject = undefined) {
    /** @type {HTMLElement} */
    const element = document.createElement(tag);
    if (id) element.id = id;

    for (const cl of classes) element.classList.add(cl);

    if (divToInject) divToInject.appendChild(element);
    return element;
}
function createSpacedTextElement(title = '1e2...', titleClasses = ['cbe-blockHash'], value = '#123', valueClasses = ['cbe-blockIndex'], divToInject = undefined) {
    const spacedTextDiv = createHtmlElement('div', undefined, ['cbe-spacedText']);

    const titleDiv = createHtmlElement('div', undefined, titleClasses, spacedTextDiv);
    titleDiv.textContent = title;
    const valueDiv = createHtmlElement('div', undefined, valueClasses, spacedTextDiv);
    valueDiv.textContent = value;

    if (divToInject) divToInject.appendChild(spacedTextDiv);
    return spacedTextDiv;
}
/** @param {Object<number, number>} */
async function displayBlocksTimestampsChart(blocksTimestamps = {}, dtick = 60) {
    const chart = eHTML.cacheBlocksTimesChart;
    if (!chart) return;
    
    //console.log('blocksTimestamps', blocksTimestamps);

    // TEST WITH BITCOIN BLOCKS
    /*const timestamps = [1745469466, 1745469278, 1745468167, 1745467923, 1745467220, 1745467052, 1745466670, 1745465703, 1745465663, 1745465211, 1745465164, 1745464731, 1745464034, 1745463799, 1745463577, 1745463098, 1745461405, 1745460032, 1745459096, 1745458838, 1745458789, 1745458327, 1745457777, 1745457142, 1745456297, 1745455739, 1745455097, 1745455074, 1745455059, 1745454872, 1745453257, 1745453199, 1745452935, 1745451271, 1745449675, 1745448888, 1745447951, 1745447788, 1745446962, 1745445807, 1745445526, 1745444934, 1745443425, 1745441844, 1745441598, 1745441322, 1745441131, 1745440590, 1745440077, 1745440024, 1745439344, 1745437974, 1745436834, 1745435873, 1745433504, 1745432362, 1745431813, 1745431605, 1745430922, 1745430509, 1745430036, 1745429214, 1745428164, 1745427719, 1745427168, 1745426853, 1745426438, 1745425085, 1745424888, 1745423583, 1745422741, 1745422472, 1745421288, 1745421123, 1745420647, 1745420027, 1745419375, 1745418200, 1745416889, 1745416282, 1745416193, 1745416137, 1745416004, 1745415843, 1745414936, 1745413226, 1745413126, 1745411323, 1745410884, 1745409928, 1745409370, 1745408794, 1745406396, 1745406249, 1745406001, 1745405707, 1745404715, 1745403930, 1745403604, 1745402626];
    const x = timestamps.map((_, i) => i);
    const y = timestamps.map((_, i) => i === 0 ? 0 : (Math.abs(timestamps[i] - timestamps[i - 1])));*/

    // use plotly to create the chart
    // x axis: block height, y axis: time between blocks
    const x = Object.keys(blocksTimestamps).map((key) => parseInt(key));
    const timestamps = Object.values(blocksTimestamps);
    const y = timestamps.map((_, i) => i === 0 ? 0 : (timestamps[i] - timestamps[i - 1]) / 1000); // convert to seconds
    x.shift();
    y.shift();
    //console.log('timestamps', timestamps, 'x', x, 'y', y);

    const averageGap = y.reduce((a, b) => a + b, 0) / y.length;
    eHTML.averageBlocksTimeGap.textContent = ` | average: ${averageGap.toFixed(2)}s`;

    // line black at 120s, grey at 0s, grey at 240s
    const colors = y.map((value, index) => {
        const a = Math.abs(value - 120);
        if (a < 0 || a > 120 ) return 'rgb(0, 0, 0)';

        const grey = Math.floor(200 - (a / 120) * 200);
        return `rgb(${grey}, ${grey}, ${grey})`;
    });

    const scatterData = {
        x,
        y,
        type: 'scatter',
        mode: 'markers',
        marker: { color: colors, size: 7 },
        hovertemplate: x.map((value, index) => ` #${value} | ${y[index].toFixed(2)}s <extra></extra>`),
        hoverlabel: { bgcolor: 'rgb(0, 0, 0)', font: { color: '#ffffff', size: 10, family: '"IBM Plex Mono", monospace' } },
    };
    const averageLine = {
        x: [Math.min(...x), Math.max(...x)],
        y: [averageGap, averageGap],
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgb(227, 227, 227)', width: 2, dash: 'dot' },
        hoverinfo: 'skip',
    };
    const data = [scatterData, averageLine];

    const layout = {
        xaxis: {
            title: 'Block height',
            tickvals: x.filter((_, index) => index % 5 === 0),
            ticktext: x.filter((_, index) => index % 5 === 0).map(value => `#${value}`),
            tickfont: { color: '#000000', size: 10, family: '"IBM Plex Mono", monospace' },
            tickangle: -45,
            fixedrange: true
        },
        yaxis: { title: 'Time (s)', dtick: dtick, tickmode: 'linear', range: [0, Math.max(...y) + dtick], fixedrange: true },
        showlegend: false,
        margin: { t: 20, b: 40, l: 40, r: 0 },
        height: 300,
    };
    // disable zoom and pan
    Plotly.newPlot(chart, data, layout, { responsive: true, displayModeBar: false });
}
function displayBestValidatorsChart() {} // TODO
/** @param {Spectrum} spectrum @param {number} [limit] */
function mergeAndSortVssSpectrum(spectrum, limit = 20) {
    /** @type {Object<string, number>} */
    const addressesStakes = {};
    let start = 0;
    for (const [key, stakeRef] of Object.entries(spectrum)) {
        const value = parseInt(key) - start;
        const address = stakeRef.address;
        start = parseInt(key);

        if (!addressesStakes[address]) addressesStakes[address] = 0;
        addressesStakes[address] += value;
    }

    
    /** @type {Object<string, number>} */
    const sortedSpectrum = {};
    let biggestStake = 0;
    const sortedAddresses = Object.keys(addressesStakes).sort((a, b) => addressesStakes[b] - addressesStakes[a]);
    for (let i = 0; i < sortedAddresses.length; i++) {
        const address = i < limit ? sortedAddresses[i] : 'Others';
        const stake = addressesStakes[sortedAddresses[i]];

        if (!sortedSpectrum[address]) sortedSpectrum[address] = 0;
        sortedSpectrum[address] += stake;

        if (sortedSpectrum[address] > biggestStake) biggestStake = sortedSpectrum[address];
    }

    return { sortedSpectrum, biggestStake };
}
function displayVssChart(spectrum, minColor = 255) {
    const chart = eHTML.vssChart;
    if (!chart) return;

    const { sortedSpectrum, biggestStake } = mergeAndSortVssSpectrum(spectrum, 10);
    //console.log('sortedSpectrum', sortedSpectrum);

    // Pie Charts
    const values = Object.values(sortedSpectrum);
    const texts = Object.keys(sortedSpectrum).map((address) => {
        const stake = sortedSpectrum[address];
        return `  ${address} | ${convert.formatNumberAsCurrency(stake)}c  `;
    });

    const data = [{
        values: values,
        labels: Object.keys(sortedSpectrum),
        type: 'pie',
        //direction: 'clockwise',
        
        text: Object.keys(sortedSpectrum).map((address, i) => {
            const stake = sortedSpectrum[address];
            const stakeText = convert.formatNumberAsCurrency(stake);
            //const addressText = address.length > 10 ? address.slice(0, 4) + '...' + address.slice(-4) : address;
            //return `  ${addressText} | ${stakeText}c  `;
            const addressText = address.length > 10 ? address.slice(0, 4) + '...' + address.slice(-4) : address;
            return `  ${addressText}  `;
        }),
        textposition: 'inside',
        insidetextfont: { color: '#ffffff', weight: '600', size: 10, family: '"IBM Plex Mono", monospace' },
        insidetextorientation: 'radial',
        insidetextanchor: 'middle',
        marker: { 
            colors: values.map((value) => {
                const grey = minColor - Math.floor((value / biggestStake) * minColor);
                return `rgb(${grey}, ${grey}, ${grey})`;
            })
        },
        //hoverinfo: 'text',
        hovertemplate: texts.map((text) => text + '<extra></extra>'),
        hoverlabel: { bgcolor: '#000000', font: { color: '#ffffff' } },
    }];

    const layout = {
        title: 'VSS Spectrum',
        showlegend: false,
        height: 300,
        width: 300,
        margin: { t: 20, b: 0, l: 0, r: 0 },
    };

    Plotly.newPlot(chart, data, layout, { responsive: true, displayModeBar: false }).then(() => {
        chart.on('plotly_click', function(data){
            const point = data.points[0];
            const clickedAddress = point.label;
            copyClipboardOrPostMessageToParent(clickedAddress);
        });
    });
}
function displayRoundLegitimaciesChart(roundLegitimacies = {}, max = 10, minColor = 255) {
    const chart = eHTML.roundLegitimaciesChart;
    if (!chart) return;

    // use plotly to create the chart
    // x axis: legitimacy, y axis: address
    const x = Object.values(roundLegitimacies).slice(0, max).reverse();
    const y = Object.keys(roundLegitimacies).slice(0, max).reverse();
    
    // decay by 2 to offer space for the labels
    const decay = 20;
    const xDecayed = x.map((value) => value += decay);
    const total = x.length + decay; // add decay to the total to offer space for the labels
    
    // bar color from black to gray
    const data = [{
        x: xDecayed,
        y,
        mode: 'markers',
        type: 'bar',
        orientation: 'h',
        marker: {
            color: x.map((value) => {
                const grey = Math.floor((value / x.length) * minColor);
                return `rgb(${grey}, ${grey}, ${grey})`;
            }),
        },
        text: x.map((value, index) => `${value} | ${y[index]}  `),
        textposition: 'inside', 
        textfont: { color: '#ffffff', size: 10, weight: '600', family: '"IBM Plex Mono", monospace' },
        hoverinfo: 'none',
    }];

    const layout = {
        xaxis: { title: 'Legitimacy', showticklabels: false, showgrid: false, range: [Math.floor(decay * .5), total], fixedrange: true },
        yaxis: { title: 'Address', showticklabels: false, showgrid: false, fixedrange: true },
        showlegend: false,
        margin: { t: 20, b: 0, l: 0, r: 0 },
        height: 300,
        width: 400,
    };

    Plotly.newPlot(chart, data, layout, { responsive: true, displayModeBar: false }).then(() => {
        chart.on('plotly_click', function(data){
            const point = data.points[0];
            const clickedAddress = point.label;
            copyClipboardOrPostMessageToParent(clickedAddress);
        });
    });
}
async function displayBiggestsHoldersBalancesChart(biggestsHoldersBalances, minColor = 255) {
    // [{address, balance}, ...]
    const chart = eHTML.biggestsHoldersBalancesChart;
    if (!chart) return;

    // bars chart
    // x: values, y: addresses
    while (!window.blockExplorerWidget?.lastCirculatingSupply) await new Promise(resolve => setTimeout(resolve, 1000));

    const biggestBalance = biggestsHoldersBalances[0].balance;
    biggestsHoldersBalances.reverse();
    const circulatingSupply = window.blockExplorerWidget?.lastCirculatingSupply || 0;
    //console.log('circulatingSupply', circulatingSupply);
    const x = biggestsHoldersBalances.map((holder) => holder.balance);
    const y = biggestsHoldersBalances.map((holder) => holder.address);
    const texts = biggestsHoldersBalances.map((holder) =>
        ` ${holder.address}  |  ${convert.formatNumberAsCurrency(holder.balance)}c  (${((holder.balance / BLOCKCHAIN_SETTINGS.maxSupply) * 100).toFixed(2)}% of max supply) `);

    const data = [{
        x,
        y,
        type: 'bar',
        orientation: 'h',
        marker: {
            color: x.map((value) => {
                const grey = Math.floor(minColor - ((value / biggestBalance) * minColor));
                return `rgb(${grey}, ${grey}, ${grey})`;
            }),
        },
        text: x.map((value, index) => {
            const supplyPercent = ((value / circulatingSupply) * 100).toFixed(2);
            if (supplyPercent < 4) return `${supplyPercent}% `;
            return `${supplyPercent}% | ${y[index].slice(0, 4)}... `;
        }),
        textposition: 'inside', 
        insidetextfont: { color: '#ffffff', size: 10, weight: '600', family: '"IBM Plex Mono", monospace' },
        hovertemplate: texts.map((text) => text + '<extra></extra>'),
        hoverlabel: { bgcolor: '#000000', font: { color: '#ffffff' } },
    }];

    const layout = {
        xaxis: { title: 'Balance', showticklabels: false, showgrid: false, fixedrange: true },
        yaxis: { title: 'Address', showticklabels: false, showgrid: false, fixedrange: true },
        showlegend: false,
        margin: { t: 20, b: 0, l: 0, r: 0 },
        /*height: 300,
        width: 400,*/
    };

    Plotly.newPlot(chart, data, layout, { responsive: true, displayModeBar: false, staticPlot: false }).then(() => {
        chart.on('plotly_click', function(data){
            const point = data.points[0];
            const clickedAddress = point.label;
            copyClipboardOrPostMessageToParent(clickedAddress);
        });
    });
}
//#endregion --------------------------------------------------------------
//#region CONTRAST APP FUNCTIONS ----------------------------------
const validParentOrigins = [`https://www.contrast.science`, `http://pinkparrot.science:4321`, `http://localhost:4321`, 'file://'];
function copyClipboardOrPostMessageToParent(value) {
	if (!isIFrame) {
		navigator.clipboard.writeText(value).then(() => {
			console.log('Copied to clipboard:', value);
		}).catch(err => {
			console.error('Failed to copy: ', err);
		});
	} else {
		for (const origin of validParentOrigins)
			window.parent.postMessage({ type: 'copy_text', value }, origin);
	}
}
//#endregion --------------------------------------------------------------

// EVENT LISTENERS -------------------------------------------------------
document.addEventListener('click', (event) => {
    if (window.parent && window !== window.parent) window.parent.postMessage({ type: 'iframeClick' }, 'file://');

    /** @type {BlockExplorerWidget} */
    const blockExplorerWidget = window.blockExplorerWidget;
    if (!blockExplorerWidget) return;
    const nbOfParentToTry = 5;

    let element = event.target;
    for (let i = 0; i < nbOfParentToTry; i++) {
        if (!blockExplorerWidget) return;
        
        // trying by id
        let listener = blockExplorerWidget.clickEventsListeners[element.id];
        if (listener) { listener(event); return; }

        // trying by class
        listener = blockExplorerWidget.clickEventsListeners[element.classList[0]];
        if (listener) { listener(event); return; }

        if (element.parentElement === null) return;
        element = element.parentElement
    }
});
document.addEventListener('keyup', (event) => {
    /** @type {BlockExplorerWidget} */
    const blockExplorerWidget = window.blockExplorerWidget;
    if (!blockExplorerWidget) return;

    let listener = blockExplorerWidget.inputEventsListeners[event.target.id];
    if (listener) listener(event);
});
// event hover
document.addEventListener('mouseover', (event) => {
    if (event.target.dataset.infokey) window.parent.postMessage({ eventType: 'mouseHover', infokey: event.target.dataset.infokey }, '*');

    /** @type {BlockExplorerWidget} */
    const blockExplorerWidget = window.blockExplorerWidget;
    if (!blockExplorerWidget) return;
    const nbOfParentToTry = 3;

    let element = event.target;
    for (let i = 0; i < nbOfParentToTry; i++) {
        if (!blockExplorerWidget) return;

        // trying by id
        let listener = blockExplorerWidget.hoverEventsListeners[element.id];
        if (listener) { listener(event); return; }

        // trying by class
        listener = blockExplorerWidget.hoverEventsListeners[element.classList[0]];
        if (listener) { listener(event); return; }

        if (element.parentElement === null) return;
        element = element.parentElement
    }
});
window.addEventListener('message', function(event) {
    const data = event.data;
    if (data.type === 'darkMode' && typeof data.value === 'boolean') {
        if (data.value) document.body.classList.add('dark-mode');
        else document.body.classList.remove('dark-mode');
    }
});