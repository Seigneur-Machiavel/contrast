let WorkerModule;
try { WorkerModule = (await import('worker_threads')).Worker }
catch (/**@type {any}*/ error) { WorkerModule = Worker }

/** UNIFIED FOR BROWSER & NODEJS
 * @param {string} [scriptPath] - Path to the worker script file (for Node.js)
 * @param {string} [workerCode] - Worker code as a string (for Browser)
 * @param {object} [workerData] - Data to pass to the worker
 * @returns {Worker} - The created worker instance */
export function newWorker(scriptPath, workerCode, workerData = {}) {
    const worker = scriptPath 
        ? new WorkerModule(new URL(scriptPath, import.meta.url), { workerData })
        : new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
    
    // Add addEventListener/removeEventListener to Node.js workers
    if (worker.on && !worker.addEventListener) {
        worker.addEventListener = (event, handler) => {
            const wrappedHandler = (data) => handler({ data }); // Wrap Node.js data in event object
            worker.on(event, wrappedHandler);
            // Store mapping for removeEventListener
            if (!worker._handlerMap) worker._handlerMap = new Map();
            worker._handlerMap.set(handler, wrappedHandler);
        };
        
        worker.removeEventListener = (event, handler) => {
            const wrappedHandler = worker._handlerMap?.get(handler);
            if (wrappedHandler) {
                worker.off(event, wrappedHandler);
                worker._handlerMap.delete(handler);
            }
        };
    }
    
    return worker;
}