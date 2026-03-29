import fs from 'fs';
import url from 'url';
import path from 'path';
import archiver from 'archiver';
import { createWriteStream } from 'fs';

// ---- BUILD EXTENSION --------------------------------------------------
// FOCUS THE ROOT FOLDER
const filePath = url.fileURLToPath(import.meta.url);
let rootFolder = filePath; // loop until we find "contrast" folder
while (!rootFolder.endsWith('contrast'))
	if (rootFolder === path.dirname(rootFolder)) throw new Error('Could not find contrast root folder');
	else rootFolder = path.dirname(rootFolder);

// SETUP PATHS
const DIST_DIR = path.join(rootFolder, 'build/extension/dist');
const FILES = [
	{ in: 'build/extension/manifest.json', out: 'manifest.json' },
	{ in: 'build/extension/background.js', out: 'background.js' },
	{ in: 'node_modules/hive-p2p/dist/browser/hive-p2p.min.js', out: 'hive-p2p.min.js' },

	{ in: 'external-libs/d3.v7.min.js' },
	{ in: 'external-libs/anime.min.js' },
	{ in: 'external-libs/three-4.5.min.js' },
	{ in: 'external-libs/bip39-3.1.0.min.js' },

	{ in: 'config/hive-p2p-config.mjs' },
	{ in: 'config/blockchain-settings.mjs' },
	{ in: 'miniLogger/mini-logger.mjs' },

	{ in: 'node/src/sync.mjs' },
	{ in: 'node/src/block.mjs' },
	{ in: 'node/src/wallet.mjs' },
	{ in: 'node/src/conCrypto.mjs' },
	{ in: 'node/src/transaction.mjs' },
	{ in: 'node/src/tx-validation.mjs' },
	{ in: 'node/src/tx-rule-checkers.mjs' },

	{ in: 'types/sync.mjs' },
	{ in: 'types/block.mjs' },
	{ in: 'types/address.mjs' },
	{ in: 'types/validation.mjs' },
	{ in: 'types/transaction.mjs' },

	{ in: 'utils/currency.mjs' },
	{ in: 'utils/serializer.mjs' },
	{ in: 'utils/networking.mjs' },
	{ in: 'utils/conditionals.mjs' },
	{ in: 'utils/front-storage.mjs' },
	{ in: 'utils/progress-logger.mjs' }
];
const FOLDERS = [
	{ in: 'board' },
];

// CLEAN DIST
if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// COPY FILES
for (const file of FILES) {
	const src = path.join(rootFolder, file.in);
	const dest = path.join(DIST_DIR, file.out || file.in);
	if (!fs.existsSync(src)) throw new Error(`Source file does not exist: ${src}`);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

// COPY FOLDERS
for (const folder of FOLDERS) {
	const srcFolder = path.join(rootFolder, folder.in);
	const destFolder = path.join(DIST_DIR, folder.out || folder.in);
	if (!fs.existsSync(srcFolder)) throw new Error(`Source folder does not exist: ${srcFolder}`);
	fs.cpSync(srcFolder, destFolder, { recursive: true });
}

// CREATE ZIP
const output = createWriteStream('build/extension/extension.zip');
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log(`✓ Extension packaged (${archive.pointer()} bytes)`));
archive.on('error', err => console.error('Error creating zip:', err.stack || err));
archive.on('entry', entry => console.log('Adding:', entry.name));

console.log('DIST_DIR resolved:', path.resolve(DIST_DIR));
console.log('DIST exists:', fs.existsSync(DIST_DIR));
console.log('DIST contents:', fs.readdirSync(DIST_DIR).slice(0, 5));
archive.pipe(output);
archive.directory(path.resolve(DIST_DIR), false);
await archive.finalize();

// REMOVE DIST FOLDER
fs.rmSync(DIST_DIR, { recursive: true });

console.log('✓ Extension build completed');
