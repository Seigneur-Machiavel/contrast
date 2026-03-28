// @ts-check
import fs from 'fs';
import url from 'url';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { createWriteStream } from 'fs';

// ---- BUILD RELEASE --------------------------------------------------
// FOCUS THE ROOT FOLDER
const filePath = url.fileURLToPath(import.meta.url);
let rootFolder = filePath; // loop until we find "contrast" folder
while (!rootFolder.endsWith('contrast'))
	if (rootFolder === path.dirname(rootFolder)) throw new Error('Could not find contrast root folder');
	else rootFolder = path.dirname(rootFolder);

const RELEASE_DIR = path.join(rootFolder, 'build/desktop/release');
const RESOURCES_DIST = path.join(RELEASE_DIR, 'dist');

// ---- WHAT GOES IN resources.zip (updates) ----------------------------------------
/** @type {{in: string, out?: string}[]} */
const RESOURCES_FILES = [
	{ in: 'package.json' }, 			// for version display and update checks
	//{ in: 'bootstraps.json' },			// bootstraps URLs list
	{ in: 'client/launcher.mjs' },			// launcher patching
	{ in: 'client/node-manager.mjs' },  	// launcher patching
	{ in: 'client/updater.mjs' },			// launcher patching
	{ in: 'client/main.mjs' },				// launcher patching
];
const RESOURCES_FOLDERS = [
	{ in: 'board' },
	{ in: 'config' },

	{ in: 'external-libs' },
    { in: 'miniLogger' },
    { in: 'node' },
    { in: 'storage' },
	// { in: 'tests' }, // not used
    { in: 'types' },
    { in: 'utils' },
];

// node_modules PROD ONLY (EXCLUDE devDependencies)
const DEV_DEPS = ['archiver', 'esbuild', '@yao-pkg/pkg', 'postject'];
const NM_SRC = path.join(rootFolder, 'node_modules');
const NM_DIST = path.join(RESOURCES_DIST, 'node_modules');

// ---- WHAT GOES IN contrast.zip (initial install) ---------------------------------
const CONTRAST_CLIENT_FILES = [
    { in: 'client/contrast.exe' },
    { in: 'client/neutralino-win_x64.exe' },
    { in: 'client/neutralino.config.json' },
    { in: 'client/contrast_32.png' },
    { in: 'client/launcher.mjs' },
    { in: 'client/node-manager.mjs' },
	{ in: 'client/updater.mjs' },
    { in: 'client/main.mjs' },
    { in: 'client/sea-entry.cjs' },
];

// ---- HELPERS -----------------------------------------------------------------------
/** @param {string} filePath @returns {string} */
function sha256(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }

/** @param {string} dir */
function clean(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
}

/** @param {string} src @param {string} dest */
function copyFile(src, dest) {
    if (!fs.existsSync(src)) { console.warn(`[skip] ${src} not found`); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

/** @param {string} distDir @param {{in: string, out?: string}[]} files @param {{in: string, out?: string}[]} folders */
function copyAssets(distDir, files, folders) {
    for (const file of files)
        copyFile(path.join(rootFolder, file.in), path.join(distDir, file.out || file.in));
    for (const folder of folders) {
        const src = path.join(rootFolder, folder.in);
        const dest = path.join(distDir, folder.out || folder.in);
        if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
        else console.warn(`[skip] ${src} not found`);
    }
}

/** @param {string} distDir @param {string} zipPath @param {boolean} [flat] @returns {Promise<void>} */
function createZip(distDir, zipPath, flat = false) {
    return new Promise((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => { console.log(`✓ ${path.basename(zipPath)} (${(archive.pointer() / 1024 / 1024).toFixed(1)}MB)`); resolve(); });
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(path.resolve(distDir), flat ? false : path.basename(distDir));
        archive.finalize();
    });
}

// ---- BUILD -------------------------------------------------------------------------
async function main() {
    clean(RESOURCES_DIST);

    // --- resources.zip ---
    console.log('\n[resources] copying source files...');
    copyAssets(RESOURCES_DIST, RESOURCES_FILES, RESOURCES_FOLDERS);

    // Copy node_modules excluding devDeps
    console.log('[resources] copying node_modules (prod only)...');
    fs.mkdirSync(NM_DIST, { recursive: true });
    for (const pkg of fs.readdirSync(NM_SRC)) {
        if (DEV_DEPS.includes(pkg)) { console.log(`  [skip] ${pkg}`); continue; }
        fs.cpSync(path.join(NM_SRC, pkg), path.join(NM_DIST, pkg), { recursive: true });
    }

    // Generate manifest.json
    const resourcesZipPath = path.join(RELEASE_DIR, 'resources.zip');
    await createZip(RESOURCES_DIST, resourcesZipPath, true);
    const manifest = {
        version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
        resourcesChecksum: sha256(resourcesZipPath),
    };
    fs.writeFileSync(path.join(RELEASE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`✓ manifest.json (version ${manifest.version})`);

    // --- contrast.zip ---
    console.log('\n[contrast] adding app files to dist...');
    copyAssets(RESOURCES_DIST, CONTRAST_CLIENT_FILES, []);

    await createZip(RESOURCES_DIST, path.join(RELEASE_DIR, 'contrast.zip'), true);

    console.log('\n✓ Release build completed');
    console.log(`  Upload to GitHub release: release/contrast.zip, release/resources.zip, release/manifest.json`);
}

main().catch(e => console.error('[build-release] fatal:', e));