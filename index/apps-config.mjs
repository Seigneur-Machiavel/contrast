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

export const AppConfig = () => {
	return {
		preload: true,
		minWidth: undefined,
		minHeight: undefined,
		icon: '',
		title: '',
		content: '',
		mainClass: '',
		setGlobal: false
	}
}
export const appsConfig = {
	chat: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		icon: 'img/chat_128.png',
		title: 'CHAT',
		content: './apps/chat/content.html',
		mainClass: 'ChatUI',
		setGlobal: true
	},
	wallet: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		icon: 'img/wallet_128.png',
		title: 'WALLET',
		content: 'This is a notes app.'
	},
	node: {
		preload: false,
		icon: 'img/network_128.png',
		title: 'NODE',
		content: 'This is a node app.'
	}
};