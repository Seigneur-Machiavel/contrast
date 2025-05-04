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
 * 
 * @typedef {Object} UserCommandsDescription
 * @property {string} command - The full command name
 * @property {string} [short] - The short command name
 * @property {string} description - The command description
 */

/** @type {UserCommandsDescription[]} */
const userCommandsDescriptions = [
    { command: '-help', short: '-h', description: 'Show available commands' },
    { command: '-cancel', short: '-c', description: 'Cancel current interaction' },
    { command: '-copy_logs_history', short: '-clh', description: 'Copy logs history to clipboard' },
    { command: '-change_password', short: '-cpass', description: 'Change your password' },
    { command: '-extract_my_private_key', short: '-epk', description: 'Extract your private key' },
    { command: '-reset', short: '-r', description: 'Delete your private key and/or all data' }
]

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
        possibilities: null,
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
        this.eHTML.possibilities = document.getElementById(`${this.idPrefix}-messages-input-possibilitiesList`);
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
            event.preventDefault();
            this.eHTML.input.blur(); // blur the input to hide the possibilities list
        });

        this.eHTML.input.addEventListener('focus', () => this.#updatePossibilitiesList());
        this.eHTML.input.addEventListener('input', () => this.#updatePossibilitiesList());
        this.eHTML.input.addEventListener('blur', () => this.#updatePossibilitiesList());
        // if press "tab" in input, select the first possibility
        this.eHTML.input.addEventListener('keydown', (event) => {
            if (event.key === 'Tab') {
                event.preventDefault();
                const firstOption = this.eHTML.possibilities.querySelector('option');
                if (firstOption) {
                    this.eHTML.input.value = firstOption.value;
                    this.#updatePossibilitiesList();
                }
            }
        });
    }
    #obfuscateString(string = '') {
        return string.replace(/./g, '•');
    }
    #addMesasgeDeleteBtn(messageDiv) {
        const deleteBtn = document.createElement('button');
        deleteBtn.classList.add('board-delete-btn');
        deleteBtn.textContent = 'X';
        deleteBtn.addEventListener('click', () => messageDiv.remove());
        messageDiv.appendChild(deleteBtn);
    }
    #cancelInteraction() {
        this.sendMessage('*Interaction cancelled*', 'system');
        this.idleMenu();
    }
    async sendMessage(message, sender = 'system') {
        if (sender === 'system' && !this.isFirstMessage) { await new Promise(resolve => setTimeout(resolve, 600)); }
        this.isFirstMessage = false;

        const msgLower = message.toLowerCase();
        if (msgLower === '-cancel' || msgLower ==='-c') return this.#cancelInteraction();
        if (msgLower === 'cancel' || msgLower ==='c') return this.#cancelInteraction();

        const messageDiv = document.createElement('div');
        messageDiv.classList.add('board-message');
        messageDiv.classList.add(sender);

        const needObfuscate = sender === 'user' && this.eHTML.input.type === 'password';
        //messageDiv.textContent = needObfuscate ? this.#obfuscateString(message) : message;
        const secureText = message.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

        // Replace line breaks with <br> tags for HTML rendering
        if (needObfuscate) messageDiv.innerText = this.#obfuscateString(message);
        else messageDiv.innerHTML = secureText.replace(/\n/g, "<br>");
        
        this.eHTML.messagesContainer.appendChild(messageDiv);
        this.#addMesasgeDeleteBtn(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;

        if (sender === 'system') return;
        this.onResponse(message);
    }

    #updatePossibilitiesList() {
        const inputValue = this.eHTML.input.value.toLowerCase();
        this.eHTML.possibilities.innerHTML = ''; // clear previous options
        for (const ucd of userCommandsDescriptions) {
            if (!ucd.command.includes(inputValue) && !ucd.short.includes(inputValue)) continue;
            const option = document.createElement('option');
            option.value = ucd.command;
            option.textContent = `${ucd.command} | ${ucd.short} => ${ucd.description}`;
            this.eHTML.possibilities.appendChild(option);
        }
    }
    #displayHelpMessage() {
        const lines = ['Available commands:'];
        for (const ucd of userCommandsDescriptions)
            lines.push(`${ucd.command} or ${ucd.short} => ${ucd.description}`);

        this.sendMessage(lines.join('\n'));
        this.idleMenu();
    }
    #reset() {
        this.sendMessage('Your private key will be lost, are you sure?');
        this.requestChoice({
            'Delete private key': () => ipcRenderer.send('reset-private-key'), // should restart the app
            'Delete all data': () => ipcRenderer.send('reset-all-data'), // should restart the app
            'No': () => this.idleMenu()
        });
    }
    #processCommand(userMessage = '-help') {
        const lowerCaseMessage = userMessage.toLowerCase();
        if (lowerCaseMessage === '') return this.idleMenu();

        switch (lowerCaseMessage) {
            case '-help':
            case '-h':
            case 'help':
            case 'h':
                this.#displayHelpMessage();
                break;

            case '-cancel':
            case '-c':
            case 'cancel':
            case 'c':
                this.#cancelInteraction();
                break;

            case '-copy_logs_history':
            case '-clh':
            case 'copy logs history':
                this.sendMessage('Preparing logs history...');
                ipcRenderer.send('get-logs-historical');
                break;

            case '-change_password':
            case '-cpass':
            case 'change password':
                this.requestPasswordToChange();
                break;

            case '-extract_my_private_key':
            case '-epk':
            case 'extract my private key':
                this.requestPasswordToExtract();
                break;
            
            case '-reset':
            case '-r':
            case 'reset':
                this.#reset();
                break;

            default:
                this.sendMessage('Unknown command, type "-help" for help');
                break;
        }
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

        ipcRenderer.send('set-password', password);
        this.#setActiveInput('idle');
    }

    requestPrivateKey() {
        this.sendMessage('Please enter your private key (64 characters hexadecimal or 24 words list)');
        this.#setActiveInput('password', 'Your private key...', true);
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

        const wl = words.join(' ');
        const hex = bip39.mnemonicToEntropy(wl).toString('hex');
        
        return hex;
    }
    #isHexadecimal(str) {
        const regex = /^[0-9a-fA-F]+$/;
        if (str && str.length % 2 === 0 && regex.test(str)) { return true; }
        return false;
    }
    #verifyPrivateKey(privateKey = 'toto') {
        if (!typeof privateKey === 'string') { this.sendMessage('Invalid private key. (must be a string)'); return; }

        //console.log('privateKey:', privateKey);
        let privKeyHex = privateKey;
        const isWordsList = privateKey.split(' ').length > 1;
        if (isWordsList) { // convert words list to hex
            privKeyHex = this.#digestWordsListStr(privateKey);
            if (!privKeyHex) { this.sendMessage('Invalid private key (words list).'); return; }
        }

        // hex only, 64 characters
        const isValidPrivHex = privKeyHex.length === 64 && this.#isHexadecimal(privKeyHex);
        if (!isValidPrivHex) { this.sendMessage('Invalid private key. (retry)'); return; }
        
        this.sendMessage('Initializing node... (can take a up to a minute)');
        ipcRenderer.send('set-private-key-and-start-node', privKeyHex);
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

        ipcRenderer.send('set-password', password);
        this.#setActiveInput('idle');
    }

    requestPasswordToChange() {
        this.sendMessage('Please enter your current password to change it');
        this.#setActiveInput('password', 'Your current password...', true);
        this.onResponse = this.#removePasswordToChange;
    }
    #removePasswordToChange(password = 'toto') {
        let existingPassword = password === '' ? 'fingerPrint' : password; // less secure: use the finger print as password
        const isValid = typeof existingPassword === 'string' && existingPassword.length > 5 && existingPassword.length < 31;
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        ipcRenderer.send('remove-password', existingPassword);
    }
    askNewPassowrdIfRemovedSuccessfully(success = false) {
        if (success) this.requestNewPassword('Password removed successfully, please enter a new password or press enter to skip (less secure)');
        else { this.sendMessage('Password removal failed, wrong password!'); this.idleMenu() }
    }

    requestPasswordToExtract() {
        this.sendMessage('Please enter your password to extract your private key');
        this.#setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndExtract;
    }
    #verifyPasswordAndExtract(password = 'toto') {
        const isValid = typeof password === 'string';
        if (!isValid) { this.sendMessage('Must be between 6 and 30 characters.'); return; }

        ipcRenderer.send('extract-private-key', password);
        setTimeout(() => { this.idleMenu(); }, 1000);
    }
    showPrivateKey(privateKeyHex, asWords = false) {
        if (!asWords) { this.sendMessage(privateKeyHex, 'system'); return }

        /** @type {string} */
        const wordsList = bip39.entropyToMnemonic(privateKeyHex);
        const hexFromList = bip39.mnemonicToEntropy(wordsList).toString('hex');
        if (hexFromList !== privateKeyHex) return this.sendMessage('Error while extracting the private key!', 'system');
        
        //this.sendMessage(wordsList, 'system'); just to test: ok
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
        this.#addMesasgeDeleteBtn(messageDiv);
        this.eHTML.messagesContainer.scrollTop = this.eHTML.messagesContainer.scrollHeight;
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
        // coming back to simple text input
        this.#setActiveInput('text', "Type your command ('-help' for help)", true);
        this.onResponse = this.#processCommand;
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
}

module.exports = { Assistant };