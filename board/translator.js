/**
 * @typedef {'en' | 'fr'} Language
 */

const assistant = {
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

const explorer = {
	ConsensusNotRobustMessage: {
		en: 'Consensus isn\'t robust - Should not be considered reliable yet.',
		fr: 'Le consensus n\'est pas robuste - Ne pas considérer comme fiable pour le moment.',
	},
	ChainOverviewTitle: {
		en: 'Chain overview',
		fr: 'Aperçu de la chaîne',
	},
	CirculatingSupplyTitle: {
		en: 'Circulating supply',
		fr: 'Offre en circulation',
	},
	DistributionProgressTitle: {
		en: 'Distribution progress',
		fr: 'Progression de la distribution',
	},
	TargetBlockTimeTitle: {
		en: 'Target blockTime',
		fr: 'Temps de bloc cible',
	},
	LastBlockTimeTitle: {
		en: 'Last blockTime',
		fr: 'Dernier temps de bloc',
	},
	LowerIsStronger: {
		en: '(lower = stronger)',
		fr: '(bas = plus fort)',
	},
	CirculatingSupply: {
		en: 'The number of contrast currently in circulation; this number increases with each block depending on the number of newly created tokens.',
		fr: 'Le nombre de contrast actuellement en circulation ; ce nombre augmente à chaque bloc en fonction du nombre de nouveaux jetons créés.',
	},
	DistributionProgress: {
		en: 'The percentage of the total supply that is currently in circulation.',
		fr: 'Le pourcentage de l\'offre totale qui est actuellement en circulation.',
	},
	TargetBlockTime: {
		en: 'The ideal time gap between two consecutive blocks, as defined by the protocol.',
		fr: 'L\'écart de temps idéal entre deux blocs consécutifs, tel que défini par le protocole.',
	},
	LastBlockTime: {
		en: 'The time gap between the last two blocks; this can fluctuate above and below the target block time.',
		fr: 'L\'écart de temps entre les deux derniers blocs ; cela peut fluctuer au-dessus et en dessous du temps de bloc cible.',
	},
	LegitimaciesChart: {
		en: 'Indicating the legitimacy of the candidate block prepared by validators this round',
		fr: 'Indiquant la légitimité du bloc candidat préparé par les validateurs ce tour',
	},
	LastBlocksTimeGap: {
		en: 'The time gap between the 60 last blocks; this helps to control the network\'s stability by displaying the block time deviation.',
		fr: 'L\'écart de temps entre les 60 derniers blocs ; cela aide à contrôler la stabilité du réseau en affichant la déviation du temps de bloc.',
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

		// TRANSLATE TEXT CONTENT
		const elements = document.querySelectorAll('.translatableTextContent');
		for (const el of elements) {
			const key = el.dataset.translatorkey;
			const text = this[key];
			console.log('translating key:', key, 'to:', text);
			if (!text) throw new Error(`No translation found for key "${key}" and language "${this.lang}"`);
			el.textContent = text;
		}
	}

	// BOARD

	// ASSISTANT
	get TypeYourCommand() { return assistant.TypeYourCommand[this.lang] || assistant.TypeYourCommand.en; }
	get Welcome() { return assistant.Welcome[this.lang] || assistant.Welcome.en; }
	get JoinDiscord() { return assistant.JoinDiscord[this.lang] || assistant.JoinDiscord.en; }
	get SetupProcess() { return assistant.SetupProcess[this.lang] || assistant.SetupProcess.en; }
	get PleaseEnterNewPassword() { return assistant.PleaseEnterNewPassword[this.lang] || assistant.PleaseEnterNewPassword.en; }

	// EXPLORER
	get ConsensusNotRobustMessage() { return explorer.ConsensusNotRobustMessage[this.lang] || explorer.ConsensusNotRobustMessage.en; }
	get ChainOverviewTitle() { return explorer.ChainOverviewTitle[this.lang] || explorer.ChainOverviewTitle.en; }
	get CirculatingSupplyTitle() { return explorer.CirculatingSupplyTitle[this.lang] || explorer.CirculatingSupplyTitle.en; }
	get DistributionProgressTitle() { return explorer.DistributionProgressTitle[this.lang] || explorer.DistributionProgressTitle.en; }
	get TargetBlockTimeTitle() { return explorer.TargetBlockTimeTitle[this.lang] || explorer.TargetBlockTimeTitle.en; }
	get LastBlockTimeTitle() { return explorer.LastBlockTimeTitle[this.lang] || explorer.LastBlockTimeTitle.en; }
	get LowerIsStronger() { return explorer.LowerIsStronger[this.lang] || explorer.LowerIsStronger.en; }

	get CirculatingSupply() { return explorer.CirculatingSupply[this.lang] || explorer.CirculatingSupply.en; }
	get DistributionProgress() { return explorer.DistributionProgress[this.lang] || explorer.DistributionProgress.en; }
	get TargetBlockTime() { return explorer.TargetBlockTime[this.lang] || explorer.TargetBlockTime.en; }
	get LastBlockTime() { return explorer.LastBlockTime[this.lang] || explorer.LastBlockTime.en; }
	get LegitimaciesChart() { return explorer.LegitimaciesChart[this.lang] || explorer.LegitimaciesChart.en; }
	get LastBlocksTimeGap() { return explorer.LastBlocksTimeGap[this.lang] || explorer.LastBlocksTimeGap.en; }

	// WALLET

	// DASHBOARD
}