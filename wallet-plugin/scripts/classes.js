if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const { cryptoLight } = require("../../utils/cryptoLight.js");
}

//#region - CLASSES
class LockCircle {
	constructor(element, dTransitionMs = 120, strokeTransitionMs = 120, opacityTransitionMs = 120) {
		this.dTransitionMs = dTransitionMs;
		this.strokeTransitionMs = strokeTransitionMs;
		this.opacityTransitionMs = opacityTransitionMs;
		this.shape = 'hexagon';
		this.wrap = element.parentElement;
		/** @type {HTMLElement} */
		this.element = element;
		this.lines = [];
		this.paths = [];

		this.shapes = {
			hexagon: [
				'M 27 5 Q 50 5 73 5',
				'M 27 5 Q 50 5 60 5',
				'M 40 5 Q 50 5 73 5'
			],
			circle: [
				'M 27 5 Q 50 -6 73 5',
				'M 27 5 Q 44.5 -2.5 60 1',
				'M 40 1 Q 55.5 -2.5 73 5'
			],
			dot: 'M 50 5 Q 50 5 50 5',
			lineA: 'M 45 2 Q 50 0 55 2',
			lineB: 'M 40 0 Q 50 2 60 0',
		}
		this.strokeOpacities = { hexagon: .4, circle: .4, dot: .12, lineA: .04, lineB: .06 };
	}

