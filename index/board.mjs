if (false) { // Just for better completion
	const anime = require('animejs');
}
import { AppConfig, appsConfig } from './apps-config.mjs';

console.log('index-scripts/index.mjs loaded');


/** @param {string} tag @param {string[]} classes @param {string} content @param {HTMLElement} [parent] */
function newElement(tag, classes, content, parent) {
	const element = document.createElement(tag);
	element.classList.add(...classes);

	const contentIsHtmlPath = content.includes('.html');
	if (contentIsHtmlPath) {
		fetch(content).then(res => res.text()).then(html => {
			element.innerHTML = html;
		});
	} else {
		element.innerHTML = content;
	}
	if (parent) parent.appendChild(element);
	return element;
}

class ButtonsBar {
	constructor(element = document.getElementById('bottom-buttons-bar')) {
		/** @type {HTMLElement} */
		this.element = element;
		this.buttons = [];
	}

	addButton(key, app) {
		const button = newElement('button', ['app-button'], '', this.element);
		button.dataset.key = key;
		newElement('img', [], '', button).src = app.icon;
		this.buttons.push(button);
	}
	getButtonOrigin(buttonKey) {
		const result = { x: 0, y: 0 };
		/** @type {HTMLElement} */
		const button = this.buttons.find(b => b.dataset.key === buttonKey);
		if (!button) return result;
		
		const rect = button.getBoundingClientRect();
		result.x = rect.x + rect.width / 2;
		result.y = rect.y + rect.height / 2;
		return result;
	}
}
class SubWindow {
	constructor(key, title, content) {
		this.key = key;
		/** @type {HTMLElement} */
		this.element;
		this.title = title;
		this.content = content;

		this.isDragging = false;

		this.dragStart = { x: 0, y: 0 };
		this.position = { left: 0, top: 0 };
		this.folded = true;
		this.animation = null;
	}

	render(parentElement = document.body, fromX= 0, fromY= 0) {
		this.element = newElement('div', ['window'], '', parentElement);
		this.element.dataset.key = this.key;
		newElement('div', ['title-bar'], this.title, this.element);
		newElement('div', ['content'], this.content, this.element);
		
		if (fromX && fromY) {
			this.element.style.transform = 'scale(.1)';
			this.element.style.left = (fromX - this.element.offsetWidth / 2) + 'px';
			this.element.style.top = (fromY - this.element.offsetHeight) + 'px';
			this.element.style.opacity = 0;
		}
	}

	toggleFold(originX, originY, duration = 400) {
		this.folded = !this.folded;
		if (this.folded) { this.element.classList.remove('onBoard'); }

		// COMBINED ANIMATION
		if (this.animation) { this.animation.pause(); }
		this.animation = anime({
			targets: this.element,
			opacity: {
				value: this.folded ? 0 : 1,
				duration: duration * .1,
				delay: this.folded ? duration * .8 : 0,
				easing: 'easeOutQuad'
			},
			scale: { value: this.folded ? .1 : 1, duration: duration, easing: 'easeOutQuad' },
			left: {
				value: !this.folded ? this.position.left : (originX - this.element.offsetWidth / 2),
				duration: duration, easing: 'easeOutQuad',
			},
			top: {
				value: !this.folded ? this.position.top : (originY - this.element.offsetHeight),
				duration: duration, easing: 'easeOutQuad'
			},
			complete: () => {
				if (!this.folded) { this.element.classList.add('onBoard'); }
			}
		});

		return this.folded;
	}
}
class AppsManager {
	constructor(windowsWrap, buttonsBarElement, appsConf) {
		this.windowsWrap = windowsWrap;
		this.buttonsBar = new ButtonsBar(buttonsBarElement);
		/** @type {Object<string, AppConfig>} */
		this.appsConfig = appsConf;
		/** @type {Object<string, SubWindow>} */
		this.windows = {};
	}

