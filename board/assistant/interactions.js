// @ts-check

export class Interactor {
	/** @type {{ commandKey: string | null, value: string | null } | null} */
	#userResponse = null;
	assistant;

	get a() { return this.assistant; }
	
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
			'English':		() => this.a.translator.setLanguage('en'),
			'Français':		() => this.a.translator.setLanguage('fr'),
			'Italiano':		() => this.a.translator.setLanguage('it'),
			'Español':		() => this.a.translator.setLanguage('es'),
			'Português':	() => this.a.translator.setLanguage('pt'),
			'Deutsch':		() => this.a.translator.setLanguage('de'),
			'Čeština':		() => this.a.translator.setLanguage('cs'),
			'한국어':		() => this.a.translator.setLanguage('ko'),
			'日本語':		() => this.a.translator.setLanguage('ja'),
			'中文（简体）':	() => this.a.translator.setLanguage('zh-s'),
			'中文（繁體）':	() => this.a.translator.setLanguage('zh-t')
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
            await new Promise(resolve => setTimeout(resolve, 60));
        }
    }

	// PASSWORD INTERACTIONS
	async setOrChangePassword() {
		const authInfo = await this.a.biw.getAuthInfo();
		if (authInfo.hasPassword) return this.#requestPasswordToChange();
		else return this.requestNewPassword();
	}
	/** @param {string | false} failureMsg */
    requestNewPassword = async (failureMsg = false) => {
        setTimeout(() => {
            this.a.onResponse = this.#verifyNewPassword;
			this.a.sendMessage(`(1) ${failureMsg || this.a.translator.PleaseEnterNewPassword}`);
			this.a.setActiveInput('password', this.a.translator.YourNewPasswordPlaceholder, true);
        }, failureMsg ? 0 : 3000);
    }
    #verifyNewPassword = (password = 'ContrastWallet') => {
        const isValid = typeof password === 'string' && password.length > 3 && password.length < 31;
        if (!isValid) return this.a.sendMessage(this.a.translator.MustBeBetween4And30Characters); // re ask confirmation (2)

		if (password === 'ContrastWallet') return this.#onConfirmedNewPassword(password); // skip confirmation step if default password is used (less secure)

		// CUSTOM PASSOWRD, ASK FOR CONFIRMATION
        this.#userResponse = { commandKey: null, value: password };
        this.a.onResponse = this.#confirmNewPassword;
        this.a.sendMessage(`(2) ${this.a.translator.ConfirmYourPassword}`);
        this.a.setActiveInput('password', this.a.translator.ConfirmYourPasswordPlaceholder, true);
    }
    #confirmNewPassword = (password = 'toto') => {
        if (typeof password !== 'string') return this.a.sendMessage(this.a.translator.InvalidPasswordInput);
        if (password !== this.#userResponse?.value) return this.requestNewPassword(this.a.translator.PasswordsDoNotMatch); // Retry at step (1)
		this.a.setActiveInput('idle');
		this.#onConfirmedNewPassword(password);
    }
	/** @param {string} password */
	#onConfirmedNewPassword = async (password) => {
		const authInfo = await this.a.biw.getAuthInfo();
		if (authInfo.hasWallet) {
			const success = await this.a.biw.overwritePrivateKeyWithNewPassword('ContrastWallet', password);
			this.a.sendMessage(success ? 'Password updated successfully' : 'Password update failed');
			this.a.setActiveInput('text');
			return this.a.onResponse = null;
		}
		
		this.requestChoice({
			'Generate new wallet': async () => {
				this.a.setActiveInput('idle');
				await this.a.biw.savePrivateKey(password);
				await this.a.biw.loadWalletFromStoredPrivateKey(password);
				this.a.sendMessage('Wallet generated successfully');
				this.a.setActiveInput('text');
				return this.a.onResponse = null;
			},
			'Use existing wallet': () => this.a.requestPrivateKey()
		});
	}
	#requestPasswordToChange = () => {
        this.a.sendMessage('Please enter your current password to change it');
        this.a.setActiveInput('password', 'Your current password...', true);
        this.a.onResponse = this.#removePasswordToChange;
    }
    #removePasswordToChange = async (password = 'ContrastWallet') => {
		const authInfo = await this.a.biw.getAuthInfo();
		if (!authInfo.hasPassword) throw new Error('No password set, cannot change password'); // should not happen, but just in case
		if (!authInfo.hasWallet) throw new Error('No wallet found, cannot change password'); // should not happen, but just in case
        
		let existingPassword = password === '' ? 'ContrastWallet' : password; // less secure: use the finger print as password
        const isValid = typeof existingPassword === 'string' && existingPassword.length > 3 && existingPassword.length < 31;
        if (!isValid) return this.a.sendMessage(this.a.translator.MustBeBetween4And30Characters); // re ask current password
		
		const success = await this.a.biw.overwritePrivateKeyWithNewPassword(existingPassword, 'ContrastWallet');
		this.#askNewPasswordIfRemovedSuccessfully(success);
	}
    #askNewPasswordIfRemovedSuccessfully = (success = false) => {
        if (success) return this.requestNewPassword('Password removed successfully, please enter a new password or press enter to skip (less secure)');
        this.a.sendMessage('Password removal failed, wrong password!');
		this.a.idleMenu();
    }

	// PRIVATE KEY EXTRACTION INTERACTIONS
	async revealSeed() {
		const authInfo = await this.a.biw.getAuthInfo();
		if (!authInfo.hasWallet) return this.a.sendMessage(this.a.translator.NoWalletFoundCannotRevealSeed);
		
		if (!authInfo.hasPassword) return this.#verifyPasswordAndExtract(); // if no password, directly reveal the seed without asking for password
		this.#requestPasswordToExtract();
	}
	#requestPasswordToExtract = () => {
        this.a.sendMessage(this.a.translator.PleaseEnterPasswordToExtract);
        this.a.setActiveInput('password', this.a.translator.YourPasswordPlaceholder, true);
        this.a.onResponse = this.#verifyPasswordAndExtract;
    }
    #verifyPasswordAndExtract = async (password = 'ContrastWallet') => {
        const isValid = typeof password === 'string' && password.length > 3 && password.length < 31;
        if (!isValid) return this.a.sendMessage(this.a.translator.MustBeBetween4And30Characters);

    	const pk = await this.a.biw.getPrivateKey(password);
		if (!pk) return this.a.sendMessage(this.a.translator.WrongPasswordTryAgain);
		
		/** @type {Record<string, () => void>} */
		const choices = {};
		choices[this.a.translator.HexadecimalChoice] = () => { this.a.showPrivateKey(pk, false); this.a.idleMenu(); };
		choices[this.a.translator.WordListChoice] = () => { this.a.showPrivateKey(pk, true); this.a.idleMenu(); };
		choices[this.a.translator.CancelChoice] = () => this.a.idleMenu();

		this.a.sendMessage(this.a.translator.SelectSeedFormatChoice);
		this.a.interactor.requestChoice(choices);
    }

	// RESET INTERACTIONS
	reset() {
	    this.a.sendMessage(this.a.translator.SelectWhatYouWantToResetCarefully);

		/** @type {Record<string, () => void>} */
		const choices = {};
		choices[this.a.translator.DeleteUserPreferencesChoice] = () => {
			this.a.sendMessage(this.a.translator.AreYouSureYouWantToDeleteUserPreferences);
			this.a.interactor.requestChoice({
				'Yes': async () => {
					await this.a.biw.boardStorage.remove('language');
					this.a.sendMessage(this.a.translator.DeletedUserPreferencesSuccessfully);
					await new Promise(resolve => setTimeout(resolve, 2000)); // time to read
					location.reload(); // Reload the page to apply changes
				},
				'No': () => this.a.idleMenu()
			})
		};
		choices[this.a.translator.DeleteWalletChoice] = () => {
			this.a.sendMessage(this.a.translator.AreYouSureYouWantToDeleteWallet);
			this.a.interactor.requestChoice({
				'Yes': async () => { // @ts-ignore: 'chrome' does exit.
					await this.a.biw.disconnectedWallet(true);
					this.a.sendMessage(this.a.translator.WalletDeletedSuccessfully);
					await new Promise(resolve => setTimeout(resolve, 600)); // time to read
					this.a.start(); // Call entry point
				},
				'No': () => this.a.idleMenu()
			})
		};
		choices[this.a.translator.DeleteAllDataChoice] = () => {
			this.a.sendMessage(this.a.translator.AreYouSureYouWantToDeleteAllData);
			this.a.interactor.requestChoice({
				'Yes': async () => {
					await this.a.biw.boardStorage.reset();
					this.a.sendMessage(this.a.translator.AllDataDeletedSuccessfully);
					await new Promise(resolve => setTimeout(resolve, 2000)); // time to read
					location.reload(); // Reload the page to reset everything
				},
				'No': () => this.a.idleMenu()
			})
		};
		choices[this.a.translator.CancelChoice] = () => this.a.idleMenu();

		this.a.interactor.requestChoice(choices);
	}
}