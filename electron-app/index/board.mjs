if (false) { // For better completion
	const anime = require('animejs');
	const ChatUI = require('../../apps/chat/front-scripts/chat-renderer.js');
}

import { AppConfig, appsConfig } from '../../apps/apps-config.mjs';
const appsMainClasses = { 'ChatUI': ChatUI }

/** @param {string} tag @param {string[]} classes @param {string} innerHTML @param {HTMLElement} [parent] */
function newElement(tag, classes, innerHTML, parent) {
	const element = document.createElement(tag);
	element.classList.add(...classes);

	if (innerHTML.includes('.html')) {
		fetch(innerHTML).then(res => res.text()).then(html => { element.innerHTML = html; });
	} else {
		element.innerHTML = innerHTML;
	}
	if (parent) parent.appendChild(element);
	return element;
}

class ButtonsBar {
	constructor(element = document.getElementById('bottom-buttons-bar')) {
		/** @type {HTMLElement} */
		this.element = element;
		this.buttons = [];
		this.buttonsByAppNames = {};
	}

	addButton(appName, app) {
		const button = newElement('button', ['app-button'], '', this.element);
		button.dataset.appName = appName;

		const img = newElement('img', [], '', button);
		img.src = app.icon;
		img.style.width = app.iconWidth;

		this.buttons.push(button);
		this.buttonsByAppNames[appName] = button;
	}
	getButtonOrigin(buttonKey) {
		const result = { x: 0, y: 0 };
		/** @type {HTMLElement} */
		const button = this.buttonsByAppNames[buttonKey];
		if (!button) return result;
		
		const rect = button.getBoundingClientRect();
		result.x = rect.x + rect.width / 2;
		result.y = rect.y + rect.height / 2;
		return result;
	}
}
class SubWindow {
	constructor(appName, title, content) {
		this.appName = appName;
		this.mainInstance = null;

		/** @type {HTMLElement} */
		this.element;
		this.title = title;
		this.content = content;
		this.contentElement;

		this.dragStart = { x: 0, y: 0 };
		this.position = { left: 0, top: 0 };
		this.minSize = { width: 0, height: 0 };
		this.windowSize = { width: 0, height: 0 };
		this.folded = true;
		this.animation = null;
		this.animationsComplexity = 1; // 0: none, 1: simple, 2: complex
	}

