process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

import { parentPort, workerData } from 'worker_threads';
import { DashboardWsApp, ObserverWsApp } from '../src/apps.mjs';

const nodePort = workerData.nodePort || 27260;
const dashboardPort = workerData.dashboardPort || 27271;
const observerPort = workerData.observerPort || 27270;

/** @type {ObserverWsApp} */
let observApp;
const dashApp = new DashboardWsApp(undefined, nodePort, dashboardPort);
async function stop() {
    try {
        await dashApp.stop();
        if (observApp) observApp.stop();
        parentPort.postMessage({ type: 'stopped' });
        parentPort.close();
        console.log('Dashboard worker stopped.');
    } catch (error) { console.error('Dashboard worker stop error:', error); }
}
async function stopIfDashAppStoppedLoop() {
    while(dashApp.stopped === false) { await new Promise(resolve => setTimeout(resolve, 1000)); }
    await stop();
}
parentPort.on('message', async (message) => {
    switch(message.type) {
        case 'stop':
            await stop();
            break;
        case 'set_private_key':
            console.info('Setting private key');
            await dashApp.init(message.data);
            dashApp.nodesSettings[dashApp.node.id].privateKey = message.data;
            dashApp.saveNodeSettings();
            console.info('Private key set');
            break;
        default:
            console.error('Unknown message type:', message.type);
    }
});
stopIfDashAppStoppedLoop();
while(!dashApp.node) { await new Promise(resolve => setTimeout(resolve, 1000)); }
observApp = new ObserverWsApp(dashApp.node, observerPort);