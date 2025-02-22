export class Breather {
    lastBreathTime = 0;
    breath = 0;
    constructor(msBetweenBreaths = 1000, breathDuration = 50) {
        this.msBetweenBreaths = msBetweenBreaths;
        this.breathDuration = breathDuration;
    }
    async breathe() {
        const now = performance.now();
        if (now - this.lastBreathTime < this.msBetweenBreaths) return;
        await new Promise(resolve => setTimeout(resolve, this.breathDuration));
        this.lastBreathTime = performance.now();
        this.breath++;
    }
}