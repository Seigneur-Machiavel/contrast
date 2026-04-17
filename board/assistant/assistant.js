// @ts-check
if (false) { // For better completion
	const anime = require('animejs');
}

import { Interactor } from './interactions.js';
import { CommandInterpreter } from './commands.js';

/**
 * @typedef {import('../wallet/biw.js').BoardInternalWallet} BoardInternalWallet
 * @typedef {import('../utils/translator.js').Translator} Translator */

/**
 * @typedef {Object<string, Function>} ChoicesActions
 * 
 * @typedef {Object} HtmlElements
 * @property {HTMLElement} assistantContainer
 * @property {HTMLElement} messagesContainer
 * @property {HTMLElement} inputForm
 * @property {HTMLElement} inputIdle
 * @property {HTMLElement} inputIdleText
 * @property {HTMLInputElement} input
 * @property {HTMLElement} possibilities
 * @property {HTMLButtonElement} sendBtn
 * @property {HTMLElement} choicesContainer */

export class Assistant {
	/** The user knowledge level, used to unlock more complex commands in the assistant.
	 * - 0 = Newbie, 1 = Intermediate, 2 = Expert */
	userGrade = 2; // DEBUG, initial: 0;
    isFirstMessage = true;
	isReady = false;
    activeInput = 'idle';
	idPrefix = 'board'
	commandInterpreter;
	translator;
	interactor;
	biw;

    /** @type {HtmlElements} */
    eHTML = {						// @ts-ignore
        assistantContainer: null,	// @ts-ignore
        messagesContainer: null,	// @ts-ignore
        inputForm: null,			// @ts-ignore
        inputIdle: null,			// @ts-ignore
        inputIdleText: null,		// @ts-ignore
        input: null,				// @ts-ignore
        possibilities: null,		// @ts-ignore
        sendBtn: null,				// @ts-ignore
        choicesContainer: null		// @ts-ignore
    };

	/** @type {NodeJS.Timeout | null} */	nextActiveInputTimeout = null;
    /** @type {Function | null} */			onResponse = null;

	/** @param {BoardInternalWallet} biw @param {Translator} translator */
    constructor(biw, translator) {
		this.biw = biw;
		this.translator = translator;
		this.interactor = new Interactor(this);
		this.commandInterpreter = new CommandInterpreter(this);
		this.init();
    }

    async init() {
		console.log('Assistant: Waiting for HTML elements to be available...');
        while (document.getElementById(`${this.idPrefix}-assistant-container`) === null) await new Promise(resolve => setTimeout(resolve, 20));
		
		this.isReady = true; console.log('Assistant: HTML elements found, initializing...');

		// @ts-ignore
        this.eHTML.assistantContainer = document.getElementById(`${this.idPrefix}-assistant-container`);	// @ts-ignore
        this.eHTML.messagesContainer = document.getElementById(`${this.idPrefix}-messages-container`);		// @ts-ignore
        this.eHTML.inputForm = document.getElementById(`${this.idPrefix}-assistant-text-input-form`);		// @ts-ignore
        this.eHTML.input = document.getElementById(`${this.idPrefix}-messages-input`);						// @ts-ignore
        this.eHTML.possibilities = document.getElementById(`${this.idPrefix}-messages-input-possibilitiesList`); // @ts-ignore
        this.eHTML.sendBtn = document.getElementById(`${this.idPrefix}-send-btn`);							// @ts-ignore
        this.eHTML.inputIdle = document.getElementById(`${this.idPrefix}-assistant-input-idle`);			// @ts-ignore
        this.eHTML.inputIdleText = this.eHTML.inputIdle.querySelector('span');								// @ts-ignore
        this.eHTML.choicesContainer = document.getElementById(`${this.idPrefix}-assistant-choices-container`);

        this.#setupEventListeners();
        this.#idleInfiniteAnimation();
    }
	async welcome(displaySetupMessage = false) {
		while (!this.isReady) await new Promise(resolve => setTimeout(resolve, 200)); // Wait until the assistant is ready
		console.log('-- Assistant displaying welcome message --');
		setTimeout(() => this.sendMessage(this.translator.Welcome), 600);
		setTimeout(() => this.sendMessage(this.translator.JoinDiscord), 1600);
		if (displaySetupMessage) setTimeout(() => this.sendMessage(this.translator.SetupProcess), 2200);
		setTimeout(() => this.idleMenu(), displaySetupMessage ? 2800 : 2200);
	}
    #setupEventListeners() {
        this.eHTML.sendBtn.addEventListener('click', () => {
            console.log('click');
            this.sendMessage(this.eHTML.input.value, 'user');
            this.eHTML.input.value = '';
        });
        this.eHTML.inputForm.addEventListener('submit', (e) => {
			console.log('submit');
            e.preventDefault();
            this.eHTML.input.blur(); // blur the input to hide the possibilities list
        });

