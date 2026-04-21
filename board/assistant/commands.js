// @ts-check
/**
 * @typedef {Object} CommandProperties
 * @property {number} minUserGrade - The minimum user grade required to execute the command */

/** @type {Record<string, CommandProperties>} */
const commands = {
	language: 			{ minUserGrade: 0 },
	cancel: 			{ minUserGrade: 0 },
	copy_logs: 			{ minUserGrade: 0 },
	change_password: 	{ minUserGrade: 1 },
	reveal_seed: 		{ minUserGrade: 1 },
	reset: 				{ minUserGrade: 2 },
}

export class CommandInterpreter {
	/** @type {Record<string, string>} */
	commandsCorrespondences = {};
	a;
	/** @param {import('./assistant').Assistant} assistant */
	constructor(assistant) { this.a = assistant; }

	processCommand = () => {
		const inputValue = this.#inputValueWithoutCommandPrefix;
		if (!inputValue) return this.a.sendMessage('Please enter a command after the "/"');

		const cmd = this.commandsCorrespondences[inputValue];
		if (!cmd) return this.a.sendMessage('Unknown command');
		else if (this.a.userGrade < commands[cmd].minUserGrade) return this.a.sendMessage('You do not have the required grade to execute this command');

		if (cmd === 'language') return this.a.interactor.requestLanguageSelection();
		if (cmd === 'cancel') return this.a.interactor.cancelInteraction();
		if (cmd === 'copy_logs') return this.a.sendMessage('Not implemented yet, sorry'); // this.requestLogsHistory();
		if (cmd === 'change_password') return this.a.interactor.setOrChangePassword();
		if (cmd === 'reveal_seed') return this.a.interactor.requestPasswordToExtract();
		if (cmd === 'reset') return this.a.interactor.reset();
		this.a.sendMessage('Unknown command');
		console.warn('Unknown command:', cmd);
    }
	/** Map the translated command to the original command key (e.g. "annuler" => "cancel" in French)
	 * - Called the language change or at startup when language is loaded. */
	updateCommandsCorrespondences() {
		this.commandsCorrespondences = {};
		for (const commandKey in commands)
			this.commandsCorrespondences[this.a.translator.assistantCommand(commandKey).key] = commandKey; 
	}
	updateOptionsList() {
        this.a.eHTML.possibilities.innerHTML = ''; // clear previous options

		const inputValue = this.#inputValueWithoutCommandPrefix;
        for (const key in this.commandsCorrespondences) { // show possibilities based on partial matches
			const cmdKey = this.commandsCorrespondences[key];
			if (this.a.userGrade < commands[cmdKey].minUserGrade) continue; // check if user has the required grade to see the command
			else if (inputValue === key) return this.a.eHTML.sendBtn.click(); // exact match => submit the command
            else if (inputValue && !key.includes(inputValue)) continue;
			else this.#appendOptionToPossibilitiesList(cmdKey);
		}
    }
	get #inputValueWithoutCommandPrefix() {
		const inputValue = this.a.eHTML.input.value.toLowerCase();
		if (!inputValue.startsWith('/')) return null; // not a command if it doesn't start with "/"
		return inputValue.slice(1); // remove the "/" at the beginning if exists
	}
	#appendOptionToPossibilitiesList(commandKey = 'cancel') {
		const { key, description } = this.a.translator.assistantCommand(commandKey);
		const option = document.createElement('option');
		option.value = `/${key}`; 				// the translated command (e.g. "annuler" for "cancel" in French)
		option.textContent = description;		// the translated description (e.g. "Annuler l'interaction en cours" for "Cancel current interaction" in French)
		this.a.eHTML.possibilities.appendChild(option);
	}
}