	render(parentElement = document.body, fromX= 0, fromY= 0) {
		this.element = newElement('div', ['window', 'resizable'], '', parentElement);
		this.element.dataset.appName = this.appName;
		this.element.appendChild(this.#newTitleBar(this.title));
		this.contentElement = newElement('div', ['content'], this.content, this.element);
		this.element.style.minWidth = this.minSize.width + 'px';
		this.element.style.minHeight = this.minSize.height + 'px';
		this.element.style.maxWidth = window.innerWidth + 'px';
		this.element.style.maxHeight = window.innerHeight + 'px';
		
		if (fromX && fromY) {
			this.element.style.opacity = 1;
			this.element.style.transform = 'scale(1)';
			this.element.style.top = document.body.offsetHeight + 1000 + 'px';

			anime({
				targets: this.element,
				opacity: 0,
				scale: .1,
				duration: 100,
				delay: 100,
				complete: () => {
					this.element.style.top = (fromX - this.element.offsetWidth / 2) + 'px';
					this.element.style.left = (fromY - this.element.offsetHeight) + 'px';
				}
			});
		}
	}
	#newTitleBar(title) {
		const titleBar = newElement('div', ['title-bar'], '');
		newElement('div', ['background'], '', titleBar);
		newElement('span', [], title, titleBar);

		const buttonsWrap = newElement('div', ['buttons-wrap'], '', titleBar);
		
		const foldButton = newElement('img', ['fold-button'], '', buttonsWrap);
		foldButton.dataset.appName = this.appName;
		foldButton.dataset.action = 'fold';
		foldButton.src = '../img/fold_64.png';

		const expandButton = newElement('img', ['expand-button'], '', buttonsWrap);
		expandButton.dataset.appName = this.appName;
		expandButton.dataset.action = 'expand';
		expandButton.src = '../img/expand_64.png';

		return titleBar;
	}
	toggleFold(originX, originY, duration = 400) {
		this.folded = !this.folded;
		if (this.folded) { this.element.classList.remove('onBoard'); }

		// COMBINED ANIMATION
		if (this.animation) { this.animation.pause(); }

		const toPosition = { left: originX - this.element.offsetWidth / 2, top: originY - this.element.offsetHeight };
		if (!this.folded) { toPosition.left = this.position.left; toPosition.top = this.position.top };
		if (!this.folded && this.element.classList.contains('fullscreen')) { toPosition.left = 0; toPosition.top = 0; }

		this.animation = anime({
			targets: this.element,
			opacity: this.animationsComplexity < 1 ? null : {
				value: this.folded ? 0 : 1,
				duration: duration * .3,
				delay: this.folded ? duration * .5 : 0,
				easing: 'easeOutQuad'
			},
			scale: { value: this.folded ? .1 : 1, duration: duration, easing: 'easeOutQuad' },
			left: { value: toPosition.left, duration: duration, easing: 'easeOutQuad' },
			top: { value: toPosition.top, duration: duration, easing: 'easeOutQuad' },
			complete: () => {
				if (!this.folded) { this.element.classList.add('onBoard'); }
			}
		});

		return this.folded;
	}
	setFullScreen(boardSize = { width: 0, height: 0 }, duration = 400) {
		if (this.element.classList.contains('fullscreen')) { return; }
		this.element.classList.add('fullscreen');

		const expandButton = this.element.querySelector('.expand-button');
		if (!expandButton) return;

		expandButton.dataset.action = 'detach';
		expandButton.src = '../img/detach_window_64.png';
		
		this.windowSize.width = this.element.offsetWidth;
		this.windowSize.height = this.element.offsetHeight;
		this.animation = anime({
			targets: this.element,
			width: boardSize.width + 'px',
			height: boardSize.height + 'px',
			top: '0px',
			left: '0px',
			duration,
			easing: 'easeOutQuad',
			complete: () => {
				this.element.style.width = '100%';
				this.element.style.height = 'calc(100% - var(--buttons-bar-height))';
			}
		});
	}
	unsetFullScreen(duration = 400) {
		if (!this.element.classList.contains('fullscreen')) { return; }
		this.element.classList.remove('fullscreen');

		const expandButton = this.element.querySelector('.expand-button');
		if (!expandButton) return;
		expandButton.dataset.action = 'expand';
		expandButton.src = '../img/expand_64.png';
		
		this.element.style.width = this.element.offsetWidth + 'px';
		this.element.style.height = this.element.offsetHeight + 'px';

		this.animation = anime({
			targets: this.element,
			width: this.windowSize.width + 'px',
			height: this.windowSize.height + 'px',
			top: this.position.top + 'px',
			left: this.position.left + 'px',
			duration,
			easing: 'easeOutQuad'
		});
	}
}
class AppsManager {
	/** @type {Object<string, SubWindow>} */
	windows = {};
	draggingWindow = null;
	resizingWindow = null;
	transitionsDuration = 400;
	constructor(windowsWrap, buttonsBarElement, appsConf) {
		this.windowsWrap = windowsWrap;
		this.buttonsBar = new ButtonsBar(buttonsBarElement);
		/** @type {Object<string, AppConfig>} */
		this.appsConfig = this.#buildAppsConfig(appsConf);
	}