        this.eHTML.input.addEventListener('focus', () => this.commandInterpreter.updateOptionsList());
        this.eHTML.input.addEventListener('input', () => this.commandInterpreter.updateOptionsList());
        this.eHTML.input.addEventListener('blur', () => this.commandInterpreter.updateOptionsList());
        // if press "tab" in input, select the first possibility
        this.eHTML.input.addEventListener('keyup', (event) => {
            if (event.key !== 'Tab') return;
			event.preventDefault();
			const firstOption = this.eHTML.possibilities.querySelector('option');
			if (!firstOption) return;
			this.eHTML.input.value = firstOption.value;
			this.commandInterpreter.updateOptionsList();
        });
    }

    async idleMenu() { // Come back to simple text input awaiting user command.
		while (!this.isReady) await new Promise(resolve => setTimeout(resolve, 100)); // Wait until the assistant is ready
		this.setActiveInput('text', this.translator.TypeYourCommand, true);
        this.onResponse = this.commandInterpreter.processCommand;
    }
	/** @param {string} message @param {string} sender */
    async sendMessage(message, sender = 'system') {
        if (sender === 'system' && !this.isFirstMessage) await new Promise(resolve => setTimeout(resolve, 200));
        this.isFirstMessage = false;

        const msgLower = message.toLowerCase();
        if (msgLower === '-cancel' || msgLower ==='-c') return this.interactor.cancelInteraction();
        if (msgLower === 'cancel' || msgLower ==='c') return this.interactor.cancelInteraction();

        const messageDiv = document.createElement('div');
        messageDiv.classList.add('board-message');
        messageDiv.classList.add(sender);

        const needObfuscate = sender === 'user' && this.eHTML.input.type === 'password';
        const secureText = message.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

        // Replace line breaks with <br> tags for HTML rendering
        if (needObfuscate) messageDiv.innerText = this.#obfuscateString(message);
        else messageDiv.innerHTML = secureText.replace(/\n/g, "<br>");
        
        this.eHTML.messagesContainer.appendChild(messageDiv);
        this.#addMessageDeleteBtn(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;

        if (sender === 'system') return;
		//console.log(this.onResponse); // DEBUG => Log the callback fnc
        this.onResponse?.(message);
    }
	#obfuscateString(string = '') {
        return string.replace(/./g, '•');
    }
	/** @param {HTMLElement} messageDiv */
    #addMessageDeleteBtn(messageDiv) {
        const deleteBtn = document.createElement('button');
        deleteBtn.classList.add('board-delete-btn');
        deleteBtn.textContent = 'X';
        deleteBtn.addEventListener('click', () => messageDiv.remove());
        messageDiv.appendChild(deleteBtn);
    }

    requestPrivateKey() {
        this.sendMessage('Please enter your private key (64 characters hexadecimal or 24 words list)');
        this.setActiveInput('password', 'Your private key...', true);
        this.onResponse = this.#verifyPrivateKey;
    }
    #digestWordsListStr(wordsList = 'toto toto ...') {
        const split = wordsList.split(' ');
        const words = [];
        //console.log('split:', split);
        for (const part of split) {
            let cleaned = part.trim().toLowerCase(); // remove spaces and lowercase
            cleaned = cleaned.replace(/[^a-z]/g, ''); // remove all non-alphabetic characters
            if (cleaned.length > 0) words.push(cleaned);
        }

        if (words.length % 2 !== 0) return null; // must be even

        const wl = words.join(' '); // @ts-ignore
        return bip39.mnemonicToEntropy(wl).toString('hex');
    }
	/** @param {string} str */
    #isHexadecimal(str) {
        const regex = /^[0-9a-fA-F]+$/;
        if (str && str.length % 2 === 0 && regex.test(str)) { return true; }
        return false;
    }
	/** @param {string} privateKey */
    #verifyPrivateKey(privateKey) {
        if (typeof privateKey !== 'string') return this.sendMessage('Invalid private key. (must be a string)');

        //console.log('privateKey:', privateKey);
		const isWordsList = privateKey.split(' ').length > 1;
        const privKeyHex = isWordsList ? this.#digestWordsListStr(privateKey) : privateKey;
		if (isWordsList && !privKeyHex) return this.sendMessage('Invalid private key (words list).');

        // hex only, 64 characters
        const isValidPrivHex = privKeyHex.length === 64 && this.#isHexadecimal(privKeyHex);
        if (!isValidPrivHex) return this.sendMessage('Invalid private key. (retry)');
        
        this.sendMessage('Initializing node... (can take a up to a minute)');
        ipcRenderer.send('set-private-key-and-start-node', privKeyHex);
        this.setActiveInput('idle');
    }

    requestPasswordToUnlock(failed = false) {
        this.sendMessage(failed ? 'Wrong password, try again' : 'Please enter your password to unlock');
        this.setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndUnlock;
    }
    #verifyPasswordAndUnlock(password = 'toto') {
        const isValid = typeof password === 'string' && password.length > 5 && password.length < 31;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        ipcRenderer.send('set-password', password);
        this.setActiveInput('idle');
    }

	/** @param {string} privateKeyHex @param {boolean} [asWords] default false */
    showPrivateKey(privateKeyHex, asWords = false) {
        if (!asWords) return this.sendMessage(privateKeyHex, 'system');

        /** @type {string} */										// @ts-ignore
        const wordsList = bip39.entropyToMnemonic(privateKeyHex); 	// @ts-ignore
        const hexFromList = bip39.mnemonicToEntropy(wordsList).toString('hex');
        if (hexFromList !== privateKeyHex) return this.sendMessage('Error while extracting the private key!', 'system');
        
        // this.sendMessage(wordsList, 'system'); just to test: ok
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('board-message');
        messageDiv.classList.add('board-wordslist');

        const wordsArray = wordsList.split(' ');
        if (wordsArray.length % 2 !== 0) return this.sendMessage('wordsArray.length % 2 !== 0', 'system');

        for (let i = 0; i < wordsArray.length -1; i += 2) {
            const rowDiv = document.createElement('div');
            rowDiv.classList.add('board-wordslist-row');

            const firstWordDiv = document.createElement('div');
            firstWordDiv.classList.add('board-wordslist-word');
            firstWordDiv.textContent = `${i + 1}. ${wordsArray[i]}`;
            rowDiv.appendChild(firstWordDiv);

            const secondWordDiv = document.createElement('div');
            secondWordDiv.classList.add('board-wordslist-word');
            secondWordDiv.textContent = `${i + 2}. ${wordsArray[i + 1]}`;
            rowDiv.appendChild(secondWordDiv);

            messageDiv.appendChild(rowDiv);
        }

        this.eHTML.messagesContainer.appendChild(messageDiv);
        this.#addMessageDeleteBtn(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;
    }
    /** @param {string} input - 'text', 'password' or 'choices' - default 'idle' */
    setActiveInput(input = 'idle', placeholder = '', resetValue = false) {
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
}