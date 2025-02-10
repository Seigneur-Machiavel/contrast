export class ProgressLogger {
    constructor(total, msgPrefix = '[LOADING] digestChain') {
        this.total = total;
        this.msgPrefix = msgPrefix;
        this.stepSizePercent = 10;
        this.lastLoggedStep = 0;
        this.startTime = Date.now();
        this.stepTime = Date.now();
    }

    logProgress(current, logCallBack = (m) => { console.log(m); }) {
        //const progress = current === this.total - 1 ? 100 : (current / this.total) * 100;
        const progress = current === this.total ? 100 : (current / this.total) * 100;
        const currentStep = Math.floor(progress / this.stepSizePercent);
        if (currentStep <= this.lastLoggedStep) { return; }

        const timeDiff = Date.now() - this.stepTime;
        this.lastLoggedStep = currentStep;
        this.stepTime = Date.now();
        logCallBack(`${this.msgPrefix} : ${progress.toFixed(1)}% (${current}/${this.total}) - step: ${timeDiff}ms`);

        //if (current === this.total - 1) { //? stupid boy!?
        if (current === this.total) {
            const totalTime = Date.now() - this.startTime;
            const avgTime = totalTime / this.total;
            logCallBack(`[TASK COMPLETED] - Total time: ${totalTime}ms - Average time per step: ${avgTime.toFixed(2)}ms`);
        }
    }
};