	initApps() {
		this.buttonsBar.element.innerHTML = '';
		for (const app in this.appsConfig) { this.buttonsBar.addButton(app, this.appsConfig[app]); }

		for (const app in this.appsConfig) {
			if (!this.appsConfig[app].preload) { continue; }
			this.loadApp(app);
		}
	}
	loadApp(appName) {
		if (!this.appsConfig[appName]) return;

		const origin = this.buttonsBar.getButtonOrigin(appName);
		this.windows[appName] = new SubWindow(appName, this.appsConfig[appName].title, this.appsConfig[appName].content);
		this.windows[appName].render(this.windowsWrap, origin.x, origin.y);

		if (this.appsConfig[appName].minWidth) {
			this.windows[appName].element.style.minWidth = this.appsConfig[appName].minWidth + 'px';
		}
		if (this.appsConfig[appName].minHeight) {
			this.windows[appName].element.style.minHeight = this.appsConfig[appName].minHeight + 'px';
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
			const folded = this.windows[appName].toggleFold(origin.x, origin.y, 400);
			const firstUnfolded = Object.values(this.windows).find(w => w.folded === false);
			if (folded && firstUnfolded) {
				//await new Promise(resolve => setTimeout(resolve, 400));
				console.log('firstUnfolded', firstUnfolded);
				appToFocus = firstUnfolded.key;
			}
		}
		console.log('appToFocus', appToFocus);
		this.setFrontWindow(appToFocus);
	}
	setFrontWindow(appName) {
		if (!this.windows[appName]) return;
		if (!this.windows[appName].element) return;
		if (this.windows[appName].element.style.zIndex === '1') return;

		console.log('setFrontWindow', appName);
		for (const app in this.windows) {
			this.windows[app].element.style.zIndex = 0;
			this.windows[app].element.classList.remove('front');
		}
		this.windows[appName].element.style.zIndex = 1;
		this.windows[appName].element.classList.add('front');
	}

	grabClickHandler(e) {
		const button = e.target.closest('.app-button');
		if (!button) return;

		const appName = button.dataset.key;
		const appInitialized = this.windows[appName];
		const origin = this.buttonsBar.getButtonOrigin(appName);
		if (!appInitialized && !this.windows[appName]) {
			if (!this.appsConfig[appName]) { console.error('App not found:', appName); return; }
			this.windows[appName] = new SubWindow(appName, this.appsConfig[appName].title, this.appsConfig[appName].content);
			this.windows[appName].render(this.windowsWrap, origin.x, origin.y);
		}

		this.toggleAppWindow(appName);
	}
	clickWindowHandler(e) {
		// if click in a window (anywhere), bring it to front
		// trough parents of the clicked element until find the window
		let target = e.target;
		while(target && target !== document.body) {
			if (target.classList.contains('window')) { break; }
			target = target.parentElement;
		}

		const subWindow = Object.values(this.windows).find(w => w.element.contains(target));
		if (!subWindow) return;

		const key = subWindow.element.dataset.key;
		this.setFrontWindow(key);
	}
	grabWindowHandler(e) {
		const titleBar = e.target.closest('.title-bar');
		if (!titleBar) return;

		const subWindow = Object.values(this.windows).find(w => w.element.contains(titleBar));
		if (!subWindow) return;

		subWindow.isDragging = true;
		subWindow.dragStart.x = e.clientX - subWindow.element.offsetLeft;
		subWindow.dragStart.y = e.clientY - subWindow.element.offsetTop;
		subWindow.element.classList.add('dragging');

		// bring to front
		const key = subWindow.element.dataset.key;
		this.setFrontWindow(key);
	}
	moveWindowHandler(e) {
		const subWindow = Object.values(this.windows).find(w => w.isDragging);
		if (!subWindow) return;

		subWindow.element.style.left = e.clientX - subWindow.dragStart.x + 'px';
		subWindow.element.style.top = e.clientY - subWindow.dragStart.y + 'px';
	}
	releaseWindowHandler(e) {
		const subWindow = Object.values(this.windows).find(w => w.isDragging);
		if (!subWindow) return;

		subWindow.position.left = e.clientX - subWindow.dragStart.x;
		subWindow.position.top = e.clientY - subWindow.dragStart.y;
		subWindow.isDragging = false;
		subWindow.element.classList.remove('dragging');
	}
}

const eHTML = {
	windowsWrap: document.getElementById('index-windows-wrap'),
	bottomButtonsBar: document.getElementById('index-bottom-buttons-bar')
}
const appsManager = new AppsManager(eHTML.windowsWrap, eHTML.bottomButtonsBar, appsConfig);
appsManager.initApps();

// better implementation with less event listeners
document.addEventListener('click', (e) => {
	appsManager.grabClickHandler(e);
	appsManager.clickWindowHandler(e);
});
document.addEventListener('mousedown', (e) => {
	appsManager.grabWindowHandler(e);
});
document.addEventListener('mousemove', (e) => {
	appsManager.moveWindowHandler(e);
});
document.addEventListener('mouseup', (e) => {
	appsManager.releaseWindowHandler(e);
});


// DARK MODE
document.addEventListener('change', (event) => {
	switch(event.target.id) {
		case 'index-dark-mode-toggle':
    		document.body.classList.toggle('index-dark-mode');
			break;
	}
});