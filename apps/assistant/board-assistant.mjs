if (false) { // For better completion
	const anime = require('animejs');
}

/**
 * @typedef {Object<string, Function>} ChoicesActions
 * 
 * @typedef {Object} HtmlElements
 * @property {HTMLElement} assistantContainer
 * @property {HTMLElement} messagesContainer
 * @property {HTMLElement} inputForm
 * @property {HTMLElement} inputIdle
 * @property {HTMLElement} inputIdleText
 * @property {HTMLElement} input
 * @property {HTMLElement} sendBtn
 * @property {HTMLElement} choicesContainer
 */

export class Assistant {
    isFirstMessage = true;
    activeInput = 'idle';
    nextActiveInputTimeout = null;
    /** @type {HtmlElements} */
    eHTML = {
        assistantContainer: null,
        messagesContainer: null,

        inputForm: null,
        inputIdle: null,
        inputIdleText: null,
        input: null,
        sendBtn: null,
        choicesContainer: null
    };
    /** @type {Function} */
    onResponse = null;
    #userResponse = null;
    constructor(idPrefix = 'board') {
        this.idPrefix = idPrefix;
        this.init();
    }

    async init() {
        console.log('Assistant init', document.getElementById(`${this.idPrefix}-assistant-container`));
        while (document.getElementById(`${this.idPrefix}-assistant-container`) === null) { await new Promise(resolve => setTimeout(resolve, 20)); }
        console.log('Assistant init start');

        this.eHTML.assistantContainer = document.getElementById(`${this.idPrefix}-assistant-container`);
        this.eHTML.messagesContainer = document.getElementById(`${this.idPrefix}-messages-container`);

        this.eHTML.inputForm = document.getElementById(`${this.idPrefix}-assistant-text-input-form`);
        this.eHTML.input = document.getElementById(`${this.idPrefix}-messages-input`);
        this.eHTML.sendBtn = document.getElementById(`${this.idPrefix}-send-btn`);
        this.eHTML.inputIdle = document.getElementById(`${this.idPrefix}-assistant-input-idle`);
        this.eHTML.inputIdleText = this.eHTML.inputIdle.querySelector('span');

        this.eHTML.choicesContainer = document.getElementById(`${this.idPrefix}-assistant-choices-container`);

        this.#setupEventListeners();
        this.#idleInfiniteAnimation();
    }
    #setupEventListeners() {
        this.eHTML.sendBtn.addEventListener('click', () => {
            this.sendMessage(this.eHTML.input.value, 'user');
            this.eHTML.input.value = '';
        });
        this.eHTML.inputForm.addEventListener('submit', (event) => {
            event.preventDefault();
        });
    }
    #obfuscateString(string = '') {
        return string.replace(/./g, '•');
    }
    async sendMessage(message, sender = 'system') {
        if (sender === 'system' && !this.isFirstMessage) { await new Promise(resolve => setTimeout(resolve, 600)); }
        this.isFirstMessage = false;

        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message');
        messageDiv.classList.add(sender);

        const needObfuscate = sender === 'user' && this.eHTML.input.type === 'password';
        messageDiv.textContent = needObfuscate ? this.#obfuscateString(message) : message;
        this.eHTML.messagesContainer.appendChild(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;

        if (sender === 'system') return;
        this.onResponse(message);
    }

    requestNewPassword() {
        this.sendMessage('Welcome to Contrast, the setup process will only take a few minutes...');
        setTimeout(() => {
            this.onResponse = this.#verifyNewPassword;
            this.sendMessage('Please enter a new password');
            this.#setActiveInput('password', 'Your new password...', true);
        }, 600);
    }
    #verifyNewPassword(password = 'toto') {
        const isValid = typeof password === 'string' && password.length > 5 && password.length < 30;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        this.#userResponse = password;
        this.onResponse = this.#confirmNewPassword;
        this.sendMessage('Confirm your password');
        this.#setActiveInput('password', 'Confirm your password...', true);
    }
    #confirmNewPassword(password = 'toto') {
        if (typeof password !== 'string') { this.sendMessage('What the hell are you doing?'); return; }
        if (password !== this.#userResponse) { this.sendMessage('Passwords do not match.'); return; }

        window.electronAPI.setPassword(password);
        this.#setActiveInput('idle');
    }

    requestPrivateKey() {
        this.sendMessage('Please enter your private key (64 characters hexadecimal)');
        this.#setActiveInput('text', 'Your private key...', true);
        this.onResponse = this.#verifyPrivateKey;
    }
    #verifyPrivateKey(privateKey = 'toto') {
        // hex only, 64 characters
        const isValid = typeof privateKey === 'string' && privateKey.length === 64 && this.#isHexadecimal(privateKey);
        if (!isValid) { this.sendMessage('Invalid private key.'); return; }
        
        this.sendMessage('Initializing node... (can take a up to a minute)');
        window.electronAPI.setPrivateKeyAndStartNode(privateKey);
        this.#setActiveInput('idle');
    }

    requestPasswordToUnlock() {
        this.sendMessage('Please enter your password to unlock');
        this.#setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndUnlock;
    }
    #verifyPasswordAndUnlock(password = 'toto') {
        const isValid = typeof password === 'string' && password.length > 5 && password.length < 30;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        window.electronAPI.setPassword(password);
        this.#setActiveInput('idle');
    }

    requestPasswordToExtract() {
        this.sendMessage('Please enter your password to extract your private key');
        this.#setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndExtract;
    }
    #verifyPasswordAndExtract(password = 'toto') {
        const isValid = typeof password === 'string' && password.length > 5 && password.length < 30;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        window.electronAPI.extractPrivateKey(password);
        setTimeout(() => { this.idleMenu(); }, 1000);
    }

    /** @param {ChoicesActions} choices */
    async requestChoice(choices = { "Yes": () => console.log('Yes'), "No": () => console.log('No') }) {
        this.eHTML.input.type = 'text';
        this.eHTML.choicesContainer.innerHTML = '';
        this.#setActiveInput('choices');
        
        for (const choice of Object.keys(choices)) {
            const choiceBtn = document.createElement('button');
            choiceBtn.textContent = choice;
            choiceBtn.addEventListener('click', () => {
                this.onResponse = choices[choice];
                this.#setActiveInput('idle');
                this.sendMessage(choice, 'user');
            });
            this.eHTML.choicesContainer.appendChild(choiceBtn);
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }

    idleMenu() {
        this.requestChoice({
			'Extract my private key': () => this.requestPasswordToExtract(),
			'Launch at startup': () => { this.sendMessage('Not implemented yet'); this.idleMenu(); },
		});
    }

    /** @param {string} input - 'text', 'password' or 'choices' - default 'idle' */
    #setActiveInput(input = 'idle', placeholder = '', resetValue = false) {
        this.eHTML.input.value = '';
        this.eHTML.inputForm.classList.add('disabled');
        this.eHTML.choicesContainer.classList.add('disabled');
        this.eHTML.inputIdle.classList.add('disabled');

        const delay = this.activeInput === input ? 0 : 200;
        if (this.nextActiveInputTimeout) clearTimeout(this.nextActiveInputTimeout);
        this.nextActiveInputTimeout = setTimeout(() => {
            switch (input) {
                case 'idle':
                    this.eHTML.inputIdle.classList.remove('disabled');
                    break;
                case 'text':
                    this.#setTextInputTypeAndFocus('text', placeholder, resetValue);
                    break;
                case 'password':
                    this.#setTextInputTypeAndFocus('password', placeholder, resetValue);
                    break;
                case 'choices':
                    this.eHTML.choicesContainer.classList.remove('disabled');
                    break;
                default:
                    console.error('Unknown input type:', input);
            }
        }, delay);
    }
    #setTextInputTypeAndFocus(type = 'text', placeholder = '', resetValue = false) {
        this.eHTML.input.autocomplete = 'off';
        this.eHTML.input.type = type;
        this.eHTML.input.placeholder = placeholder;
        if (resetValue) this.eHTML.input.value = '';

        this.eHTML.inputForm.classList.remove('disabled');
        this.eHTML.input.focus();
    }
    async #idleInfiniteAnimation() {
        while (true) {
            const idleText = this.eHTML.inputIdleText.textContent;
            const rnd1 = Math.floor(Math.random() * idleText.length);
            const rnd2 = Math.floor(Math.random() * idleText.length);
            const splitted = idleText.split('');
            const char1 = splitted[rnd1];
            const char2 = splitted[rnd2];
            splitted[rnd1] = char2;
            splitted[rnd2] = char1;
            const newText = splitted.join('');
            this.eHTML.inputIdleText.textContent = newText;
            await new Promise(resolve => setTimeout(resolve, 60));
        }
    }
    #isHexadecimal(str) {
        const regex = /^[0-9a-fA-F]+$/;
        if (str && str.length % 2 === 0 && regex.test(str)) { return true; }
        return false;
    }
}

const assistant = new Assistant('board');
window.assistant = assistant; // Expose the assistant to the window object