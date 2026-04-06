// @ts-check

export class Interactor {
	/** @type {{ commandKey: string | null, value: string | null } | null} */
	#userResponse = null;

	get a() { return this.assistant; }
	assistant;
	
	/** @param {import('./assistant').Assistant} assistant */
	constructor(assistant) { this.assistant = assistant; }

	// COMMON INTERACTIONS
	cancelInteraction = () => {
        this.a.sendMessage(this.a.translator.InteractionCancelled, 'system');
        this.a.idleMenu();
    }
	requestLanguageSelection = () => {
		this.a.sendMessage('Please select your language');
		this.requestChoice({
			'English': () => this.a.translator.setLanguage('en'),
			'Français': () => this.a.translator.setLanguage('fr')
		});
	}
	/** @param {import('./assistant').ChoicesActions} choices */
    async requestChoice(choices = { "Yes": () => console.log('Yes'), "No": () => console.log('No') }) {
        this.a.eHTML.input.type = 'text';
        this.a.eHTML.choicesContainer.innerHTML = '';
        this.a.setActiveInput('choices');
        
        for (const choice in choices) {
            const choiceBtn = document.createElement('button');
            choiceBtn.textContent = choice;
            choiceBtn.addEventListener('click', () => {
                this.a.setActiveInput('idle');
                this.a.onResponse = choices[choice];
                this.a.sendMessage(choice, 'user');
            });
            this.a.eHTML.choicesContainer.appendChild(choiceBtn);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

	// PASSWORD SETUP INTERACTIONS
	/** @param {string | false} failureMsg */
    async requestNewPassword(failureMsg = false) {
        if (failureMsg === false) await this.a.welcome(true);

        setTimeout(() => {
            this.onResponse = this.#verifyNewPassword;
            //this.sendMessage(`(1) ${failureMsg || 'Please enter a new password or press enter to skip (less secure):'}`);
			this.a.sendMessage(`(1) ${failureMsg || this.a.translator.PleaseEnterNewPassword}`);
			this.a.setActiveInput('password', 'Your new password...', true);
        }, failureMsg ? 0 : 5000);
    }
    #verifyNewPassword(password = 'toto') {
        if (password === '') {
            ipcRenderer.send('set-password', 'fingerPrint'); // less secure: use the finger print as password
            this.a.setActiveInput('idle');
            return;
        }

        const isValid = typeof password === 'string' && password.length > 5 && password.length < 31;
        if (!isValid) return this.a.sendMessage('Must be between 6 and 30 characters.'); // re ask confirmation (2)

        this.#userResponse = { commandKey: null, value: password };
        this.onResponse = this.#confirmNewPassword;
        this.a.sendMessage('(2) Confirm your password');
        this.a.setActiveInput('password', 'Confirm your password...', true);
    }
    #confirmNewPassword(password = 'toto') {
        if (typeof password !== 'string') return this.a.sendMessage('What the hell are you typing?');
        if (password !== this.#userResponse?.value) return this.requestNewPassword('Passwords do not match.'); // Retry at step (1)

        ipcRenderer.send('set-password', password);
        this.a.setActiveInput('idle');
    }

	// PASSWORD CHANGE INTERACTIONS
	requestPasswordToChange() {
        this.a.sendMessage('Please enter your current password to change it');
        this.a.setActiveInput('password', 'Your current password...', true);
        this.onResponse = this.#removePasswordToChange;
    }
    #removePasswordToChange(password = 'toto') {
        let existingPassword = password === '' ? 'fingerPrint' : password; // less secure: use the finger print as password
        const isValid = typeof existingPassword === 'string' && existingPassword.length > 5 && existingPassword.length < 31;
        if (!isValid) return this.a.sendMessage('Must be between 6 and 30 characters.');

        ipcRenderer.send('remove-password', existingPassword);
    }
    askNewPassowrdIfRemovedSuccessfully(success = false) {
        if (success) return this.requestNewPassword('Password removed successfully, please enter a new password or press enter to skip (less secure)');
        this.a.sendMessage('Password removal failed, wrong password!');
		this.a.idleMenu();
    }

	// PRIVATE KEY EXTRACTION INTERACTIONS
	requestPasswordToExtract() {
        this.a.sendMessage('Please enter your password to extract your private key');
        this.a.setActiveInput('password', 'Your password...', true);
        this.onResponse = this.#verifyPasswordAndExtract;
    }
    #verifyPasswordAndExtract(password = 'toto') {
        const isValid = typeof password === 'string';
        if (!isValid) return this.a.sendMessage('Must be between 6 and 30 characters.');

        ipcRenderer.send('extract-private-key', password);
        setTimeout(() => this.a.idleMenu(), 1000);
    }

	// RESET INTERACTIONS
	reset() {
	    this.a.sendMessage('Your private key will be lost, are you sure?');
        this.a.interactor.requestChoice({
            'Delete private key': () => ipcRenderer.send('reset-private-key'), // should restart the app
            'Delete all data': () => ipcRenderer.send('reset-all-data'), // should restart the app
            'No': () => this.a.idleMenu()
        });
	}
}