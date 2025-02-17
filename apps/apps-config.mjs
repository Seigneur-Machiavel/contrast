/**
 * @typedef {Object} AppConfig
 * @property {boolean} preload - default false
 * @property {boolean} disableOnLock - default true
 * @property {number} [minWidth]
 * @property {number} [minHeight]
 * @property {number} [initialWidth]
 * @property {number} [initialHeight]
 * @property {number} [initTop]
 * @property {number} [initLeft]
 * @property {string} icon
 * @property {string} [iconWidth] - default '50%'
 * @property {string} title
 * @property {string} content - HTML content (not full html document)
 * @property {string} [mainClass]
 * @property {boolean} [setGlobal] - Set the app as global (window)
 * @property {boolean} [fullScreen] - default false
 * @property {boolean} [setFront] - default false
 */

export const AppConfig = (appName, appConfig) => {
	return {
		preload: appConfig.preload || false,
		disableOnLock: appConfig.disableOnLock === false ? false : true,
		minWidth: appConfig.minWidth || undefined,
		minHeight: appConfig.minHeight || undefined,
		initialWidth: appConfig.initialWidth || undefined,
		initialHeight: appConfig.initialHeight || undefined,
		initTop: appConfig.initTop || undefined,
		initLeft: appConfig.initLeft || undefined,
		icon: appConfig.icon || `../../apps/${appName}/img/icon_128.png`,
		iconWidth: appConfig.iconWidth || '50%',
		title: appConfig.title || 'App_Title',
		content: appConfig.content || 'This is a default app.',
		mainClass: appConfig.mainClass || undefined,
		setGlobal: appConfig.setGlobal || false,
		fullScreen: appConfig.fullScreen || false,
		setFront: appConfig.setFront || false
	}
}
export const appsConfig = {
	assistant: {
		preload: true,
		disableOnLock: false,
		minWidth: 500,
		minHeight: 300,
		initialWidth: 700,
		iconWidth: '60%',
		title: '❖ ASSISTANT ` ` \\_',
		content: '../../apps/assistant/assistant-content.html',
		fullScreen: false,
		setFront: true
	},
	/*wallet: {
		preload: false,
		disableOnLock: true,
		minWidth: 322,
		minHeight: 402,
		title: '- )( - WALLET ___\\',
		content: '../../apps/wallet/wallet-content.html',
	},*/
	/*chat: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		title: 'CHAT',
		content: '../../apps/chat/chat-content.html',
		mainClass: 'ChatUI',
		setGlobal: true
	},*/
	/*vault: {
		preload: true,
		minWidth: 600,
		minHeight: 600,
		iconWidth: '68%',
		title: 'VAULT',
		content: '../../apps/vault/vault-content.html',
	},*/
	dashboard: {
		preload: false,
		disableOnLock: true,
		minWidth: 420,
		minHeight: 300,
		initialHeight: 572,
		initTop: 0,
		iconWidth: '69%',
		title: '~~ DASHBOARD ___\\',
		content: '<iframe src="http://localhost:27271" style="width: 100%; height: 100%; border: none;"></iframe>'
	},
	explorer: {
		preload: false,
		fullScreen: false,
		minWidth: 860,
		minHeight: 190,
		initialWidth: 860,
		initialHeight: 610,
		initTop: 0,
		initLeft: 430,
		iconWidth: '69%',
		title: '°`° BLOCKCHAIN EXPLORER - }== -',
		content: '<iframe src="http://localhost:27270" style="width: 100%; height: 100%; border: none;"></iframe>'
	},
};