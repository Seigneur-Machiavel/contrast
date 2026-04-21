/** @typedef {'en' | 'fr' | 'it' | 'es'  | 'pt' | 'de' | 'cs' | 'ko' | 'ja' | 'zh-s' | 'zh-t'} Language */

// FIRST WE DEFINE THE TRANSLATION STRINGS FOR EACH LANGUAGE IN A STRUCTURED WAY,
// EACH OBJECT CORRESPOND TO ONE BOARD APP.
// NAMING CORRESPOND TO THE "data-translatorkey" ATTRIBUTE OF THE HTML ELEMENTS TO TRANSLATE.
/** @type {Record<string, Record<Language, { key: string, description: string }>>} */
const assistantCommands_DEPRECATED = {
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
		fr: { key: 'reveler_graine', description: 'Révéler votre graine privée' },
	},
	reset: {
		en: { key: 'reset', description: 'Delete your private key(seed) and/or all data' },
		fr: { key: 'reinitialiser', description: 'Supprimer votre clé privée (graine) et/ou toutes les données' },
	},

}
const assistant_DEPRECATED = {
	UserResponseHidden: {
		en: 'User response (hidden)',
		fr: 'Réponse de l\'utilisateur (cachée)',
	},
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
	PleaseEnterPasswordToUnlock: {
		en: 'Please enter your password to unlock:',
		fr: 'Veuillez entrer votre mot de passe pour déverrouiller :',
	},
	PleaseEnterPasswordToExtract: {
		en: 'Please enter your password to extract your seed:',
		fr: 'Veuillez entrer votre mot de passe pour extraire votre graine :',
	},
	WrongPasswordTryAgain: {
		en: 'Wrong password, try again',
		fr: 'Mot de passe incorrect, réessayez',
	},
	NoWalletFoundCannotRevealSeed: {
		en: 'No wallet found, cannot reveal seed.',
		fr: 'Aucun portefeuille trouvé, impossible de révéler la graine.',
	},
	YourPasswordPlaceholder: {
		en: 'Your password...',
		fr: 'Votre mot de passe...',
	},
	YourNewPasswordPlaceholder: {
		en: 'Your new password...',
		fr: 'Votre nouveau mot de passe...',
	},
	ConfirmYourPassword: {
		en: 'Confirm your password:',
		fr: 'Confirmez votre mot de passe :',
	},
	ConfirmYourPasswordPlaceholder: {
		en: 'Confirm your password...',
		fr: 'Confirmez votre mot de passe...',
	},
	MustBeBetween4And30Characters: {
		en: 'Must be between 4 and 30 characters.',
		fr: 'Doit être compris entre 4 et 30 caractères.',
	},
	InvalidPasswordInput: {
		en: 'Invalid password input.',
		fr: 'Entrée de mot de passe invalide.',
	},
	PasswordsDoNotMatch: {
		en: 'Passwords do not match.',
		fr: 'Les mots de passe ne correspondent pas.',
	},
	WalletUnlocked: {
		en: 'Wallet unlocked successfully!',
		fr: 'Portefeuille déverrouillé avec succès !',
	},
	SelectWhatYouWantToResetCarefully: {
		en: 'Select what you want to reset carefully, this action cannot be undone!',
		fr: 'Sélectionnez soigneusement ce que vous souhaitez réinitialiser, cette action est irréversible !',
	},
	AreYouSureYouWantToDeleteUserPreferences: {
		en: 'Are you sure you want to delete user preferences?',
		fr: 'Êtes-vous sûr de vouloir supprimer les préférences utilisateur ?',
	},
	DeletedUserPreferencesSuccessfully: {
		en: 'User preferences deleted successfully.',
		fr: 'Préférences utilisateur supprimées avec succès.',
	},
	AreYouSureYouWantToDeleteWallet: {
		en: 'Are you sure you want to delete your wallet? This will make you lose access to your wallet if you do not have it backed up!',
		fr: 'Êtes-vous sûr de vouloir supprimer votre portefeuille ? Cela vous fera perdre l\'accès à votre portefeuille si vous ne l\'avez pas sauvegardé !',
	},
	WalletDeletedSuccessfully: {
		en: 'Wallet deleted successfully.',
		fr: 'Portefeuille supprimé avec succès.',
	},
	AreYouSureYouWantToDeleteAllData: {
		en: 'Are you sure you want to delete all data? This will reset everything and make you lose access to your wallet if you do not have it backed up!',
		fr: 'Êtes-vous sûr de vouloir supprimer toutes les données ? Cela réinitialisera tout et vous fera perdre l\'accès à votre portefeuille si vous ne l\'avez pas sauvegardé !',
	},
	AllDataDeletedSuccessfully: {
		en: 'All data deleted successfully.',
		fr: 'Toutes les données ont été supprimées avec succès.',
	},

	// CHOICES
	YesChoice: {
		en: 'Yes',
		fr: 'Oui',
	},
	NoChoice: {
		en: 'No',
		fr: 'Non',
	},
	CancelChoice: {
		en: 'Cancel',
		fr: 'Annuler',
	},
	DeleteUserPreferencesChoice: {
		en: 'Delete user preferences',
		fr: 'Supprimer les préférences utilisateur',
	},
	DeleteWalletChoice: {
		en: 'Delete wallet',
		fr: 'Supprimer le portefeuille',
	},
	DeleteAllDataChoice: {
		en: 'Delete all data',
		fr: 'Supprimer toutes les données',
	},
	SelectSeedFormatChoice: {
		en: 'Select seed format',
		fr: 'Sélectionnez le format de la graine',
	},
	HexadecimalChoice: {
		en: 'Hexadecimal',
		fr: 'Hexadécimal',
	},
	WordListChoice: {
		en: 'Word list',
		fr: 'Liste de mots',
	},
}
const explorer_DEPRECATED = {
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
const wallet_DEPRECATED = {
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
// THESE TRANSLATIONS ARE MOVED TO translations.js
// TODO: erase 'DEPRECATED' when everything is migrated and tested.

import { assistantCommands, assistant, explorer, wallet } from './translations.js';

function getBip39CorrespondingLanguage(lang) {
	switch (lang) {
		case 'en': return 'english';
		case 'fr': return 'french';
		case 'it': return 'italian';
		case 'es': return 'spanish';
		case 'pt': return 'portuguese';
		case 'cs': return 'czech';
		case 'ko': return 'korean';
		case 'ja': return 'japanese';
		case 'zh-s': return 'chinese_simplified';
		case 'zh-t': return 'chinese_traditional';
		default: return 'english';
	}
}
// THE TRANSLATOR CLASS IS USED TO MANAGE THE TRANSLATION OF THE BOARD
// IT PROVIDES A SET OF GETTERS FOR EACH TRANSLATABLE TEXT, AND A METHOD TO SET THE LANGUAGE AND UPDATE THE TEXT CONTENT OF THE BOARD ACCORDINGLY.
// IT ALSO DEFINES THE AVAILABLE LANGUAGES AND A CALLBACK FUNCTION THAT CAN BE CALLED WHEN THE LANGUAGE CHANGES.
export class Translator {
	onLanguageChange = null; // Callback function when language changes, receives new language as argument
	availableLanguages = ['en', 'fr', 'it', 'es', 'pt', 'de', 'cs', 'ko', 'ja', 'zh-s', 'zh-t']; // List of available languages
	/** @type {Language} */	lang;

	/** @param {function(Language, boolean):void} onLanguageChange */
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
	get bip39Language() { return getBip39CorrespondingLanguage(this.lang); }
	assistantCommand(cmdKey = 'language') {
		const cmd = assistantCommands[cmdKey];
		if (!cmd) throw new Error(`No command found for key "${cmdKey}"`);
		return cmd[this.lang] || cmd.en; // fallback to English if translation is missing
	}
	get UserResponseHidden() { return assistant.UserResponseHidden[this.lang] || assistant.UserResponseHidden.en; }
	get InteractionCancelled() { return assistant.InteractionCancelled[this.lang] || assistant.InteractionCancelled.en; }
	get TypeYourCommand() { return assistant.TypeYourCommand[this.lang] || assistant.TypeYourCommand.en; }
	get Welcome() { return assistant.Welcome[this.lang] || assistant.Welcome.en; }
	get JoinDiscord() { return assistant.JoinDiscord[this.lang] || assistant.JoinDiscord.en; }
	get SetupProcess() { return assistant.SetupProcess[this.lang] || assistant.SetupProcess.en; }
	get PleaseEnterNewPassword() { return assistant.PleaseEnterNewPassword[this.lang] || assistant.PleaseEnterNewPassword.en; }
	get PleaseEnterPasswordToUnlock() { return assistant.PleaseEnterPasswordToUnlock[this.lang] || assistant.PleaseEnterPasswordToUnlock.en; }
	get PleaseEnterPasswordToExtract() { return assistant.PleaseEnterPasswordToExtract[this.lang] || assistant.PleaseEnterPasswordToExtract.en; }
	get WrongPasswordTryAgain() { return assistant.WrongPasswordTryAgain[this.lang] || assistant.WrongPasswordTryAgain.en; }
	get NoWalletFoundCannotRevealSeed() { return assistant.NoWalletFoundCannotRevealSeed[this.lang] || assistant.NoWalletFoundCannotRevealSeed.en; }
	get YourPasswordPlaceholder() { return assistant.YourPasswordPlaceholder[this.lang] || assistant.YourPasswordPlaceholder.en; }
	get YourNewPasswordPlaceholder() { return assistant.YourNewPasswordPlaceholder[this.lang] || assistant.YourNewPasswordPlaceholder.en; }
	get ConfirmYourPassword() { return assistant.ConfirmYourPassword[this.lang] || assistant.ConfirmYourPassword.en; }
	get ConfirmYourPasswordPlaceholder() { return assistant.ConfirmYourPasswordPlaceholder[this.lang] || assistant.ConfirmYourPasswordPlaceholder.en; }
	get MustBeBetween4And30Characters() { return assistant.MustBeBetween4And30Characters[this.lang] || assistant.MustBeBetween4And30Characters.en; }
	get InvalidPasswordInput() { return assistant.InvalidPasswordInput[this.lang] || assistant.InvalidPasswordInput.en; }
	get PasswordsDoNotMatch() { return assistant.PasswordsDoNotMatch[this.lang] || assistant.PasswordsDoNotMatch.en; }
	get WalletUnlocked() { return assistant.WalletUnlocked[this.lang] || assistant.WalletUnlocked.en; }
	get SelectWhatYouWantToResetCarefully() { return assistant.SelectWhatYouWantToResetCarefully[this.lang] || assistant.SelectWhatYouWantToResetCarefully.en; }
	get AreYouSureYouWantToDeleteUserPreferences() { return assistant.AreYouSureYouWantToDeleteUserPreferences[this.lang] || assistant.AreYouSureYouWantToDeleteUserPreferences.en; }
	get DeletedUserPreferencesSuccessfully() { return assistant.DeletedUserPreferencesSuccessfully[this.lang] || assistant.DeletedUserPreferencesSuccessfully.en; }
	get AreYouSureYouWantToDeleteWallet() { return assistant.AreYouSureYouWantToDeleteWallet[this.lang] || assistant.AreYouSureYouWantToDeleteWallet.en; }
	get WalletDeletedSuccessfully() { return assistant.WalletDeletedSuccessfully[this.lang] || assistant.WalletDeletedSuccessfully.en; }
	get AreYouSureYouWantToDeleteAllData() { return assistant.AreYouSureYouWantToDeleteAllData[this.lang] || assistant.AreYouSureYouWantToDeleteAllData.en; }
	get AllDataDeletedSuccessfully() { return assistant.AllDataDeletedSuccessfully[this.lang] || assistant.AllDataDeletedSuccessfully.en; }
	// ASSISTANT CHOICES
	get YesChoice() { return assistant.YesChoice[this.lang] || assistant.YesChoice.en; }
	get NoChoice() { return assistant.NoChoice[this.lang] || assistant.NoChoice.en; }
	get CancelChoice() { return assistant.CancelChoice[this.lang] || assistant.CancelChoice.en; }
	get DeleteUserPreferencesChoice() { return assistant.DeleteUserPreferencesChoice[this.lang] || assistant.DeleteUserPreferencesChoice.en; }
	get DeleteWalletChoice() { return assistant.DeleteWalletChoice[this.lang] || assistant.DeleteWalletChoice.en; }
	get DeleteAllDataChoice() { return assistant.DeleteAllDataChoice[this.lang] || assistant.DeleteAllDataChoice.en; }
	get SelectSeedFormatChoice() { return assistant.SelectSeedFormatChoice[this.lang] || assistant.SelectSeedFormatChoice.en; }
	get HexadecimalChoice() { return assistant.HexadecimalChoice[this.lang] || assistant.HexadecimalChoice.en; }
	get WordListChoice() { return assistant.WordListChoice[this.lang] || assistant.WordListChoice.en; }

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