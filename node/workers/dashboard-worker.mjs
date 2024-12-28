import { parentPort, workerData } from 'worker_threads';
import { DashboardWsApp, ObserverWsApp } from '../src/apps.mjs';

const nodePort = workerData.nodePort || 27260;
const dashboardPort = workerData.dashboardPort || 27271;
const observerPort = workerData.observerPort || 27270;

const dashApp = new DashboardWsApp(undefined, nodePort, dashboardPort);
while(!dashApp.node) { await new Promise(resolve => setTimeout(resolve, 1000)); }
new ObserverWsApp(dashApp.node, observerPort);

parentPort.on('message', async (message) => {
    if (message.type === 'stop') {
        await dashApp.stop();
        parentPort.close();
        //process.exit(0);
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncatched exception:', error.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejected:', promise, 'reason:', reason);
});