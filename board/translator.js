/**
 * @typedef {'en' | 'fr'} Language
 */

const texts = {
	TypeYourCommand: {
		en: 'Type your command ("-help" for help):',
		fr: 'Tapez votre commande ("-help" pour l\'aide) :',
	},
	Welcome: {
		en: 'Welcome to Contrast app, this open-source software is still in the experimental stage, and no one can be held responsible in case of difficulty or bugs.',
		fr: 'Bienvenue sur l\'application Contrast, ce logiciel open-source est encore en phase expérimentale, et personne ne peut être tenu responsable en cas de difficulté ou de bugs.',
	},
	JoinDiscord: {
		en: 'Join the community on Discord to discuss the project, get help, and make suggestions, which helps improve Contrast: https://discord.gg/4RzGEgUE7R.',
		fr: 'Rejoignez la communauté sur Discord pour discuter du projet, obtenir de l\'aide et faire des suggestions, ce qui aide à améliorer Contrast : https://discord.gg/4RzGEgUE7R.',
	},
	SetupProcess: {
		en: 'Setup process take a few minutes...',
		fr: 'Le processus d\'installation prend quelques minutes...',
	},
	PleaseEnterNewPassword: {
		en: 'Please enter a new password or press enter to skip (less secure):',
		fr: 'Veuillez entrer un nouveau mot de passe ou appuyez sur entrée pour passer (moins sécurisé) :',
	},

}

export class Translator {
	onLanguageChange = null; // Callback function when language changes, receives new language as argument
	availableLanguages = ['en', 'fr'];
	lang;

	/** @param {function(Language):void} onLanguageChange */
	constructor(onLanguageChange) { this.onLanguageChange = onLanguageChange; }
	
	/** @param {Language} lang */
	setLanguage(lang) { 
		this.lang = lang; 
		if (this.onLanguageChange) this.onLanguageChange(lang);
	}

	get TypeYourCommand() { return texts.TypeYourCommand[this.lang] || texts.TypeYourCommand.en; }
	get Welcome() { return texts.Welcome[this.lang] || texts.Welcome.en; }
	get JoinDiscord() { return texts.JoinDiscord[this.lang] || texts.JoinDiscord.en; }
	get SetupProcess() { return texts.SetupProcess[this.lang] || texts.SetupProcess.en; }
	get PleaseEnterNewPassword() { return texts.PleaseEnterNewPassword[this.lang] || texts.PleaseEnterNewPassword.en; }
}