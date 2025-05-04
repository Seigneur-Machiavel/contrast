export class Breather {
    lastBreathTime = 0;
    breath = 0;
    constructor(msBetweenBreaths = 250, breathDuration = 25) {
        this.msBetweenBreaths = msBetweenBreaths;
        this.breathDuration = breathDuration;
    }
    async breathe() {
        const now = performance.now();
        if (now - this.lastBreathTime < this.msBetweenBreaths) return;
        //await new Promise(resolve => setTimeout(resolve, this.breathDuration));
        await new Promise(resolve => setImmediate(resolve)); // less expensive
        this.lastBreathTime = performance.now();
        this.breath++;
    }
}