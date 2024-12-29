process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

import { parentPort, workerData } from 'worker_threads';
import { DashboardWsApp, ObserverWsApp } from '../src/apps.mjs';

const nodePort = workerData.nodePort || 27260;
const dashboardPort = workerData.dashboardPort || 27271;
const observerPort = workerData.observerPort || 27270;

const dashApp = new DashboardWsApp(undefined, nodePort, dashboardPort);
while(!dashApp.node) { await new Promise(resolve => setTimeout(resolve, 1000)); }
const observApp = new ObserverWsApp(dashApp.node, observerPort);

async function stop() {
    try {
        await dashApp.stop();
        observApp.stop();
        parentPort.close();
    } catch (error) { console.error('Dashboard worker stop error:', error); }
}
async function stopIfDashAppStoppedLoop() {
    while(dashApp.stopped === false) { await new Promise(resolve => setTimeout(resolve, 1000)); }
    await stop();
}

parentPort.on('message', async (message) => { if (message.type === 'stop') { await stop(); } });
stopIfDashAppStoppedLoop();