	#buildAppsConfig(appsConf) {
		const result = {};
		for (const appName in appsConf) { result[appName] = AppConfig(appName, appsConf[appName]); }
		return result;
	}
	updateCssAnimationsDuration() {
		document.documentElement.style.setProperty('--windows-animation-duration', this.transitionsDuration + 'ms');
	}
	initApps() {
		this.buttonsBar.element.innerHTML = '';
		for (const app in this.appsConfig) { this.buttonsBar.addButton(app, this.appsConfig[app]); }
		for (const app in this.appsConfig) { if (this.appsConfig[app].preload) this.loadApp(app); }
	}
	loadApp(appName) {
		if (!this.appsConfig[appName]) return;

		const origin = this.buttonsBar.getButtonOrigin(appName);
		this.windows[appName] = new SubWindow(appName, this.appsConfig[appName].title, this.appsConfig[appName].content);
		this.windows[appName].minSize.width = this.appsConfig[appName].minWidth;
		this.windows[appName].minSize.height = this.appsConfig[appName].minHeight;
		this.windows[appName].render(this.windowsWrap, origin.x, origin.y);

		const appMainClassName = this.appsConfig[appName].mainClass;
		const appMainClass = appsMainClasses[appMainClassName];
		if (appMainClass) {
			setTimeout(() => { // wait for the element to be rendered
				const contentDiv = this.windows[appName].element.querySelector('.content');
				this.windows[appName].mainInstance = new appMainClass(contentDiv);
				if (!this.appsConfig[appName].setGlobal) { return; }
				// set the app as global (window)
				window[appMainClassName] = this.windows[appName].mainInstance;
			}, 40);
		}
	}
	toggleAppWindow(appName) {
		if (!this.appsConfig[appName]) return;
		if (!this.windows[appName]) { this.loadApp(appName); }
		
		const isFront = this.windows[appName].element.style.zIndex === '1';
		const unfoldButNotFront = isFront === false && this.windows[appName].folded === false;
		let appToFocus = appName;
		
		if (!unfoldButNotFront) {  // -> don't toggle after setting front
			const origin = this.buttonsBar.getButtonOrigin(appName);
			const folded = this.windows[appName].toggleFold(origin.x, origin.y, this.transitionsDuration);
			const firstUnfolded = Object.values(this.windows).find(w => w.folded === false);
			if (folded && firstUnfolded) { appToFocus = firstUnfolded.appName; }
		}

		console.log('appToFocus', appToFocus);
		const delay = appToFocus === appName ? 0 : this.transitionsDuration;
		setTimeout(() => { this.setFrontWindow(appToFocus); }, delay);
	}
	calculateBoardSize() {
		return { width: window.innerWidth, height: window.innerHeight - this.buttonsBar.element.offsetHeight };
	}
	setFrontWindow(appName) {
		if (!this.windows[appName]) return;
		if (!this.windows[appName].element) return;
		if (this.windows[appName].element.style.zIndex === '1') return;

		for (const app in this.windows) {
			this.windows[app].element.style.zIndex = 0;
			this.windows[app].element.classList.remove('front');
		}
		this.windows[appName].element.style.zIndex = 1;
		this.windows[appName].element.classList.add('front');
	}
	// HANDLERS
	clickAppButtonsHandler(e) {
		const button = e.target.closest('.app-button');
		if (!button) return;

		const appName = button.dataset.appName;
		const appInitialized = this.windows[appName];
		if (!appInitialized && !this.windows[appName]) {
			if (!this.appsConfig[appName]) { console.error('App not found:', appName); return; }
			this.loadApp(appName);
		}

		this.toggleAppWindow(appName);
	}
	clickWindowHandler(e) {
		switch(e.target.dataset.action) {
			case 'fold': this.toggleAppWindow(e.target.dataset.appName); return;
			case 'expand':
				this.windows[e.target.dataset.appName].setFullScreen(this.calculateBoardSize(), this.transitionsDuration);
				return;
			case 'detach':
				this.windows[e.target.dataset.appName].unsetFullScreen(this.transitionsDuration);
				return;
		}

		// if click in a window (anywhere), bring it to front
		// trough parents of the clicked element until find the window
		let target = e.target;
		while(target && target !== document.body) {
			if (target.classList.contains('window')) { break; }
			target = target.parentElement;
		}

		const subWindow = Object.values(this.windows).find(w => w.element.contains(target));
		if (!subWindow) return;

		const appName = subWindow.element.dataset.appName;
		this.setFrontWindow(appName);
	}
	dlbClickTitleBarHandler(e) {
		if (!e.target.classList.contains('title-bar')) return;

		const subWindow = Object.values(this.windows).find(w => w.element.contains(e.target));
		if (!subWindow) return;

		if (!subWindow.element.classList.contains('fullscreen')) {
			subWindow.setFullScreen(this.calculateBoardSize(), this.transitionsDuration);
		} else {
			subWindow.unsetFullScreen(this.transitionsDuration);
		}
	}
	grabWindowHandler(e) {
		const subWindow = Object.values(this.windows).find(w => w.element.contains(e.target));
		if (!subWindow) return;
		if (subWindow.element.classList.contains('fullscreen')) { return; }

		const appName = subWindow.element.dataset.appName;
		this.setFrontWindow(appName);

		const isThe20per20RightBottomCorner = e.clientX > subWindow.element.offsetWidth - 20 && e.clientY > subWindow.element.offsetHeight - 20;
		if (isThe20per20RightBottomCorner) { 
			subWindow.element.style.pointerEvents = 'none';
			this.resizingWindow = subWindow;
			return;
		}

		if (!e.target.classList.contains('title-bar')) return;

		this.draggingWindow = subWindow;
		subWindow.dragStart.x = e.clientX - subWindow.element.offsetLeft;
		subWindow.dragStart.y = e.clientY - subWindow.element.offsetTop;
		subWindow.element.classList.add('dragging');
	}
	moveWindowHandler(e) {
		const subWindow = this.draggingWindow;
		if (!subWindow) return;

		subWindow.element.style.left = e.clientX - subWindow.dragStart.x + 'px';
		subWindow.element.style.top = e.clientY - subWindow.dragStart.y + 'px';
	}
	releaseWindowHandler(e) {
		if (this.resizingWindow) {
			this.resizingWindow.element.style.pointerEvents = 'auto';
			this.resizingWindow = null;
			return;
		}
		
		if (this.draggingWindow) {
			this.draggingWindow.position.left = e.clientX - this.draggingWindow.dragStart.x;
			this.draggingWindow.position.top = e.clientY - this.draggingWindow.dragStart.y;
			this.draggingWindow.element.classList.remove('dragging');
			this.draggingWindow = null;
		}
	}
}

