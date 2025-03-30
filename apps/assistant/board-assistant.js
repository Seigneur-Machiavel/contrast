if (false) { // For better completion
	const anime = require('animejs');
}

const { ipcRenderer } = require('electron');

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

class Assistant {
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
    }

    async init() {
        while (document.getElementById(`${this.idPrefix}-assistant-container`) === null) await new Promise(resolve => setTimeout(resolve, 20));

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
            console.log('click');
            this.sendMessage(this.eHTML.input.value, 'user');
            this.eHTML.input.value = '';
        });
        this.eHTML.inputForm.addEventListener('submit', (event) => {
            console.log('submit');
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
    showPrivateKey(privateKeyHex, asWords = false) {
        if (!asWords) { this.sendMessage(privateKeyHex, 'system'); return }

        /** @type {string} */
        const wordsList = bip39.entropyToMnemonic(privateKeyHex);
        const hexFromList = bip39.mnemonicToEntropy(wordsList).toString('hex');
        if (hexFromList !== privateKeyHex) return this.sendMessage('Error while extracting the private key!', 'system');

        
        //this.sendMessage(wordsList, 'system'); just to test: ok
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message');
        messageDiv.classList.add('wordslist');

        const wordsArray = wordsList.split(' ');
        if (wordsArray.length % 2 !== 0) return this.sendMessage('wordsArray.length % 2 !== 0', 'system');

        for (let i = 0; i < wordsArray.length -1; i += 2) {
            const rowDiv = document.createElement('div');
            rowDiv.classList.add('wordslist-row');

            const firstWordDiv = document.createElement('div');
            firstWordDiv.classList.add('wordslist-word');
            firstWordDiv.textContent = `${i + 1}. ${wordsArray[i]}`;
            rowDiv.appendChild(firstWordDiv);

            const secondWordDiv = document.createElement('div');
            secondWordDiv.classList.add('wordslist-word');
            secondWordDiv.textContent = `${i + 2}. ${wordsArray[i + 1]}`;
            rowDiv.appendChild(secondWordDiv);

            messageDiv.appendChild(rowDiv);
        }

        this.eHTML.messagesContainer.appendChild(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;
    }

    requestNewPassword(failureMsg = false) {
        if (failureMsg === false) {
            this.sendMessage('Welcome to Contrast app, this open-source software is still in the experimental stage, and no one can be held responsible in case of difficulty or bugs.');
            setTimeout(() => this.sendMessage('Join the community on Discord to discuss the project, get help, and make suggestions, which helps improve Contrast: https://discord.gg/4RzGEgUE7R.'), 2000);
            setTimeout(() => this.sendMessage('Setup process take a few minutes...'), 4000);
        }

        setTimeout(() => {
            this.onResponse = this.#verifyNewPassword;
            this.sendMessage(`(1) ${failureMsg || 'Please enter a new password or press enter to skip (less secure)'}:`);
            this.#setActiveInput('password', 'Your new password...', true);
        }, failureMsg ? 0 : 5000);
    }
    #verifyNewPassword(password = 'toto') {
        if (password === '') {
            //window.electronAPI.setPassword('fingerPrint'); // less secure: use the finger print as password
            ipcRenderer.send('set-password', 'fingerPrint'); // less secure: use the finger print as password
            this.#setActiveInput('idle');
            return;
        }

        const isValid = typeof password === 'string' && password.length > 5 && password.length < 31;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; } // re ask confirmation (2)

        this.#userResponse = password;
        this.onResponse = this.#confirmNewPassword;
        this.sendMessage('(2) Confirm your password');
        this.#setActiveInput('password', 'Confirm your password...', true);
    }
    #confirmNewPassword(password = 'toto') {
        if (typeof password !== 'string') { this.sendMessage('What the hell are you typing?'); return; }
        if (password !== this.#userResponse) { this.requestNewPassword('Passwords do not match.'); return; } // Retry at step (1)

        //window.electronAPI.setPassword(password);
        ipcRenderer.send('set-password', password);
        this.#setActiveInput('idle');
    }

    requestPrivateKey() {
        this.sendMessage('Please enter your private key (64 characters hexadecimal or 24 words list)');
        this.#setActiveInput('password', 'Your private key...', true);
        this.onResponse = this.#verifyPrivateKey;
    }
    #verifyPrivateKey(privateKey = 'toto') {
        // hex only, 64 characters
        const isValid = typeof privateKey === 'string' && privateKey.length === 64 && this.#isHexadecimal(privateKey);
        if (!isValid) { this.sendMessage('Invalid private key.'); return; }
        
        this.sendMessage('Initializing node... (can take a up to a minute)');
        //window.electronAPI.setPrivateKeyAndStartNode(privateKey);
        ipcRenderer.send('set-private-key-and-start-node', privateKey);
        this.#setActiveInput('idle');
    }

    requestPasswordToUnlock(failed = false) {
        this.sendMessage(failed ? 'Wrong password, try again' : 'Please enter your password to unlock');
        this.#setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndUnlock;
    }
    #verifyPasswordAndUnlock(password = 'toto') {
        const isValid = typeof password === 'string' && password.length > 5 && password.length < 31;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        //window.electronAPI.setPassword(password);
        ipcRenderer.send('set-password', password);
        this.#setActiveInput('idle');
    }

    requestPasswordToExtract() {
        this.sendMessage('Please enter your password to extract your private key');
        this.#setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndExtract;
    }
    #verifyPasswordAndExtract(password = 'toto') {
        const isValid = typeof password === 'string';
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        //window.electronAPI.extractPrivateKey(password);
        ipcRenderer.send('extract-private-key', password);

        setTimeout(() => { this.idleMenu(); }, 6000);
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
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    idleMenu() {
        this.requestChoice({
			'Extract my private key': () => this.requestPasswordToExtract(),
			'Launch at startup': () => {
                this.requestChoice({
                    'Yes': () => { ipcRenderer.send('set-auto-launch', true); this.idleMenu(); },
                    'No': () => { ipcRenderer.send('set-auto-launch', false); this.idleMenu(); }
                });
            },
            'Reset': () => {
                this.sendMessage('Your private key will be lost, are you sure?');
                this.requestChoice({
                    'Delete private key': () => ipcRenderer.send('reset-private-key'), // should restart the app
                    'Delete all data': () => ipcRenderer.send('reset-all-data'), // should restart the app
                    'No': () => this.idleMenu()
                });
            }
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

module.exports = { Assistant };