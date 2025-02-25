// THE RELATED INFO CAN BE HTML_string a path to an HTML_file_path
const relatedInfos = {
    infoButton: '<h3>Info-panel button</h3><p>This button will toggle the info panel.</p>',
    
    // NODE DASHBOARD
    myLastLegitimacy: '<h3>My Last Legitimacy</h3><p>Value indicating the legitimacy of the candidate block prepared by your validator node this round; the lower this value, the easier mining becomes.</p><p>Miners will prioritize mining the easiest candidate block in their own interest.</p>',
    minerLegitimacy: '<h3>Miner Legitimacy</h3><p>Value indicating the legitimacy of the candidate block currently being mined by your node, which could be yours or that of another node if it has a lower difficulty (corresponding to a lower legitimacy).</p>',
    hashRate: '<h3>Hash Rate</h3><p>The frequency at which your miner attempts to solve the puzzle to finalize the candidate block it\'s working on.</p><p>Finalizing a block involves earning 50% of the transaction fees and new tokens generated within it.</p>',
    publicAddress: '<h3>Public Address</h3><p>The identification address of your node within the peer-to-peer network.</p>',
    miningRewardAddress: '<h3>Mining Reward Address</h3><p>This is the address where mining rewards will be distributed.</p>',
    validationRewardAddress: '<h3>Validation Reward Address</h3><p>This is the address where validator rewards will be distributed.</p>',
    stakedBalance: '<h3>Staked Balance</h3><p>The amount of contrast locked on the address, increasing the chances of having better legitimacy in the validator role.</p><p>Legitimacy is randomly drawn with each block, with chances proportional to the amount staked by each validator.</p>',
    balance: '<h3>Balance</h3><p>The amount of contrast available on the address.</p>',

    // EXPLORER
    maxSupply: '<h3>Max Supply</h3><p>The total number of contrast that can ultimately be created; this value can never be exceeded.</p>',
    targetBlocktime: '<h3>Target Blocktime</h3><p>The reference time aimed at by the consensus algorithm, corresponding to the target time between two blocks.</p>',
    circulatingSupply: '<h3>Circulating Supply</h3><p>The number of contrast currently in circulation; this number increases with each block depending on the number of newly created tokens.</p>',
    lastBlocktime: '<h3>Last Blocktime</h3><p>The time between the last block and the preceding block.</p>',
    targetBlockday: '<h3>Target Blockday</h3><p>The target number of blocks per day.</p><p>With 120 seconds per block:</p><p> --> 86400/120 = 720.</p>',

    // WALLET
    addressTypes: '<h3>Address Types</h3><p>There are four types of addresses:</p><p> - Weak: No condition</p><p> - Contrast: 16 times harder to generate</p><p> - Secure: 256 times harder to generate</p><p> - Powerful: 4096 times harder to generate</p><p> - Ultimate: 65536 times harder to generate</p><p> The more difficult the address is to generate, the more secure it is to secure your fund over long period of time.</p>',
}

class InfoManager {
    authorizedOrigins = { "http://localhost:27270": true, "http://localhost:27271": true };
    listenersIframeAssociated = [];
    infoPanelButton = document.getElementById('board-info-panel-button');
    infoPanel = document.getElementById('board-info-panel');
    hoverInfoKey = null;
    hoverTimeout = null;
    displayedInfoKey = null;
    dispatchInfoDelay = 100;
    constructor() {}

    clickInfoButtonHandler(e) {
        if (e.target.id !== 'board-info-panel-button') return;

        if (e.target.classList.contains('active')) {
            e.target.classList.remove('active');
            this.infoPanel.classList.remove('active');
        } else {
            e.target.classList.add('active');
            this.infoPanel.classList.add('active');
            if (this.listenersSetup) return;

            this.#setupListeners();
            this.listenersSetup = true;
        }
    }
    async #setupListeners() {
        document.addEventListener('mouseover', (e) => {
            if (e.target.dataset.infokey) this.hoverElementListener(e.target.dataset.infokey);
        });

        window.addEventListener('message', (event) => {
            if (!this.authorizedOrigins[event.origin]) return;
            if (event.data.eventType !== 'mouseHover') return;
            this.hoverElementListener(event.data.infokey);
        });
    }
    /** @param {string} infokey */
    hoverElementListener(infokey) {
        // console.log('hover:', infokey);
        if (typeof infokey !== 'string') return;

        if (infokey === this.hoverInfoKey) return;
        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
        
        if (infokey === undefined) { this.hoverInfoKey = null; return; }
        this.hoverInfoKey = infokey;
        
        if (this.displayedInfoKey === infokey) return;
        if (!relatedInfos[infokey]) return;
        this.hoverTimeout = setTimeout(() => this.dispatchInfo(infokey), this.dispatchInfoDelay);
    }
    dispatchInfo(infoKey) {

        this.infoPanel.innerHTML = '';
        const relatedInfo = relatedInfos[infoKey];
        if (!relatedInfo) return;

        if (relatedInfo.includes('.html')) { // fetch the HTML file and display it in the info panel
            fetch(url_or_file).then(res => res.text()).then(html => this.infoPanel.innerHTML = html);
        }else { // display the HTML string in the info panel
            this.infoPanel.innerHTML = relatedInfo;
        }

        this.displayedInfoKey = infoKey;
    }
}

module.exports = { InfoManager };