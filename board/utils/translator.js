/** @typedef {'en' | 'fr'} Language */

// FIRST WE DEFINE THE TRANSLATION STRINGS FOR EACH LANGUAGE IN A STRUCTURED WAY,
// EACH OBJECT CORRESPOND TO ONE BOARD APP.
// NAMING CORRESPOND TO THE "data-translatorkey" ATTRIBUTE OF THE HTML ELEMENTS TO TRANSLATE.
/** @type {Record<string, Record<Language, { key: string, description: string }>>} */
const assistantCommands = {
	cancel: {
		en: { key: 'cancel', description: 'Cancel current interaction' },
		fr: { key: 'annuler', description: 'Annuler l\'interaction en cours' },
	},
	language: {
		en: { key: 'language', description: 'Change the language' },
		fr: { key: 'langue', description: 'Changer la langue' },
	},
	copy_logs: {
		en: { key: 'copy_logs', description: 'Copy logs history to clipboard' },
		fr: { key: 'copier_journaux', description: 'Copier l\'historique des journaux dans le presse-papiers' },
	},
	change_password: {
		en: { key: 'change_password', description: 'Change your password' },
		fr: { key: 'changer_mot_de_passe', description: 'Changer votre mot de passe' },
	},
	reveal_seed: {
		en: { key: 'reveal_seed', description: 'Reveal your private seed' },
		fr: { key: 'revealer_grain', description: 'Révéler votre graine privée' },
	},
	reset: {
		en: { key: 'reset', description: 'Delete your private key(seed) and/or all data' },
		fr: { key: 'reinitialiser', description: 'Supprimer votre clé privée (graine) et/ou toutes les données' },
	},

}
const assistant = {
	InteractionCancelled: {
		en: '*Interaction cancelled*',
		fr: '*Interaction annulée*',
	},
	TypeYourCommand: {
		en: 'Type your command:',
		fr: 'Tapez votre commande :',
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
		en: 'Progress',
		fr: 'Progression',
	},
	TargetBlockTimeTitle: {
		en: 'Target blockTime',
		fr: 'Temps de bloc cible',
	},
	LastBlockTimeTitle: {
		en: 'Last block',
		fr: 'Dernier bloc',
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
	Legitimacies: {
		en: 'Legitimacies',
		fr: 'Légitimités',
	},
	LegitimaciesTooltip: {
		en: 'Indicating the legitimacy of the candidate block prepared by validators this round',
		fr: 'Indiquant la légitimité du bloc candidat préparé par les validateurs ce tour',
	},
	LastBlocksTimeGap: {
		en: 'Last blocks time-gap',
		fr: 'Écart temporel des blocs',
	},
	LastBlocksTimeGapTooltip: {
		en: 'The time gap between the 60 last blocks; this helps to control the network\'s stability by displaying the block time deviation.',
		fr: 'L\'écart de temps entre les 60 derniers blocs ; cela aide à contrôler la stabilité du réseau en affichant la déviation du temps de bloc.',
	},
}

const wallet = {
		// SETTINGS
	AutoRefresh: {
		en: 'Auto-refresh',
		fr: 'Actualisation automatique',
	},
	EnableCommands: {
		en: 'Enable commands',
		fr: 'Activer les commandes',
	},
	EnableDataField: {
		en: 'Enable data field',
		fr: 'Activer le champ de données',
	},
	RoundTo2Decimals: {
		en: 'Round to 2 decimals',
		fr: 'Arrondir à 2 décimales',
	},
	// BALANCE AND MAIN BUTTONS
	Staked: {
		en: 'Staked:',
		fr: 'Verrouillé :',
	},
	Transfer: {
		en: 'Transfer',
		fr: 'Transférer',
	},
	Swap: {
		en: 'Swap',
		fr: 'Échanger',
	},
	History: {
		en: 'History',
		fr: 'Historique',
	},
	// SEND MINIFORM
	Send: {
		en: 'Send',
		fr: 'Envoyer',
	},
	Stake: {
		en: 'Stake',
		fr: 'Verrouiller',
	},
	Unstake: {
		en: 'Unstake',
		fr: 'Déverrouiller',
	},
	Inscribe: {
		en: 'Inscribe',
		fr: 'Inscrire',
	},
	Amount: {
		en: 'Amount:',
		fr: 'Montant :',
	},
	To: {
		en: 'To:',
		fr: 'À :',
	},
	Data: {
		en: 'Data:',
		fr: 'Données :',
	},
	Fee: {
		en: 'Fee:',
		fr: 'Frais :',
	},
	Total: {
		en: 'Total:',
		fr: 'Total :',
	},
	Confirm: {
		en: 'Confirm',
		fr: 'Confirmer',
	},
}

// THE TRANSLATOR CLASS IS USED TO MANAGE THE TRANSLATION OF THE BOARD
// IT PROVIDES A SET OF GETTERS FOR EACH TRANSLATABLE TEXT, AND A METHOD TO SET THE LANGUAGE AND UPDATE THE TEXT CONTENT OF THE BOARD ACCORDINGLY.
// IT ALSO DEFINES THE AVAILABLE LANGUAGES AND A CALLBACK FUNCTION THAT CAN BE CALLED WHEN THE LANGUAGE CHANGES.
export class Translator {
	onLanguageChange = null; // Callback function when language changes, receives new language as argument
	availableLanguages = ['en', 'fr'];
	/** @type {Language} */	lang;

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
			// console.log('translating key:', key, 'to:', text);
			if (!text) throw new Error(`No translation found for key "${key}" and language "${this.lang}"`);
			el.textContent = text;
		}

		console.log(`-- Language set to ${lang} --`);
	}

	// BOARD

	// ASSISTANT
	assistantCommand(cmdKey = 'language') {
		const cmd = assistantCommands[cmdKey];
		if (!cmd) throw new Error(`No command found for key "${cmdKey}"`);
		return cmd[this.lang] || cmd.en; // fallback to English if translation is missing
	}
	get InteractionCancelled() { return assistant.InteractionCancelled[this.lang] || assistant.InteractionCancelled.en; }
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
	get Legitimacies() { return explorer.Legitimacies[this.lang] || explorer.Legitimacies.en; }
	get LegitimaciesTooltip() { return explorer.LegitimaciesTooltip[this.lang] || explorer.LegitimaciesTooltip.en; }
	get LastBlocksTimeGap() { return explorer.LastBlocksTimeGap[this.lang] || explorer.LastBlocksTimeGap.en; }
	get LastBlocksTimeGapTooltip() { return explorer.LastBlocksTimeGapTooltip[this.lang] || explorer.LastBlocksTimeGapTooltip.en; }

	// WALLET
	get AutoRefresh() { return wallet.AutoRefresh[this.lang] || wallet.AutoRefresh.en; }
	get EnableCommands() { return wallet.EnableCommands[this.lang] || wallet.EnableCommands.en; }
	get EnableDataField() { return wallet.EnableDataField[this.lang] || wallet.EnableDataField.en; }
	get RoundTo2Decimals() { return wallet.RoundTo2Decimals[this.lang] || wallet.RoundTo2Decimals.en; }
	get Staked() { return wallet.Staked[this.lang] || wallet.Staked.en; }
	get Transfer() { return wallet.Transfer[this.lang] || wallet.Transfer.en; }
	get Swap() { return wallet.Swap[this.lang] || wallet.Swap.en; }
	get History() { return wallet.History[this.lang] || wallet.History.en; }
	get Send() { return wallet.Send[this.lang] || wallet.Send.en; }
	get Stake() { return wallet.Stake[this.lang] || wallet.Stake.en; }
	get Unstake() { return wallet.Unstake[this.lang] || wallet.Unstake.en; }
	get Inscribe() { return wallet.Inscribe[this.lang] || wallet.Inscribe.en; }
	get Amount() { return wallet.Amount[this.lang] || wallet.Amount.en; }
	get To() { return wallet.To[this.lang] || wallet.To.en; }
	get Data() { return wallet.Data[this.lang] || wallet.Data.en; }
	get Fee() { return wallet.Fee[this.lang] || wallet.Fee.en; }
	get Total() { return wallet.Total[this.lang] || wallet.Total.en; }
	get Confirm() { return wallet.Confirm[this.lang] || wallet.Confirm.en; }

	// DASHBOARD
}