console.log('run/explorerScript.mjs');
if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const anime = require('animejs');
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
*/

/** @type {BlockExplorerWidget} */
let blockExplorerWidget;
let pageFocused = true;
document.addEventListener("visibilitychange", function() { pageFocused = document.visibilityState === 'visible'; });
/** @type {WebSocket} */
let ws;
async function readyWS() {
    return new Promise((resolve, reject) => {
        if (ws.readyState === 1) { resolve(); return; }
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
    LOCAL: window.explorerLOCAL || false,
    RECONNECT_INTERVAL: 2000,
    GET_CURRENT_HEIGHT_INTERVAL: 5000,
    ROLES: window.explorerROLES || ['chainExplorer', 'blockExplorer'],

    AUTO_CHOSE_BEST_NODES: true,
    CURRENT_NODE_INDEX: 0,
    NODES_LIST: [ // used for redondant connections
        'ws://localhost:27270',
        'ws://pinkparrot.observer',
        'ws://pinkparrot.science:27270',
        'wss://contrast.observer',
        'ws://pariah.monster:27270'
    ],

    NB_OF_CONFIRMED_BLOCKS: window.explorerNB_OF_CONFIRMED_BLOCKS || 5,
}
//#region WEB SOCKET
function onOpen() {
    console.log('Connection opened');
}
function onClose(url = '') {
    console.info(`Connection closed: ${url}`);
    
   /* ws = undefined;
    setTimeout(() => {
        console.info('--- reseting blockExplorerWidget >>>');

        const clonedData = blockExplorerWidget.getCloneBeforeReset();
        blockExplorerWidget = new BlockExplorerWidget('cbe-contrastBlocksWidget', clonedData.blocksDataByHash, clonedData.blocksDataByIndex, clonedData.blocksInfo);

        if (clonedData.modalContainer) {
            blockExplorerWidget.cbeHTML.containerDiv.appendChild(clonedData.modalContainer);
        }
    }, SETTINGS.RECONNECT_INTERVAL);*/
}
function onError(error) {
    console.info('WebSocket error: ' + error);
}
async function onMessage(event) {
    if (!pageFocused) { return; }
    const message = JSON.parse(event.data);
    const trigger = message.trigger;
    const data = message.data;
    let remainingAttempts = 10;
    switch (message.type) {
        case 'current_height':
            const currentHeight = data;
            const lastBlockIndex = blockExplorerWidget.getLastBlockInfoIndex();
            if (lastBlockIndex === 0) { return; }
            //console.log(`current_height: ${currentHeight}, lastBlockIndex: ${lastBlockIndex}`);
            if (currentHeight - lastBlockIndex > 10) {
                console.info('current_height n+10 -> ws.close()');
                try { ws.close() } catch (error) {};
                return;
            }
            break;
        case 'last_confirmed_blocks':
            if (!data || !data[data.length - 1]) { return; }
            //console.log(`last_confirmed_block from ${data[0].header.index} to ${data[data.length - 1].header.index}`);
            //console.log('last_confirmed_block', data[data.length - 1]);
            displayLastConfirmedBlock(data[data.length - 1].header);
            for (const blockInfo of data) { blockExplorerWidget.fillBlockInfo(blockInfo); }
            break;
        case 'broadcast_new_candidate':
            //console.log('broadcast_new_candidate', data);
            break;
        case 'new_block_confirmed':
            //console.log('new_block_confirmed', data);
            displayLastConfirmedBlock(data.header);
            
            /*while (blockExplorerWidget.bcElmtsManager.isSucking) {
                if (remainingAttempts === 0) { return; }
                await new Promise((resolve) => { setTimeout(() => { resolve(); }, 100); });
                remainingAttempts--;
            }*/

            /*const isGapBetweenBlocks = data.header.index - blockExplorerWidget.getLastBlockInfoIndex() > 1;
            if (isGapBetweenBlocks) { 
                console.info('new_block_confirmed -> isGapBetweenBlocks -> ws.close()');
                try { ws.close() } catch (error) {};
                return;
            }*/

            blockExplorerWidget.fillBlockInfo(data);
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
            blockExplorerWidget.addressesExhaustiveData[data.address] = new AddressExhaustiveData(data.addressUTXOs.UTXOs, data.addressTxsReferences);
            blockExplorerWidget.navigateUntilTarget(true);
            break;
        case 'transaction_requested':
            // { transaction, balanceChange, inAmount, outAmount, fee, txReference }
            const transactionWithDetails = data.transaction;
            transactionWithDetails.balanceChange = data.balanceChange;
            transactionWithDetails.inAmount = data.inAmount;
            transactionWithDetails.outAmount = data.outAmount;
            transactionWithDetails.fee = data.fee;
            blockExplorerWidget.transactionsByReference[data.txReference] = transactionWithDetails;
            // set html
            blockExplorerWidget.fillAddressTxRow(data.txReference, data.balanceChange, data.fee);
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
        await new Promise((resolve) => { setTimeout(() => { resolve(); }, SETTINGS.RECONNECT_INTERVAL); });
        if (ws && ws.readyState === 1) { continue; }
        // if connecting, wait... 
        while(ws && ws.readyState === 0) { await new Promise(resolve => setTimeout(resolve, 100)); }

        console.info('--- reseting blockExplorerWidget >>>');

        const clonedData = blockExplorerWidget.getCloneBeforeReset();
        blockExplorerWidget = new BlockExplorerWidget('cbe-contrastBlocksWidget', clonedData.blocksDataByHash, clonedData.blocksDataByIndex, clonedData.blocksInfo);

        if (clonedData.modalContainer) {
            blockExplorerWidget.cbeHTML.containerDiv.appendChild(clonedData.modalContainer);
        }

        connectWS();
    }
}; connectWSLoop();
async function getHeightsLoop() {
    while (true) {
        await new Promise((resolve) => { setTimeout(() => { resolve(); }, SETTINGS.GET_CURRENT_HEIGHT_INTERVAL); });
        if (!ws || ws.readyState !== 1) { continue; }
        try { ws.send(JSON.stringify({ type: 'get_height', data: Date.now() })) } catch (error) {};
    }
}; getHeightsLoop();
//#endregion

const eHTML = {
    contrastBlocksWidget: document.getElementById('cbe-contrastBlocksWidget'),
    contrastExplorer: document.getElementById('cbe-contrastExplorer'),
    chainHeight: document.getElementById('cbe-chainHeight'),
    circulatingSupply: document.getElementById('cbe-circulatingSupply'),
    lastBlocktime: document.getElementById('cbe-lastBlocktime'),
}
//#region HTML ONE-SHOT FILLING -------------------------------------------
if (SETTINGS.ROLES.includes('chainExplorer')) {
    document.getElementById('cbe-maxSupply').textContent = convert.formatNumberAsCurrency(BLOCKCHAIN_SETTINGS.maxSupply)
    document.getElementById('cbe-targetBlocktime').textContent = `${BLOCKCHAIN_SETTINGS.targetBlockTime / 1000}s`;
    document.getElementById('cbe-targetBlockday').textContent = `${(24 * 60 * 60) / (BLOCKCHAIN_SETTINGS.targetBlockTime / 1000)}`;
}
//#endregion --------------------------------------------------------------

const HTML_ELEMENTS_ATTRIBUTES = {
    modalContent: { widthPerc: .9, heightPerc: .9 },
}

export class BlockExplorerWidget {
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
                if (event.target.id !== 'cbe-modalContainer') { return; }

                const modalContainer = this.cbeHTML.modalContainer();
                if (!modalContainer) { return; }
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
                if (event.target.id === 'cbe-TxDetails') { return; }
                const cbeTxDetailsElement = this.cbeHTML.txDetails();
                if (cbeTxDetailsElement) { cbeTxDetailsElement.remove(); }
            },
            'cbe-blockSquare': (event) => {
                const modalContainer = this.cbeHTML.modalContainer();
                if (modalContainer) { modalContainer.remove(); }

                const blockSquare = event.target.closest('.cbe-blockSquare');
                const blockIndex = Number(blockSquare.querySelector('.cbe-blockIndex').textContent.replace('#', ''));
                if (isNaN(blockIndex)) {
                    console.info(`todo: handle n+x blocks`);
                    return;
                }
        
                const blockRect = blockSquare.getBoundingClientRect();
                const blockCenter = { x: blockRect.left + blockRect.width / 2, y: blockRect.top + blockRect.height / 2 };
                
                this.newModalContainer();
                this.newModalContent(blockRect.width, blockRect.height, blockCenter);
                this.navigationTarget.blockReference = blockIndex;

                // we prepared the container and target, we can send the request
                if (this.getBlockDataFromMemoryOrSendRequest(blockIndex) === 'request sent') { return; }
                
                this.navigateUntilTarget(false);
            },
            'cbe-blockHash': (event) => {
                const blockHash = event.target.textContent;
                navigator.clipboard.writeText(blockHash).then(() => {
                    console.log('Block hash copied to clipboard:', blockHash);
                }).catch((error) => {
                    console.error('Block hash copy error:', error);
                });
            },
            'cbe-addressSpan': (event) => {
                const address = event.target.textContent;
                console.log('address span clicked', address);

                this.navigationTarget.address = address;
                if (this.getAddressExhaustiveDataFromMemoryOrSendRequest(address) === 'request sent') { return; }

                // display address infos
                this.navigateUntilTarget(true);
            },
            'cbe-anchorSpan': (event) => {
                const anchor = event.target.textContent;
                console.log('anchor span clicked', anchor);
                this.navigationTarget.blockReference = Number(anchor.split(':')[0]);
                this.navigationTarget.txId = anchor.split(':')[1];
                this.navigationTarget.outputIndex = Number(anchor.split(':')[2]);

                if (this.getBlockDataFromMemoryOrSendRequest(this.navigationTarget.blockReference) === 'request sent') { return; }

                this.navigateUntilTarget(true);
            },
            'cbe-TxRow': (event) => {
                try {
                    if (this.cbeHTML.txDetails()) { this.cbeHTML.txDetails().remove(); }
        
                    const modalContentWrap = this.cbeHTML.modalContentWrap();
                    const blockIndex = modalContentWrap.getElementsByClassName('cbe-blockIndex')[0].textContent.replace('#', '');
                    const blockData = this.blocksDataByIndex[blockIndex];
        
                    const rowElement = event.target.closest('.cbe-TxRow');
                    const txIndex = Number(rowElement.querySelector('td').textContent);
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
                if (!folderButton || event.target !== folderButton) { return; }

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
                    if (this.cbeHTML.txDetails()) { this.cbeHTML.txDetails().remove(); }
        
                    const rowElement = event.target.closest('.cbe-addressTxRow');
                    const txReference = rowElement.querySelector('.cbe-addressTxReference').textContent;
                    const address = document.querySelector('.cbe-addressTitle').textContent;
                    const transaction = this.#getTransactionFromMemoryOrSendRequest(txReference, address);
                    if (transaction === 'request sent') { return; }
        
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

                if (event.key !== 'Enter') { return; }

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
                    if (this.getAddressExhaustiveDataFromMemoryOrSendRequest(inputText) === 'request sent') { return; }
    
                    // display address infos
                    this.navigateUntilTarget(true);
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
                if (txAmount !== '...') { return; } // already filled

                const address = document.querySelector('.cbe-addressTitle').textContent;
                const txReference = rowElement.querySelector('.cbe-addressTxReference').textContent;
                const transaction = this.#getTransactionFromMemoryOrSendRequest(txReference, address);
                if (transaction === 'request sent') { return; }

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

        const upperBackground = createHtmlElement('div', 'cbe-blockExplorerWrapUpperBackground', [], containerDiv);
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
        
        if (address) {
            console.info('navigateUntilTarget =>', address);
        } else if (blockReference === null) {
            console.info('navigateUntilTarget => blockReference === null');
            return; 
        } else {
            console.info('navigateUntilTarget =>', isNaN(blockReference) ? blockReference : blockReference, txId, outputIndex);
        }
        
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
        if (!txId) { return; }

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
            if (outputIndex === null) { return; }

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
                if (!blockSquare) { continue; }

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
        while (true) {
            let numberOfConfirmedBlocksShown = this.bcElmtsManager.getNumberOfConfirmedBlocksShown();
            let isFilled = numberOfConfirmedBlocksShown > this.nbOfConfirmedBlocks;

            await new Promise((resolve) => { setTimeout(() => { resolve(); }, isFilled ? 1000 : 100); });
            if (this.incomingBlocksInfo.length === 0) { continue; }
            
            const blockInfo = this.incomingBlocksInfo.shift();
            for (let i = 0; i < this.blocksInfo; i++) { //TODO: find a better way to avoid empty blocks in the chain
                const blockInfo = this.blocksInfo[i];
    
                /** @type {HTMLDivElement} */
                const chainWrap = this.cbeHTML.chainWrap();
                if (!chainWrap) { console.error('fillBlockInfo() error: chainWrap not found'); return; }
    
                //const blockElement = chainWrap.children.find(block => block.querySelector('.cbe-blockIndex').textContent === `#${blockInfo.header.index}`);
                let blockElement = undefined;
                for (const block of chainWrap.children) {
                    if (block.querySelector('.cbe-blockIndex').textContent === `#${blockInfo.header.index}`) { blockElement = block; break; }
                }
                if (blockElement) { continue; }
    
                console.info(`Missing block ${blockInfo.header.index}, trying to recover...`);
                this.bcElmtsManager.createChainOfEmptyBlocksUntilFillTheDiv(chainWrap);
                for (const blockInfo of this.blocksInfo) { this.fillBlockInfo(blockInfo); }
    
                console.info('recovered');
                break;
            }
    
            const lastBlockInfoIndex = this.getLastBlockInfoIndex();
            if (blockInfo.header.index <= lastBlockInfoIndex) { console.info(`already have block ${blockInfo.header.index}`); continue; }
    
            this.blocksInfo.push(blockInfo);
            this.bcElmtsManager.fillFirstEmptyBlockElement(blockInfo);
            
            numberOfConfirmedBlocksShown = this.bcElmtsManager.getNumberOfConfirmedBlocksShown();
            isFilled = numberOfConfirmedBlocksShown > this.nbOfConfirmedBlocks;
            if (!isFilled) { continue; }
    
            this.blocksInfo.shift();
            const nbOfBlocksInQueue = this.incomingBlocksInfo.length;
            const suckDuration = Math.min(this.animations.newBlockDuration, Math.max(500, 1000 - (nbOfBlocksInQueue * 250)));
            this.bcElmtsManager.suckFirstBlockElement(this.cbeHTML.chainWrap(), suckDuration);
            await new Promise((resolve) => { setTimeout(() => { resolve(); }, suckDuration); });
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
        createSpacedTextElement('Supply', [], `${convert.formatNumberAsCurrency(blockData.supply)}`, [], leftContainer);
        createSpacedTextElement('Size', [], `${(blockData.blockBytes / 1024).toFixed(2)} Ko`, [], leftContainer);
        createSpacedTextElement('Transactions', [], `${blockData.nbOfTxs}`, [], leftContainer);
        createSpacedTextElement('Total fees', [], `${convert.formatNumberAsCurrency(blockData.totalFees)}`, [], leftContainer);
        const minerAddressElmnt = createSpacedTextElement('Miner', [], blockData.minerAddress, [], leftContainer);
        minerAddressElmnt.children[1].innerHTML = `<span class="cbe-addressSpan">${blockData.minerAddress}</span>`;
        const validatorAddressElmnt = createSpacedTextElement('Validator', [], blockData.validatorAddress, [], leftContainer);
        validatorAddressElmnt.children[1].innerHTML = `<span class="cbe-addressSpan">${blockData.validatorAddress}</span>`;
        
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
    fillAddressTxRow(txReference, balanceChange, fee) {
        const addressTxRows = document.querySelectorAll(`.cbe-addressTxRow`);
        for (const addressTxRow of addressTxRows) {
            if (addressTxRow.querySelector('.cbe-addressTxReference').textContent === txReference) {
                addressTxRow.querySelector('.cbe-addressTxAmount').textContent = convert.formatNumberAsCurrencyChange(balanceChange);
                addressTxRow.querySelector('.cbe-addressTxFee').textContent = convert.formatNumberAsCurrency(fee);
                return;
            }
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
        for (const headerText of headers) { createHtmlElement('th', undefined, [], headerRow).textContent = headerText; }

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
        createHtmlElement('td', undefined, [], row).textContent = txIndex;
        createHtmlElement('td', undefined, [], row).textContent = tx.id;
        createHtmlElement('td', undefined, [], row).textContent = `${convert.formatNumberAsCurrency(outputsAmount)} c`;
        createHtmlElement('td', undefined, [], row).textContent = `${weight} B`;

        tbodyDiv.appendChild(row);
        return row;
    }
    /** @param {Transaction} tx @param {string} id */
    #createTransactionDetailsElement(tx, id = 'cbe-TxDetails', killExisting = true) {
        const cbeTxDetailsElement = this.cbeHTML.txDetails();
        if (killExisting && cbeTxDetailsElement) { cbeTxDetailsElement.remove(); }

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
            if (isValidatorTx) { continue; }
            const inputDiv = createHtmlElement('div', `cbe-TxInput-${anchor}`, ['cbe-TxInput'], inputsWrap);
            if (isMinerTx) { inputDiv.textContent = anchor; continue; }
            // check conformity of anchor to avoid code injection
            if (!typeValidation.isConformAnchor(anchor)) { console.error(`Invalid anchor: ${anchor}`); return; }
            inputDiv.innerHTML = `<span class="cbe-anchorSpan">${anchor}</span>`;
        }

        const outputsWrap = createHtmlElement('div', undefined, ['cbe-TxOutputsWrap'], threeContainerWrap);
        createHtmlElement('h3', undefined, [], outputsWrap).textContent = `(${tx.outputs.length}) Outputs`;
        for (const output of tx.outputs) {
            const { address, amount, rule } = output;
            if (!addressUtils.conformityCheck(address)) { console.error(`Invalid address: ${address}`); return; }
            const outputDiv = createHtmlElement('div', undefined, ['cbe-TxOutput'], outputsWrap);
            const addressSpanAsText = `<span class="cbe-addressSpan">${address}</span>`;

            outputDiv.innerHTML = `${convert.formatNumberAsCurrency(amount)} >>> ${addressSpanAsText} (${rule})`;
        }
        if (tx.fee) {
            const feeDiv = createHtmlElement('div', undefined, ['cbe-TxFee'], outputsWrap);
            feeDiv.textContent = `Fee: ${convert.formatNumberAsCurrency(tx.fee)}`;
        } else {
            console.info('tx fee not found');
        }

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
        setTimeout(() => { this.#createTxHistoryFilledWithTxsReferencesElement(addressExhaustiveData, txHistoryWrap); }, 1000);

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
        for (const row of txRows) {
            for (const td of row.children) {
                if (td.textContent === txId) { return row; }
            }
        }
        return null;
    }
    /** @param {string | number} blockReference block hash or block index */
    getBlockDataFromMemoryOrSendRequest(blockReference = 0) {
        const referenceIsHash = typeof blockReference === 'string';

        const fromMemory = referenceIsHash ? this.blocksDataByHash[blockReference] : this.blocksDataByIndex[blockReference];
        if (fromMemory) { return fromMemory; }

        // get the block data from the server
        const requestType = referenceIsHash ? 'get_blocks_data_by_hash' : 'get_blocks_data_by_height';
        console.log(`requesting block data by ${requestType}: ${blockReference}`);
        ws.send(JSON.stringify({ type: requestType, data: blockReference }));
        return 'request sent';
    }
    /** @param {string} txReference @param {string} address - optional */
    #getTransactionFromMemoryOrSendRequest(txReference, address = undefined) {
        let comply = true;
        const fromMemory = this.transactionsByReference[txReference];
        if (fromMemory && address) { comply = fromMemory.balanceChange !== undefined; }
        if (fromMemory && comply) { return fromMemory; }

        console.log(`requesting tx data: ${txReference}`);
        if (address) {
            ws.send(JSON.stringify({ type: 'get_transaction_with_balanceChange_by_reference', data: { txReference, address } }));
        } else {
            ws.send(JSON.stringify({ type: 'get_transaction_by_reference', data: txReference }));
        }
        return 'request sent';
    }
    /** @param {string} address */
    getAddressExhaustiveDataFromMemoryOrSendRequest(address) {
        const fromMemory = this.addressesExhaustiveData[address];
        if (fromMemory) { return fromMemory; }

        console.log(`requesting address exhaustive data: address: ${address}`);
        sendWsWhenReady({ type: 'get_address_exhaustive_data', data: address });
        return 'request sent';
    }
    getLastBlockInfoIndex() {
        return this.blocksInfo.length === 0 ? 0 : this.blocksInfo[this.blocksInfo.length - 1].header.index;
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
            if (this.balances[key]) { this.balances[key] += newBalances[key]; }
            else { this.balances[key] = newBalances[key]; }
        }
       
        const newUTXOsByRules = utxoExtraction.byRules(UTXOs);
        for (const rule in newUTXOsByRules) {
            if (this.UTXOsByRules[rule]) { this.UTXOsByRules[rule].push(...newUTXOsByRules[rule]); }
            else { this.UTXOsByRules[rule] = newUTXOsByRules[rule]; }
        }
    }
    /** @param {string[]} txsReferences */
    mergeNewTxsReferences(newTxsReferences) {
        for (const txReference of newTxsReferences) {
            if (this.addressTxsReferences.includes(txReference)) { continue; }
            this.addressTxsReferences.push(txReference);
        }
    }
    /** @param {AddressExhaustiveData} newData @param {boolean} replaceBalances */
    mergeAddressExhaustiveData(newData, replaceBalances = true) {
        for (const key in newData.balances) {
            if (!replaceBalances) { continue; }
            this.balances[key] = newData.balances[key];
        }

        for (const rule in newData.UTXOsByRules) {
            if (this.UTXOsByRules[rule]) { this.UTXOsByRules[rule].push(...newData.UTXOsByRules[rule]); }
            else { this.UTXOsByRules[rule] = newData.UTXOsByRules[rule]; }
        }

        this.mergeNewTxsReferences(newData.addressTxsReferences);
    }

    highestKnownUTXOsHeight() {
        let highestHeight = 0;
        for (const rule in this.UTXOsByRules) {
            for (const UTXO of this.UTXOsByRules[rule]) {
                const height = UTXO.anchor.split(':')[0];
                if (height > highestHeight) { highestHeight = UTXO.height; }
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
    createChainOfEmptyBlocksUntilFillTheDiv(chainWrap, nbBlocks = 10) {
        const parentRect = chainWrap.parentElement.getBoundingClientRect();
        for (let i = 0; i < nbBlocks; i++) {
            const block = this.createEmptyBlockElement();
            chainWrap.appendChild(block);

            const blockRect = block.getBoundingClientRect();
            if (blockRect.left > parentRect.right) { break; }
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
        weight.textContent = '... Ko';

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
        if (!blockElement) { return; }

        const blockSquare = blockElement.querySelector('.cbe-blockSquare');

        const blockMiniHash = blockSquare.querySelector('.cbe-blockMiniHash');
        blockMiniHash.textContent = this.#splitHash(blockInfo.header.hash, 16).join(' ');

        const blockIndex = blockSquare.querySelector('.cbe-blockIndex');
        blockIndex.textContent = `#${blockInfo.header.index}`;

        const weight = blockSquare.querySelector('.cbe-weight');
        weight.textContent = `${(blockInfo.blockBytes / 1024).toFixed(2)} Ko`;

        const timeAgo = blockSquare.querySelector('.cbe-timeAgo');
        timeAgo.textContent = getTimeSinceBlockConfirmedString(blockInfo.header.timestamp);

        const nbTx = blockSquare.querySelector('.cbe-nbTx');
        nbTx.textContent = `${blockInfo.nbOfTxs} transactions`;
    }
    #splitHash(hash, nbOfCharsPerLine = 16) {
        const hashSplitted = [];
        for (let i = 0; i < hash.length; i += nbOfCharsPerLine) {
            hashSplitted.push(hash.slice(i, i + nbOfCharsPerLine));
        }
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
            complete: () => { 
                this.removeFirstBlockElement();
                chainWrap.appendChild(this.createEmptyBlockElement());
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

blockExplorerWidget = new BlockExplorerWidget();
window.blockExplorerWidget = blockExplorerWidget;
 //test - ignore
/*setTimeout(() => {
    ws.send(JSON.stringify({ type: 'get_blocks_data_by_height', data: 104 }));
}, 1000);*/

//#region FUNCTIONS -------------------------------------------------------
function getTimeSinceBlockConfirmedString(timestamp) {
    const minuteSince = Math.floor((Date.now() - timestamp) / 60000);
    if (minuteSince >= 1) { return `~${minuteSince} min ago`; }

    const secondsSince = Math.floor((Date.now() - timestamp) / 1000);
    return `~${secondsSince} s ago`;
}
/** @param {BlockData} blockHeader */
function displayLastConfirmedBlock(blockHeader) {
    // 1. contrastChainExplorer
    if (SETTINGS.ROLES.includes('chainExplorer')) {
        eHTML.chainHeight.textContent = blockHeader.index;
        eHTML.circulatingSupply.textContent = convert.formatNumberAsCurrency(blockHeader.supply + blockHeader.coinBase);
        eHTML.lastBlocktime.textContent = `${((blockHeader.timestamp - blockHeader.posTimestamp) / 1000).toFixed(2)}s`;
    }

    // 2. contrastBlocksWidget
    if (SETTINGS.ROLES.includes('blockExplorer')) {
        
        
    }
}
function createHtmlElement(tag, id, classes = [], divToInject = undefined) {
    /** @type {HTMLElement} */
    const element = document.createElement(tag);
    if (id) { element.id = id; }

    for (const cl of classes) { element.classList.add(cl); }

    if (divToInject) { divToInject.appendChild(element); }
    return element;
}
function createSpacedTextElement(title = '1e2...', titleClasses = ['cbe-blockHash'], value = '#123', valueClasses = ['cbe-blockIndex'], divToInject = undefined) {
    const spacedTextDiv = createHtmlElement('div', undefined, ['cbe-spacedText']);

    const titleDiv = createHtmlElement('div', undefined, titleClasses, spacedTextDiv);
    titleDiv.textContent = title;
    const valueDiv = createHtmlElement('div', undefined, valueClasses, spacedTextDiv);
    valueDiv.textContent = value;

    if (divToInject) { divToInject.appendChild(spacedTextDiv); }
    return spacedTextDiv;
}
//#endregion --------------------------------------------------------------

// EVENT LISTENERS -------------------------------------------------------
document.addEventListener('click', (event) => {
    if (!blockExplorerWidget) { return; }
    const nbOfParentToTry = 5;

    let element = event.target;
    for (let i = 0; i < nbOfParentToTry; i++) {
        if (!blockExplorerWidget) { return; }
        
        // trying by id
        let listener = blockExplorerWidget.clickEventsListeners[element.id];
        if (listener) { listener(event); return; }

        // trying by class
        listener = blockExplorerWidget.clickEventsListeners[element.classList[0]];
        if (listener) { listener(event); return; }

        if (element.parentElement === null) { return; }
        element = element.parentElement
    }
});
document.addEventListener('keyup', (event) => {
    if (!blockExplorerWidget) { return; }

    let listener = blockExplorerWidget.inputEventsListeners[event.target.id];
    if (listener) { listener(event); }
});
// event hover
document.addEventListener('mouseover', (event) => {
    if (!blockExplorerWidget) { return; }
    const nbOfParentToTry = 3;

    let element = event.target;
    for (let i = 0; i < nbOfParentToTry; i++) {
        if (!blockExplorerWidget) { return; }

        // trying by id
        let listener = blockExplorerWidget.hoverEventsListeners[element.id];
        if (listener) { listener(event); return; }

        // trying by class
        listener = blockExplorerWidget.hoverEventsListeners[element.classList[0]];
        if (listener) { listener(event); return; }

        if (element.parentElement === null) { return; }
        element = element.parentElement
    }
});