const appsManager = new AppsManager(
	document.getElementById('board-windows-wrap'),
	document.getElementById('board-bottom-buttons-bar'),
	appsConfig
);
appsManager.initApps();
window.appsManager = appsManager;

// better implementation with less event listeners
document.addEventListener('click', (e) => { appsManager.clickAppButtonsHandler(e); appsManager.clickWindowHandler(e); });
document.addEventListener('dblclick', (e) => { if (e.target.classList.contains('title-bar')) appsManager.dlbClickTitleBarHandler(e); });
document.addEventListener('mousedown', (e) => { appsManager.grabWindowHandler(e); });
document.addEventListener('mousemove', (e) => { appsManager.moveWindowHandler(e); });
document.addEventListener('mouseup', (e) => { appsManager.releaseWindowHandler(e); });
document.addEventListener('change', (event) => {
	switch(event.target.id) {
		case 'dark-mode-toggle':
    		document.body.classList.toggle('dark-mode');
			break;
	}
});
window.addEventListener('resize', function() {
	for (const app in appsManager.windows) {
		appsManager.windows[app].element.style.maxWidth = window.innerWidth + 'px';
		appsManager.windows[app].element.style.maxHeight = window.innerHeight + 'px';
	}
});

await new Promise(resolve => setTimeout(resolve, 400));
//appsManager.windows.node.toggleFold();
appsManager.toggleAppWindow('node');