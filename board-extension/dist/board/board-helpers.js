// @ts-check

/**
 * @param {string} tag The HTML tag to create
 * @param {string[]} [classes] Optional array of classes to add to the created element
 * @param {HTMLElement | undefined} [parent] Optionnal parent HTML element to append the created element to */
export function createElement(tag, classes = [], parent = undefined) {
    /** @type {HTMLElement} */
    const element = document.createElement(tag);
    for (const cl of classes) element.classList.add(cl);
    if (parent) parent.appendChild(element);
    return element;
}

/** @param {string} title @param {string[]} titleClasses @param {string} value @param {string[]} valueClasses @param {HTMLElement | undefined} [parent] */
export function createSpacedTextElement(title = '1e2...', titleClasses = ['cbe-blockHash'], value = '#123', valueClasses = ['cbe-blockIndex'], parent = undefined) {
    const spacedTextDiv = createElement('div', ['cbe-spacedText']);
    const titleDiv = createElement('div', titleClasses, spacedTextDiv);
    titleDiv.textContent = title;
    const valueDiv = createElement('div', valueClasses, spacedTextDiv);
    valueDiv.textContent = value;

    if (parent) parent.appendChild(spacedTextDiv);
    return spacedTextDiv;
}

export function getTimeSinceBlockConfirmedString(timestamp = 0) {
    const minuteSince = Math.floor((Date.now() - timestamp) / 60000);
    if (minuteSince >= 1) return `~${minuteSince} min ago`;

    const secondsSince = Math.floor((Date.now() - timestamp) / 1000);
    return `~${secondsSince} s ago`;
}

export class eHTML_STORE {
	/** @type {Object<string, HTMLElement>} */	elements = {};
	/** @type {string} */						prefix;
	/** @type {string} */						idUsedToCheckLoad;
	
	constructor(prefix = 'cbe-', idUsedToCheckLoad = 'maxSupply') {
		this.prefix = prefix;
		this.idUsedToCheckLoad = idUsedToCheckLoad;
	}
	
	get isReady() { return !!document.getElementById(`${this.prefix}${this.idUsedToCheckLoad}`); }

	/** @param {string} id */
	get(id, prefix = this.prefix, throwIfNotFound = true) {
		const e = this.elements[id] || document.getElementById(prefix + id);
		if (!e && throwIfNotFound) throw new Error(`Element with id "${id}" not found`);
		if (!e) return null;
		this.elements[id] = e; // store for future use
		return e;
	}
	/** @param {HTMLElement} element @param {string} id */
	add(element, id) {
		element.id = `${this.prefix}${id}`;
		this.elements[id] = element;
	}
	/** @param {string} id */
	remove(id) {
		this.elements[id]?.remove();
		delete this.elements[id];
	}
}