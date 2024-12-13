/**
 * @typedef {Object} AppConfig
 * @property {boolean} preload
 * @property {number} minWidth
 * @property {number} minHeight
 * @property {string} icon
 * @property {string} title
 * @property {string} content // HTML content (not full html document)
 */

export const AppConfig = () => {
	return {
		preload: true,
		minWidth: 300,
		minHeight: 300,
		icon: '',
		title: '',
		content: ''
	}
}
export const appsConfig = {
	chat: {
		preload: true,
		minWidth: 300,
		minHeight: 300,
		icon: 'img/chat_128.png',
		title: 'Chat',
		content: 'toto' //'./apps/chat/content.html'
	},
	wallet: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		icon: 'img/wallet_128.png',
		title: 'Wallet',
		content: 'This is a notes app.'
	},
	node: {
		preload: false,
		minWidth: 300,
		minHeight: 300,
		icon: 'img/network_128.png',
		title: 'Node',
		content: 'This is a node app.'
	}
};