	init(angle = 0, closed = false) {
		this.element.innerHTML = '';
		this.lines = [];
		const nbOfLines = 6;
		let shapeIndex = 0;
		for (let i = 0; i < nbOfLines; i++) {
			shapeIndex = closed ? 0 : ( i > 2 ? 0 : i );
			this.element.innerHTML += `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
                   <path d="${this.shapes.hexagon[shapeIndex]}" stroke-opacity="${this.strokeOpacities.hexagon}" style="transition: d ${this.dTransitionMs}ms ease-in-out, stroke ${this.strokeTransitionMs}ms ease-in-out, stroke-opacity ${this.opacityTransitionMs}ms ease-in-out;" />
                </svg>`;
		}
		this.paths = this.element.getElementsByTagName('path');
		this.rotate(angle);
	}
	rotate(angle = 0) { this.wrap.style.transform = `rotate(${angle}deg)`; }
	setShape(shape = 'hexagon', closed = false) {
		this.shape = shape;

		let shapeIndex = 0;
		for (let i = 0; i < this.paths.length; i++) {
			shapeIndex = closed ? 0 : ( i > 2 ? 0 : i );
			const isIdleShape = shape !== 'hexagon' && shape !== 'circle';
			const pathStr = isIdleShape ? this.shapes[shape] : this.shapes[shape][shapeIndex];
			const path = this.paths[i];
			path.setAttribute('d', pathStr);
			path.setAttribute('stroke-opacity', this.strokeOpacities[shape]);
		}
	}
}
class CenterScreenBtn {
	constructor() {
		this.transitionMs = 240;
		this.delayBeforeIdleAnimationIfLocked = 20000;
		this.idleAnimationLoopMs = 4000;
		this.state = 'locked'; // 'locked' or 'unlocked' or 'welcome'
		this.centerScreenBtnWrap = document.getElementById('centerScreenBtnWrap');
		this.pickAxe = document.getElementById('pickAxe'); // only available in the popup
		this.elementWrap = document.getElementById('centerScreenBtn').parentElement;
		this.element = document.getElementById('centerScreenBtn');

		/** @type {LockCircle[]} */
		this.lockCircles = [];
		//this.lockCirclesPos = [ 0, 60, 120, 180, 240, 300, 0 ];
		this.lockCirclesPos = [ 0, 240, 60, 180, 300, 120, 240 ];
		this.lockCirclesIdlePos = [ 0, 60, 120, 180, 240, 300 ];
		this.dTransitionMs = 120;
		this.wrapTransitionMs = 120;
	}
	init(nbOfLockCircles = 7) {
		this.elementWrap.style.transition = `transform ${this.transitionMs}ms ease-in-out`;
		this.lockCircles = [];
		this.element.innerHTML = '';
		for (let i = 0; i < nbOfLockCircles; i++) {
			const angle = this.lockCirclesPos[i];
			const lockCircleDiv = document.createElement('div');
			lockCircleDiv.classList.add('lockCircle');

			const wrap = document.createElement('div');
			wrap.classList.add('wrap');
			wrap.style.transition = `transform ${this.wrapTransitionMs}ms ease-in-out`;
			wrap.appendChild(lockCircleDiv);
			
			const lockCircle = new LockCircle( lockCircleDiv, this.dTransitionMs );
			lockCircle.init(angle, this.state === 'welcome');
			this.lockCircles.push(lockCircle);
			this.element.appendChild(wrap);
		}
		this.idleAnimation();
	}
	rotate(angle = 0) { this.elementWrap.style.transform = `rotate(${angle}deg)`; }
	async unlock() {
		this.state = 'unlocking';
		this.rotate(0);
		this.lockCircles.forEach( lc => lc.setShape('hexagon') );

		for (let i = 0; i < this.lockCircles.length; i++) {
			await new Promise(r => setTimeout(r, this.wrapTransitionMs));
			if (this.state !== 'unlocking') { return; }
			
			const lockCircle = this.lockCircles[i];
			lockCircle.setShape('circle');
			
			await new Promise(r => setTimeout(r, this.dTransitionMs));
			if (this.state !== 'unlocking') { return; }

			lockCircle.rotate(0);
		}
		
		await new Promise(r => setTimeout(r, this.wrapTransitionMs * 4));
		this.lockCircles.forEach( lc => lc.setShape('dot') );

		this.state = 'unlocked';
	}
	async lock() {
		this.state = 'locking';
		this.rotate(0);
		this.lockCircles.forEach( lc => lc.setShape('circle') );

		for (let i = this.lockCircles.length -1; i >= 0; i--) {
			await new Promise(r => setTimeout(r, this.dTransitionMs));
			if (this.state !== 'locking') { return; }

			const lockCircle = this.lockCircles[i];
			lockCircle.setShape('hexagon');
			
			await new Promise(r => setTimeout(r, this.wrapTransitionMs));
			if (this.state !== 'locking') { return; }

			lockCircle.rotate(this.lockCirclesPos[i]);
		}

		this.state = 'locked';
	}
	setShape(shape = 'hexagon') {
		this.lockCircles.forEach( lc => lc.setShape(shape) );
	}
	show(speed = 200) {
		this.element.classList.remove('hidden');
		anime({
			targets: this.element,
			opacity: 1,
			duration: speed,
			easing: 'easeOutQuad',
			complete: () => { this.element.style.zIndex = 1; }
		});
	}
	hide(speed = 200) {
		anime({
			targets: this.element,
			opacity: 0,
			duration: speed,
			easing: 'easeOutQuad',
			complete: () => { this.element.style.zIndex = -1; this.element.classList.add('hidden'); }
		});
	}
	async idleAnimation() {
		await new Promise(r => setTimeout(r, 2400));

		let lockedSince = Date.now();
		while (true) {
			if (this.state !== 'locked' && this.state !== 'unlocked') { lockedSince = Date.now(); }
			if (this.state === 'locked' && Date.now() > lockedSince + this.delayBeforeIdleAnimationIfLocked) { this.state = 'welcome'; }

			const startTimestamp = Date.now();

			await this.popCircleAnimation(['welcome']); //, 'locked']);
			await this.turningAnimation(['welcome']); //, 'locked']);

			await this.popDotAnimation(['unlocked']);
			
			//console.log('idleAnimation duration:', Date.now() - startTimestamp);
			await new Promise(r => setTimeout(r, this.idleAnimationLoopMs - ( Date.now() - startTimestamp )));
		}
	}
	async turningAnimation(authorizedStates = ['welcome']) {
		if (!authorizedStates.includes(this.state)) { return }

		const rndFloor = rnd(0, this.lockCircles.length - 1);
		const rndAngleIndex = rnd(0, this.lockCirclesIdlePos.length - 1);
		const rndAngle = this.lockCirclesIdlePos[rndAngleIndex];

		this.lockCircles.forEach( (lc, i) => { lc.setShape(i <= rndFloor ? 'circle' : 'hexagon', this.state === 'welcome' ? rnd(0, 1) : false); } );

		await new Promise(r => setTimeout(r, this.dTransitionMs * 2));
		if (!authorizedStates.includes(this.state)) { return }

		this.lockCircles.forEach( (lc, i) => { if (i <= rndFloor) { lc.rotate(rndAngle) }; } );

		await new Promise(r => setTimeout(r, this.wrapTransitionMs * 2));
		if (!authorizedStates.includes(this.state)) { return }

		this.lockCircles.forEach( lc => lc.setShape('hexagon', this.state === 'welcome' ? true : false) );
	}
	async popCircleAnimation (authorizedStates = ['welcome']) {
		if (!authorizedStates.includes(this.state)) { return }

		this.lockCircles.forEach( lc => lc.setShape('hexagon', this.state === 'welcome' ? true : false) );

		for (let i = 0; i < this.lockCircles.length; i++) {
			await new Promise(r => setTimeout(r, this.dTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }

			this.lockCircles[i].setShape('circle', this.state === 'welcome' ? true : false);
			
			await new Promise(r => setTimeout(r, this.wrapTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }
		}
	}
	async popDotAnimation(authorizedStates = ['unlocked']) {
		if (!authorizedStates.includes(this.state)) { return }

		for (let i = this.lockCircles.length - 1; i >= 0; i--) {
			this.lockCircles[i].setShape('dot');
			await new Promise(r => setTimeout(r, this.dTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }
		}
		
		for (let i = 0; i < this.lockCircles.length; i++) {
			this.lockCircles[i].setShape('lineA');
			await new Promise(r => setTimeout(r, this.wrapTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }
		}

		for (let i = 0; i < this.lockCircles.length; i++) {
			this.lockCircles[i].setShape('dot');
			await new Promise(r => setTimeout(r, this.dTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }
		}

		await new Promise(r => setTimeout(r, this.wrapTransitionMs * 2));
		
		for (let i = this.lockCircles.length - 1; i >= 0; i--) {
			this.lockCircles[i].setShape('lineB');
			await new Promise(r => setTimeout(r, this.wrapTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }
		}

		for (let i = this.lockCircles.length - 1; i >= 0; i--) {
			this.lockCircles[i].setShape('dot');
			await new Promise(r => setTimeout(r, this.dTransitionMs));
			if (!authorizedStates.includes(this.state)) { return }
		}

		await new Promise(r => setTimeout(r, this.wrapTransitionMs * 2));
	}
}
class Mnemonic {
	constructor(mnemonic = [], bip = "BIP-0039", language = "english") {
		this.mnemonic = mnemonic;
		this.bip = bip;
		this.language = language;
	}
	isFilled() {
		if (this.mnemonic.length === 0) { return false; }
		return true;
	}
	getMnemonicStr() {
		return this.mnemonic.join(' ');
	}
	getIndexedMnemonicStr() {
		let mnemonicStr = "";
		for (let i = 0; i < this.mnemonic.length; i++) {
			mnemonicStr += `${i + 1}. ${this.mnemonic[i]}\n`;
		}
		return mnemonicStr;
	}
	genRandomMnemonic(wordsList, len = 12, save = true) { // can be improved
		if (save) { this.mnemonic = []; }
		const result = [];

		for (let i = 0; i < len; i++) {
			const rndWord = this.getRandomWord(wordsList);
			if (save) { this.mnemonic.push(rndWord); }
			result.push(rndWord);
		}

		return result;
	}
	getRandomWord(wordsList = []) {
		const wordsListLength = wordsList.length;
		if (wordsListLength === 0) { return; }
	
		const rnd = this.cryptoRnd(0, wordsListLength - 1);
		return wordsList[rnd];
	}
	cryptoRnd(min, max) {
		const crypto = crypto;
		const randomBuffer = new Uint32Array(1);
	
		crypto.getRandomValues(randomBuffer);
		const randomValue = randomBuffer[0] / (0xffffffff + 1);
	
		return Math.floor(randomValue * (max - min + 1) + min);
	}
}
class UserData {
	constructor() {
		this.id = "";
		this.encryptedMasterMnemonicsStr = "";
		this.encryptedMnemoLinksStr = {};
		this.preferences = {
			autoCloudSync: true,
			darkMode: false,
		};
		this.state = {
			synchronizedWithCloud: true // consider the data as synchronized because initialized class is empty
		}
	}
	// Master Mnemonic
	async setMnemonicAsEncrypted(mnemonicStr = "") {
		const mnemonicStrEncrypted = await this.#encrypStringWithPassword(mnemonicStr);
		if (!mnemonicStrEncrypted) { return false; }

		this.encryptedMasterMnemonicsStr = mnemonicStrEncrypted;
		this.state.synchronizedWithCloud = false;
		return true;
	}
	clearMasterMnemonic() { this.encryptedMasterMnemonicsStr = ""; }
	async getMasterMnemonicArray() {
		if (!this.isMasterMnemonicFilled()) { return false; }

		const mnemonicStr = await this.#decryptStringWithPassword(this.encryptedMasterMnemonicsStr);
		if (!mnemonicStr) { return false; }

		return mnemonicStr.split(' ');
	}
	async getMasterMnemonicStr() {
		if (!this.isMasterMnemonicFilled()) { return false; }

		const mnemonicStr = await this.#decryptStringWithPassword(this.encryptedMasterMnemonicsStr);
		if (!mnemonicStr) { return false; }

		return mnemonicStr;
	}
	async getIndexedMasterMnemonicStr() {
		if (!this.isMasterMnemonicFilled()) { return false; }
		const mnemonicStrDecrypted = await this.#decryptStringWithPassword(this.encryptedMasterMnemonicsStr);
		if (!mnemonicStrDecrypted) { return false; }

		const mnemonicArray = mnemonicStrDecrypted.split(' ');
		
		let mnemonicStr = "";
		for (let i = 0; i < mnemonicArray.length; i++) {
			mnemonicStr += `${i + 1}. ${mnemonicArray[i]}\n`;
		}

		return mnemonicStr;
	}
	isMasterMnemonicFilled() { return this.encryptedMasterMnemonicsStr === "" ? false : true; }
	// Crypto -> local storage
	async #encrypStringWithPassword(str = "") {
		const encryptedStr = await cryptoLight.encryptText(str);
		if (!encryptedStr) { return false; }

		return encryptedStr;
	}
	async #decryptStringWithPassword(encryptedStr = "") {
		const str = await cryptoLight.decryptText(encryptedStr);
		if (!str) { return false; }

		return str;
	}
}
class Communication {
    constructor(serverUrl) {
        this.url = serverUrl;
		this.sanitizer = new Sanitizer();
    }

	async pingServer(serverUrl) {
		try {
			const response = await fetch(`${serverUrl}/api/ping`);
			const result = await response.json();
			if (result.success) { return true; }
		} catch (error) {
		}
		return false;
	}
	/**
	 * Send MnemoLinks to server - Return server's response
	 * @param {string} userId - userData.id
	 * @param {object} encryptedMnemoLinksStr - userData.encryptedMnemoLinksStr
	 * @returns {Promise<boolean>}
	 */
	async sendMnemoLinksToServer(userId, encryptedMnemoLinksStr) {
		const data = { 
			id: userId,
			encryptedMnemoLinksStr: encryptedMnemoLinksStr,
		};
	
		const serverUrl = `${settings.serverUrl}/api/storeMnemoLinks`;
		const requestOptions = {
		  method: 'POST',
		  headers: {
			'Content-Type': 'application/json',
		  },
		  body: JSON.stringify(data)
		};
	  
		try {
		  const response = await fetch(serverUrl, requestOptions);
		  const result = await response.json();

		  if (typeof result.success !== 'boolean') { console.error('Invalid response from server !'); return false; }
		  console.log(`MnemoLinks sent to server: ${result.success}`);
		  return result.success;
		} catch (error) {
		  console.error(`Error while sending MnemoLinks to server: ${error}`);
		  return false;
		}
	}
	/**
	 * Send pubKey with server - Return server's pubKey (sanitized)
	 * @param {string} authID
	 * @param {Uint8Array} publicKey
	 * @returns {Promise<boolean | Uint8Array>}
	 */
	async sharePubKeyWithServer(authID, publicKey) {
		const data = { authID, publicKey };
		const stringifiedData = JSON.stringify(data);
		const serverUrl = `${this.url}/api/sharePubKey`;

		const requestOptions = {
		  method: 'POST',
		  headers: {
			'Content-Type': 'application/json',
		  },
		  body: stringifiedData
		};
	  
		try {
		  const response = await fetch(serverUrl, requestOptions);
		  const result = await response.json();

		  if (typeof result.success !== 'boolean') { console.error('Invalid response from server !'); return false; }
		  if (result.message) { result.message = this.sanitizer.sanitize(result.message); }
		  if (result.serverPublicKey) { result.serverPublicKey = this.sanitizer.sanitize(result.serverPublicKey); }
		  return result;
		} catch (error) {
		  console.info(`Error while sharing public key with server: ${error}`);
		  return false;
		}
	}
	/**
	 * Send encrypted auth data to server - Return server's response
	 * @param {Uint8Array} serverPublicKey
	 * @param {string} authID
	 * @param {string} authTokenHash
	 * @param {string} encryptedPassComplement
	 * @param {cryptoTimingsObject} totalTimings
	 * @returns {Promise<boolean | object>}
	 */
	async sendAuthDataToServer(serverPublicKey, authID, authTokenHash, encryptedPassComplement, totalTimings) {
		if (!serverPublicKey || !authID || !authTokenHash) { console.error('Missing data !'); return false; }

		const authTokenHashEnc = await cryptoLight.encryptData(serverPublicKey, authTokenHash);
		const encryptedPassComplementEnc = encryptedPassComplement ? await cryptoLight.encryptData(serverPublicKey, encryptedPassComplement) : false;
	
		const data = {
			authID,
			authTokenHash: btoa(String.fromCharCode.apply(null, new Uint8Array(authTokenHashEnc))),
			encryptedPassComplement: encryptedPassComplementEnc ? btoa(String.fromCharCode.apply(null, new Uint8Array(encryptedPassComplementEnc))) : false,
		};
		if (totalTimings) {
			data.argon2Time = totalTimings.argon2Time;
			data.deriveKTime = totalTimings.deriveKTime;
			data.totalTime = totalTimings.total;
		}
	
		//console.log(data);
		const apiRoute = encryptedPassComplement ? 'createAuthInfo' : 'loginAuthInfo';
		const serverUrl = `${settings.serverUrl}/api/${apiRoute}`;
		const requestOptions = {
		  method: 'POST',
		  headers: {
			'Content-Type': 'application/json',
		  },
		  body: JSON.stringify(data)
		};
	  
		try {
		  const response = await fetch(serverUrl, requestOptions);
		  const result = await response.json();

		  if (typeof result.success !== 'boolean') { console.error('Invalid response from server !'); return false; }
		  if (result.message) { result.message = this.sanitizer.sanitize(result.message); }
		  if (result.encryptedPassComplement) { result.encryptedPassComplement = this.sanitizer.sanitize(result.encryptedPassComplement); }
		  return result;
		} catch (error) {
		  console.info(`Error while sending AuthData to server: ${error}`);
		  return false;
		}
	}
}
class AuthInfo {
	constructor() {
		this.appVersion = "";
		this.authID = "";
		this.authToken = "";
		this.hash = "";
		this.salt1Base64 = "";
		this.iv1Base64 = "";
		this.serverAuthBoost = false;
	}
}
class Sanitizer {
	constructor() {
		this.validTypeToReturn = ['number', 'boolean'];
	}

	sanitize(data) {
		if (!data) return false;
		if (this.validTypeToReturn.includes(typeof data)) return data;
		if (typeof data !== 'string' && typeof data !== 'object') return 'Invalid data type';
	
		if (typeof data === 'string') {
			//return data.replace(/[^a-zA-Z0-9+/=$,]/g, ''); // DEPRECATED - losing "."
			return data.replace(/[^a-zA-Z0-9+\/=.$,]/g, '');
		} else if (typeof data === 'object') {
			const sanitized = {};
			for (const key in data) {
				const sanitazedValue = this.sanitize(data[key]);
				sanitized[this.sanitize(key)] = sanitazedValue;
			}
			return sanitized;
		}
		return data;
	}
}
class Miner {
	/**
	* @param {CenterScreenBtn} centerScreenBtn
	* @param {Communication} communication
	*/
	constructor(centerScreenBtn) {
		this.centerScreenBtn = centerScreenBtn;
		this.connectionState = 'connected';
		this.paused = false;

		this.miningAnimationLoop();
	}

	async init() { // DEPRECATED
		const miningIsActive = await this.isMiningActive();
        if (miningIsActive) { // continue mining
            console.log(`popup send: startMining (from previous state)`);
            await chrome.runtime.sendMessage({action: "startMining"});
            this.centerScreenBtn.pickAxe.classList.remove('invisible');
        }

        this.miningAnimationLoop();
	}
	async miningAnimationLoop() {
		const pickAxe = this.centerScreenBtn.pickAxe;
		pickAxe.style.transform = 'rotate(0deg) translateX(20%) translateY(0%) scale(.6)';
		const minDuration = 50;
		let circleAnim = null;
	
		while(true) {
			const miningIsActive = await this.isMiningActive();
			const miningIntensity = this.getIntensityFromSpan();
	
			let pauseDuration = miningIntensity === 10 ? 0 : 2000 / (1.4 ** miningIntensity);
			if (this.connectionState !== 'connected') { pauseDuration = 1000; }
			const duration = pauseDuration < minDuration ? minDuration : pauseDuration;
			
			await new Promise(resolve => setTimeout(resolve, duration));

			if (!miningIsActive || miningIntensity === 0) {
				this.centerScreenBtn.pickAxe.classList.add('invisible');
				this.centerScreenBtn.state = 'welcome';
				continue;
			} else {
				//this.centerScreenBtn.state = 'unlocked';
				this.centerScreenBtn.state = 'mining';
				this.centerScreenBtn.pickAxe.classList.remove('invisible');
			}
			
			if (this.connectionState !== 'connected') {
				// rotate (loading)
				circleAnim = anime({
					targets: pickAxe,
					rotate: '+=360deg',
					translateX: ['-10%', '0%', '10%'],
					translateY: '0%',
					scale: [.6, .64, .6],
					opacity: [0, 1],
					
					easing: 'easeOutQuad',
					duration: duration * .5,
				});
				continue;
			}
	
			// Pull
			circleAnim = anime({
				targets: pickAxe,
				rotate: '0deg',
				translateX: '40%',
				translateY: '10%',
				scale: .6,
	
				easing: 'easeOutQuad',
				duration: duration * .7,
			});
	
			setTimeout(async () => {
				this.centerScreenBtn.lockCircles.forEach( lc => lc.setShape('hexagon', true) );
			}, 20);
			await new Promise(resolve => setTimeout(resolve, duration * .7));
	
			// Shot
			circleAnim = anime({
				targets: pickAxe,
				rotate: '-100deg',
				translateX: '20%',
				translateY: '-10%',
				scale: .62,
				easing: 'easeInQuad',
				duration: duration * .3,
			});
	
			setTimeout(async () => { 
				for (let i = this.centerScreenBtn.lockCircles.length - 1; i >= 0; i--) {
					this.centerScreenBtn.lockCircles[i].setShape('dot');
					await new Promise(r => setTimeout(r, 20));
				}
			}, duration * .26);
			await new Promise(resolve => setTimeout(resolve, duration * .3));
		}
	}
	/** @return {Promise<boolean>} - true if mining is active */
	async isMiningActive() {
		const miningIntensity = await chrome.storage.local.get('miningIntensity');
		if (!miningIntensity || !miningIntensity.miningIntensity || miningIntensity.miningIntensity === 0) {
			return false;
		}

		return true;
	}
	getIntensityFromSpan() {
		const rangeSpan = document.getElementById('intensityValueStr');
		return parseInt(rangeSpan.innerText);
	}
}
//#endregion

if (false) {
    module.exports = {
        LockCircle,
        CenterScreenBtn,
        Mnemonic,
        UserData,
        TempData,
        MnemoBubble,
        SvgLink,
        MnemoLinkSVG,
        GameController,
		Communication,
		AuthInfo,
		Sanitizer,
		Miner,
    };
}