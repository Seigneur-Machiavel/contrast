import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { createWriteStream } from 'fs';

const CREATE_ZIP = true;
const SRC_DIR = '../';
const DIST_DIR = 'dist';
const FILES = [
	{ in: 'board-extension/manifest.json', out: 'manifest.json' },
	{ in: 'board-extension/background.js', out: 'background.js' },
	{ in: 'node_modules/hive-p2p/dist/browser/hive-p2p.min.js', out: 'hive-p2p.min.js' },

	{ in: 'libs/d3.v7.min.js' },
	{ in: 'libs/anime.min.js' },
	{ in: 'libs/three-4.5.min.js' },
	{ in: 'libs/bip39-3.1.0.min.js' },

	{ in: 'utils/currency.mjs' },
	{ in: 'utils/serializer.mjs' },
	{ in: 'utils/networking.mjs' },
	{ in: 'utils/conditionals.mjs' },
	{ in: 'utils/front-storage.mjs' },
	{ in: 'utils/hive-p2p-config.mjs' },
	{ in: 'utils/blockchain-settings.mjs' },

	{ in: 'node/src/sync.mjs' },
	{ in: 'node/src/block.mjs' },
	{ in: 'node/src/conCrypto.mjs' },
	{ in: 'node/src/transaction.mjs' },
	{ in: 'node/src/tx-validation.mjs' },

	{ in: 'types/sync.mjs' },
	{ in: 'types/block.mjs' },
	{ in: 'types/address.mjs' },
	{ in: 'types/validation.mjs' },
	{ in: 'types/transaction.mjs' },
	{ in: 'miniLogger/mini-logger.mjs' },
];
const FOLDERS = [
	{ in: 'board' },
];

// Clean dist
if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// Copy files
for (const file of FILES) {
  const src = path.join(SRC_DIR, file.in);
  const dest = path.join(DIST_DIR, file.out || file.in);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Copy folders
for (const folder of FOLDERS) {
	const srcFolder = path.join(SRC_DIR, folder.in);
	const destFolder = path.join(DIST_DIR, folder.out || folder.in);
	if (fs.existsSync(srcFolder)) fs.cpSync(srcFolder, destFolder, { recursive: true });
}

// Optional: create zip
if (CREATE_ZIP) {
	const output = createWriteStream('board-extension/extension.zip');
	const archive = archiver('zip', { zlib: { level: 9 } });
	
	output.on('close', () => console.log(`✓ Extension packaged (${archive.pointer()} bytes)`));
	archive.on('error', err => { throw err; });
	
	archive.pipe(output);
	archive.directory(DIST_DIR, false);
	archive.finalize();
}

console.log('✓ Extension build completed');