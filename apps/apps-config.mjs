/**
 * @typedef {Object} AppConfig
 * @property {boolean} preload
 * @property {number} minWidth
 * @property {number} minHeight
 * @property {string} icon
 * @property {string} title
 * @property {string} content // HTML content (not full html document)
 * @property {string} mainClass
 * @property {boolean} setGlobal // Set the app as global (window)
 */

export const AppConfig = (appName, appConfig) => {
	return {
		preload: appConfig.preload || false,
		minWidth: appConfig.minWidth || undefined,
		minHeight: appConfig.minHeight || undefined,
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
	},
	wallet: {
		preload: false,
		title: 'WALLET',
		content: 'This is a notes app.'
	},*/
	/*vault: {
		preload: true,
		minWidth: 600,
		minHeight: 600,
		iconWidth: '68%',
		title: 'VAULT',
		content: '../../apps/vault/vault-content.html',
	},*/
	node: {
		preload: true,
		minWidth: 800,
		minHeight: 600,
		iconWidth: '56%',
		title: 'NODE',
		content: '<iframe src="http://localhost:27271" style="width: 100%; height: 100%; border: none;"></iframe>',
	}
};