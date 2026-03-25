import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/** NODE-ONLY - Spawns a separate process (required for native addons like wrtc)
 * @param {string} scriptPath - Path to the script file
 * @param {object} [workerData] - Data passed as JSON via env NODE_WORKER_DATA
 * @param {boolean} [setupErrorLogger]
 * @returns {import('child_process').ChildProcess} */
export function newProcess(scriptPath, workerData = {}, setupErrorLogger = true) {
    const path = fileURLToPath(new URL(scriptPath, import.meta.url));
    const child = spawn(process.execPath, [path], {
        stdio: 'inherit', // forward stdout/stderr directly to parent console
        env: { ...process.env, NODE_WORKER_DATA: JSON.stringify(workerData) }
    });

    if (!setupErrorLogger) return child;
    child.on('error', err => console.error('[process error]', err));
    child.on('exit', code => { if (code !== 0) console.error(`[process exit] code ${code}`); });
    return child;
}