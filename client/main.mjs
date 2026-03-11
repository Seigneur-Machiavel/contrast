// @ts-check
// Entry point — dispatches to launcher or node based on --mode arg
const args = process.argv.slice(2);
let mode = args.includes('--mode=node') ? 'node' : 'launcher';

if (mode === 'node') await import('../tests/test-staking.mjs');
else await import('./launcher.mjs');