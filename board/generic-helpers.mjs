// @ts-check

/**
 * @param {string} tag The HTML tag to create
 * @param {string[]} [classes] Optional array of classes to add to the created element
 * @param {HTMLElement | undefined} parent Optionnal parent HTML element to append the created element to */
export function createElement(tag, classes = [], parent = undefined) {
    /** @type {HTMLElement} */
    const element = document.createElement(tag);
    for (const cl of classes) element.classList.add(cl);
    if (parent) parent.appendChild(element);
    return element;
}