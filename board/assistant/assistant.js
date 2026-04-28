// @ts-check
if (false) { // For better completion
	const anime = require('animejs');
}

import { Interactor } from './interactions.js';
import { CommandInterpreter } from './commands.js';
import { IS_VALID } from '../../types/validation.mjs';

/**
 * @typedef {import('../wallet/biw.js').BoardInternalWallet} BoardInternalWallet
 * @typedef {import('../utils/connector-node.js').ConnectorNode} ConnectorNode
 * @typedef {import('../utils/apps-manager.js').AppsManager} AppsManager
 * @typedef {import('../utils/translator.js').Translator} Translator */

/**
 * @typedef {Object<string, Function>} ChoicesActions
 * 
 * @typedef {Object} HtmlElements
 * @property {HTMLElement} assistantContainer
 * @property {HTMLElement} messagesContainer
 * @property {HTMLElement} inputsWrap
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
	connectorNode;
	appsManager;
	isExtension;
	translator;
	interactor;
	biw;

    /** @type {HtmlElements} */
    eHTML = {						// @ts-ignore
        assistantContainer: null,	// @ts-ignore
        messagesContainer: null,	// @ts-ignore
		inputsWrap: null,			// @ts-ignore
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

	/** @param {BoardInternalWallet} biw @param {ConnectorNode} connectorNode @param {AppsManager} appsManager @param {boolean} isExtension @param {Translator} translator */
    constructor(biw, connectorNode, appsManager, isExtension, translator) {
		this.biw = biw;
		this.connectorNode = connectorNode;
		this.appsManager = appsManager;
		this.isExtension = isExtension;
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
        this.eHTML.inputsWrap = document.getElementById(`${this.idPrefix}-assistant-inputs-wrap`);					// @ts-ignore
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
		await new Promise(resolve => setTimeout(resolve, 800));
		this.sendMessage(this.translator.Welcome);
		await new Promise(resolve => setTimeout(resolve, 1200));
		this.sendMessage(this.translator.JoinDiscord);
		await new Promise(resolve => setTimeout(resolve, 800));
		if (!displaySetupMessage) return this.idleMenu();

		this.sendMessage(this.translator.SetupProcess);
		await new Promise(resolve => setTimeout(resolve, 600));
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
	/** @param {string} message @param {'system' | 'user'} [sender] default is 'system' */
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
        if (needObfuscate) messageDiv.innerText = this.translator.UserResponseHidden; // show a generic message instead of the actual user response to avoid displaying sensitive info
        else messageDiv.innerHTML = secureText.replace(/\n/g, "<br>");
        
        this.eHTML.messagesContainer.appendChild(messageDiv);
        this.#addMessageDeleteBtn(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;

        if (sender === 'system') return;
		//console.log(this.onResponse); // DEBUG => Log the callback fnc
		const response = message !== '' ? message : undefined; // if message is empty, set response to undefined to let default values work in callbacks
        this.onResponse?.(response);
    }
	/** @param {HTMLElement} messageDiv */
    #addMessageDeleteBtn(messageDiv) {
        const deleteBtn = document.createElement('button');
        deleteBtn.classList.add('board-delete-btn');
        deleteBtn.textContent = 'X';
        deleteBtn.addEventListener('click', () => messageDiv.remove());
        messageDiv.appendChild(deleteBtn);
    }
	/** @param {string} pk */
    verifyPrivateKey = async (pk) => {
        if (typeof pk !== 'string') return this.sendMessage('Invalid private key. (must be a string)');

		const wordsList = pk.split(' ');
		const isWordsList = wordsList.length > 1;
        const privKeyHex = isWordsList ? this.#digestWordsListStr(wordsList) : pk;
		if (!privKeyHex) return this.sendMessage('Invalid private key');

        // hex only, 48 characters
        const isValidPrivHex = privKeyHex.length === 48 && IS_VALID.HEX(privKeyHex) !== false;
		if (isValidPrivHex) await this.digestPrivateKey(privKeyHex);
        else this.sendMessage('Invalid private key. (retry)');
    }
	#digestWordsListStr(wordsList = ['toto', 'toto', '...']) {
        const words = [];
		for (const part of wordsList) { // clean each part to keep only the word, in case user enter "1. word" or "1) word" for better readability
			const cleaned = part.trim().toLowerCase().replace(/^\d+[.)]\s*/, ''); // strip leading "1." or "1)"
			if (cleaned.length > 0) words.push(cleaned);
		}

        if (words.length % 2 !== 0) return null; // must be even

        const wl = words.join(' '); 				// @ts-ignore
		for (const language in bip39.wordlists) { 	// @ts-ignore
			bip39.setDefaultWordlist(language); 	// @ts-ignore
			try { return bip39.mnemonicToEntropy(wl).toString('hex') }
			catch { continue }
		}
		return null;
    }
	/** @param {string} [privateKeyHex] */
	digestPrivateKey = async (privateKeyHex) => {
		this.setActiveInput('idle');
		await this.biw.savePrivateKey(undefined, privateKeyHex); // Generate and save a new private key with default password
		await this.biw.loadWalletFromStoredPrivateKey();
		if (!this.biw.wallet) throw new Error('Failed to load wallet after generating private key');
		if (!(await this.biw.deriveAccounts(2))) throw new Error('Failed to derive accounts');
		
		this.interactor.requestNewPassword();
		if (!this.connectorNode.isConnected) return;

		// SETUP ADDRESSES IN CONTROLLER -> Rewards of local node will go to the generated wallet.
		const [ vAccount, sAccount ] = this.biw.wallet.accounts;
		this.connectorNode.sendEncryptedMessage('setAddress', { type: 'validator', address: vAccount.address, pubKeysHex: [vAccount.pubKey] });
		this.connectorNode.sendEncryptedMessage('setAddress', { type: 'solver', address: sAccount.address, pubKeysHex: [sAccount.pubKey] });
	}

	/** Based on authInfo => RequestPrivateKey or RequestPasswordToUnlock or load wallet. */
	async start() {
		this.setActiveInput('idle');
		const authInfo = await this.biw.getAuthInfo();
		console.log('authInfo:', authInfo);
		if (!authInfo.hasWallet) 
			if (!this.connectorNode.isWsAccessible) return this.interactor.offerToRunContrastNode();
			else return this.interactor.requestPrivateKey();
		if (authInfo.hasPassword) return this.requestPasswordToUnlock();
		await this.biw.loadWalletFromStoredPrivateKey();
		this.sendMessage(this.translator.WalletUnlocked);
		this.idleMenu();
	}
    requestPasswordToUnlock(failed = false) {
        this.sendMessage(failed ? this.translator.WrongPasswordTryAgain : this.translator.PleaseEnterPasswordToUnlock);
        this.setActiveInput('password', this.translator.YourPasswordPlaceholder, true);
        this.onResponse = this.#verifyPasswordAndUnlock;
    }
    async #verifyPasswordAndUnlock(password = 'ContrastWallet') {
        const isValid = typeof password === 'string' && password.length > 3 && password.length < 31;
        if (!isValid) return this.sendMessage(this.translator.MustBeBetween4And30Characters); // re ask password
		this.setActiveInput('idle');
		try { await this.biw.loadWalletFromStoredPrivateKey(password); }
		catch (e) { return this.requestPasswordToUnlock(true); }
		this.sendMessage(this.translator.WalletUnlocked);
		this.idleMenu();
    }

	/** @param {string} privateKeyHex @param {boolean} [asWords] default false */
    showPrivateKey(privateKeyHex, asWords = false) {
        if (!asWords) return this.sendMessage(privateKeyHex, 'system'); // @ts-ignore
		bip39.setDefaultWordlist(this.translator.bip39Language);

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
		this.idleMenu();
    }
    /** @param {string} input - 'text', 'password' or 'choices' - default 'idle' */
    setActiveInput(input = 'idle', placeholder = '', resetValue = false) {
        this.eHTML.input.value = '';
		this.eHTML.inputsWrap.classList.remove('idle');
		this.eHTML.inputsWrap.classList.remove('text');
		this.eHTML.inputsWrap.classList.remove('choices');

        const delay = this.activeInput === input ? 0 : 200;
        if (this.nextActiveInputTimeout) clearTimeout(this.nextActiveInputTimeout);
        this.nextActiveInputTimeout = setTimeout(async () => {
            switch (input) {
                case 'idle':
					this.eHTML.inputsWrap.classList.add('idle');
                    break;
                case 'text':
                    this.#setTextInputTypeAndFocus('text', placeholder, resetValue);
                    break;
                case 'password':
                    this.#setTextInputTypeAndFocus('password', placeholder, resetValue);
                    break;
                case 'choices':
					this.eHTML.inputsWrap.classList.add('choices');
                    break;
                default:
                    return console.error('Unknown input type:', input);
            }
			await new Promise(resolve => setTimeout(resolve, 250)); // wait for the input to be visible before focusing
			this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;
        }, delay);
    }
    #setTextInputTypeAndFocus(type = 'text', placeholder = '', resetValue = false) {
        this.eHTML.input.autocomplete = 'off';
        this.eHTML.input.type = type;
        this.eHTML.input.placeholder = placeholder;
        if (resetValue) this.eHTML.input.value = '';

		this.eHTML.inputsWrap.classList.add('text');
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