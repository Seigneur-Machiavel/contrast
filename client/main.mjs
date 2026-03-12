// @ts-check
// Entry point — dispatches to launcher or node based on --mode arg
let mode = 'launcher';
const args = process.argv.slice(2);
for (const arg of args)
    if (arg.startsWith('--mode=')) mode = arg.split('--mode=')[1];

if (mode.includes('/') || mode.includes('..')) { // SECURITY CHECK
	console.error('Invalid mode');
	process.exit(1);
}

console.log(`Starting Contrast in mode: ${mode}`);
if (mode.includes('run')) await import(`../node/${mode}.mjs`);
else if (mode.includes('test')) await import(`../tests/${mode}.mjs`);
else await import('./launcher.mjs');