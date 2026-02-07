// CHOOSE BETWEEN localStorage AND chrome.storage BASED ON ENVIRONMENT
const mode = chrome.storage?.local ? 'c' : 'l';

export class FrontStorage {
    initiator;
    constructor(initiator = 'global') { this.initiator = initiator; }

	/** @param {string} key @param {Object|number|string|boolean} value */
    async save(key, value) {
        const valueType = typeof value;
		if (mode === 'l') localStorage.setItem(`${this.initiator}-${key}-type`, valueType);
		else if (mode === 'c') await chrome.storage.local.set({ [`${this.initiator}-${key}-type`]: valueType });

        if (valueType === 'object') value = JSON.stringify(value);
		if (mode === 'l') localStorage.setItem(`${this.initiator}-${key}`, value);
		else if (mode === 'c') await chrome.storage.local.set({ [`${this.initiator}-${key}`]: value });

        console.log(`[FrontStorage] ${key} saved, value: ${value}`);
    }
	
	/** @param {string} key @param {'default' | 'raw'} [parsing] @returns {Promise<Object|number|string|boolean|null>} */
    async load(key, parsing = 'default') {
		const valueType = mode === 'l' ? localStorage.getItem(`${this.initiator}-${key}-type`)
			: (await chrome.storage.local.get([`${this.initiator}-${key}-type`]))[`${this.initiator}-${key}-type`];
        if (!valueType) return null;
		
        const v = mode === 'l' ? localStorage.getItem(`${this.initiator}-${key}`)
			: (await chrome.storage.local.get([`${this.initiator}-${key}`]))[`${this.initiator}-${key}`];
		if (v === null || v === undefined) return null;

        if (parsing === 'default') {
            if (valueType === 'object') return JSON.parse(v);
            if (valueType === 'number') return parseFloat(v);
            if (valueType === 'boolean') return v === 'true';
        }

		return v;
    }
}