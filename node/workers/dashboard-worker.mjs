import { parentPort, workerData } from 'worker_threads';
import { DashboardWsApp, ObserverWsApp } from '../run/apps.mjs';
import { NodeFactory } from '../src/node-factory.mjs';

const nodePort = workerData.nodePort || 27260;
const dashboardPort = workerData.dashboardPort || 27271;
const observerPort = workerData.observerPort || 27270;
const closeWhenFactoryStops = workerData.closeWhenFactoryStops || true;

const factory = new NodeFactory(nodePort, true);
//new DashboardWsApp(factory, dashboardPort);
//new ObserverWsApp(factory, observerPort);

parentPort.on('message', async (message) => {
    if (message.type === 'request-restart') {
        const node = factory.getFirstNode();
        if (!node) { return; }
        node.requestRestart('dashboard-worker');
    }
});

(async () => {
    while (closeWhenFactoryStops) {
        if (factory.stopped) {
            parentPort.postMessage({ type: 'factory-stopped' });
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
})();
process.on('uncaughtException', (error) => {
    console.error('Uncatched exception:', error.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejected:', promise, 'reason:', reason);
});