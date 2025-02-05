/**
 * @typedef {Object} AppConfig
 * @property {boolean} preload
 * @property {number} [minWidth]
 * @property {number} [minHeight]
 * @property {number} [initialWidth]
 * @property {number} [initialHeight]
 * @property {number} [initTop]
 * @property {string} icon
 * @property {string} title
 * @property {string} content // HTML content (not full html document)
 * @property {string} [mainClass]
 * @property {boolean} setGlobal // Set the app as global (window)
 */

export const AppConfig = (appName, appConfig) => {
	return {
		preload: appConfig.preload || false,
		minWidth: appConfig.minWidth || undefined,
		minHeight: appConfig.minHeight || undefined,
		initialWidth: appConfig.initialWidth || undefined,
		initialHeight: appConfig.initialHeight || undefined,
		initTop: appConfig.initTop || undefined,
		icon: appConfig.icon || `../../apps/${appName}/img/icon_128.png`,
		iconWidth: appConfig.iconWidth || '50%',
		title: appConfig.title || 'App_Title',
		content: appConfig.content || 'This is a default app.',
		mainClass: appConfig.mainClass || undefined,
		setGlobal: appConfig.setGlobal || false
	}
}
export const appsConfig = {
	/*chat: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		title: 'CHAT',
		content: '../../apps/chat/chat-content.html',
		mainClass: 'ChatUI',
		setGlobal: true
	},*/
	wallet: {
		preload: false,
		title: 'WALLET',
		content: '../../wallet-plugin/popup.html',
	},
	/*vault: {
		preload: true,
		minWidth: 600,
		minHeight: 600,
		iconWidth: '68%',
		title: 'VAULT',
		content: '../../apps/vault/vault-content.html',
	},*/
	dashboard: {
		preload: true,
		minWidth: 350,
		minHeight: 300,
		initialHeight: 572,
		initTop: 195,
		iconWidth: '69%',
		title: 'DASHBOARD',
		content: '<iframe src="http://localhost:27271" style="width: 100%; height: 100%; border: none;"></iframe>',
	},
	explorer: {
		preload: true,
		minWidth: 860,
		minHeight: 192,
		initialWidth: 800,
		iconWidth: '69%',
		title: 'BLOCKCHAIN EXPLORER',
		content: '<iframe src="http://pinkparrot.science:27270" style="width: 100%; height: 100%; border: none;"></iframe>',
	},
};