// CHOOSE BETWEEN localStorage AND chrome.storage BASED ON ENVIRONMENT
const isExtension = window.location.protocol.endsWith('-extension:');

export class FrontStorage {
    initiator;
    constructor(initiator = 'global') { this.initiator = initiator; }

	/** @param {string} key @param {Object|number|string|boolean} value */
    async save(key, value) {
        const valueType = typeof value;
		if (!isExtension) localStorage.setItem(`${this.initiator}-${key}-type`, valueType);
		else await chrome.storage.local.set({ [`${this.initiator}-${key}-type`]: valueType });

        if (valueType === 'object') value = JSON.stringify(value);
		if (!isExtension) localStorage.setItem(`${this.initiator}-${key}`, value);
		else await chrome.storage.local.set({ [`${this.initiator}-${key}`]: value });

        //console.log(`[FrontStorage] ${key} saved, value: ${value}`);
    }
	
	/** @param {string} key @param {'default' | 'raw'} [parsing] @returns {Promise<Object|number|string|boolean|null>} */
    async load(key, parsing = 'default') {
		const valueType = !isExtension ? localStorage.getItem(`${this.initiator}-${key}-type`)
			: (await chrome.storage.local.get([`${this.initiator}-${key}-type`]))[`${this.initiator}-${key}-type`];
        if (!valueType) return null;
		
        const v = !isExtension ? localStorage.getItem(`${this.initiator}-${key}`)
			: (await chrome.storage.local.get([`${this.initiator}-${key}`]))[`${this.initiator}-${key}`];
		if (v === null || v === undefined) return null;

        if (parsing === 'default') {
            if (valueType === 'object') return JSON.parse(v);
            if (valueType === 'number') return parseFloat(v);
            if (valueType === 'boolean') return v === 'true';
        }

		return v;
    }
	/** @param {string} key */
	async remove(key) {
		if (isExtension) return await chrome.storage.local.remove([`${this.initiator}-${key}-type`, `${this.initiator}-${key}`]);
		await localStorage.removeItem(`${this.initiator}-${key}-type`);
		await localStorage.removeItem(`${this.initiator}-${key}`);
	}
	async reset() {
		if (isExtension) await chrome.storage.local.clear();
		else await localStorage.clear();
	}
}