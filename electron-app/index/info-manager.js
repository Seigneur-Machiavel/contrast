/**
 * @typedef {Object} RelatedInfo
 * @property {string} [htmlPath]
 * @property {string} [title]
 * @property {string} [text]
 */

// THE RELATED INFO CAN BE STRUCTURED: { title: 'toto', 'text': 'titi' } or a path to an HTML file
const relatedInfo = {
    myLastLegitimacy: { title: 'My Last Legitimacy', text: 'This is the last time I was considered legitimate.' },
}

class InfoManager {
    infoPanelButton = document.getElementById('board-info-panel-button');
    infoPanel = document.getElementById('board-info-panel');
    hoverInfoKey = null;
    hoverTimeout = null;
    dispatchInfoDelay = 2000;
    constructor() {}

    clickInfoButtonHandler(e) {
        if (e.target.id !== 'board-info-panel-button') return;

        if (e.target.classList.contains('active')) {
            e.target.classList.remove('active');
            this.infoPanel.classList.remove('active');
        } else {
            e.target.classList.add('active');
            this.infoPanel.classList.add('active');
            document.addEventListener('mouseover', this.hoverElementListener);
        }
    }
    hoverElementListener(e) {
        // example: data-infokey="myLastLegitimacy"
        const infoKey = e.target.dataset.infokey;
        if (infoKey === this.hoverInfoKey) return;

        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
        
        if (infoKey === undefined) return
        this.hoverInfoKey = infoKey;

        const relatedInfo = relatedInfo[infoKey];
        if (!relatedInfo) return;

        this.hoverTimeout = setTimeout(() => this.dispatchInfo(infoKey), this.dispatchInfoDelay);
    }
    dispatchInfo(infoKey) {
        const relatedInfo = relatedInfo[infoKey];
        if (relatedInfo.htmlPath) {
            // fetch the HTML file and display it in the info panel
        } else {
            // display the title and text in the info panel
        }
    }
}

module.exports = { InfoManager };