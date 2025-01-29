import fs from 'fs';
import path from 'path';
import { compressFiles, copyFiles } from '../utils/compressor.mjs';

const __dirname = path.resolve();
const DESTINATION = path.resolve(__dirname, 'dist(do not modify)'); // destination folder of contrast files
if (!fs.existsSync(DESTINATION)) fs.mkdirSync(DESTINATION);

// extract version in manifest.json
const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'manifest.json')).toString()).version;

// list of files/folder paths to copy from src to dist
// first element of operation array is the source path
// (optionnal) any other elements are the subfolders to fill in the destination folder
/** @type {Array<[string[]]>} */
const COPY_OPERATIONS = [
    ['../node/front/explorerScript.mjs', 'node', 'front'],
    ['../node/front/explorerScript.mjs', 'node', 'front'],
    ['../node/front/explorerWidget.css', 'node', 'front'],
    ['../node/front/img', 'node', 'front'],

    ['../node/src/transaction.mjs', 'node', 'src'],
    ['../node/src/conCrypto.mjs', 'node', 'src'],
    ['../node/src/block-classes.mjs', 'node', 'src'],
    ['../node/src/wallet.mjs', 'node', 'src'],
    ['../node/src/validations-classes.mjs', 'node', 'src'],

    ['../node/workers/workers-classes.mjs', 'node', 'workers'],
    ['../node/workers/account-worker-front.js', 'node', 'workers'],
    
    ['../libs/anime.min.js', 'libs'],
    ['../libs/xxhash32.mjs', 'libs'],
    ['../libs/msgpack.min.js', 'libs'],
    ['../libs/noble-ed25519-03-2024.mjs', 'libs'],
    ['../libs/argon2-ES6.min.mjs', 'libs'],
    
    ['../utils/addressUtils.mjs', 'utils'],
    ['../utils/blockchain-settings.mjs', 'utils'],
    ['../utils/converters.mjs', 'utils'],
    ['../utils/type-validation.mjs', 'utils'],
    ['../utils/conditionnals.mjs', 'utils'],
    ['../utils/serializer.mjs', 'utils'],
    ['../utils/cryptoLight.js', 'utils'],
    ['../utils/mining-functions.mjs', 'utils'],
    ['../utils/utxo-rules.mjs', 'utils'],
    ['../utils/progress-logger.mjs', 'utils'],

    //['../miniLogger/mini-logger.mjs', 'miniLogger'],
    ['../fonts/vertopal.com_Contrast V0.89.ttf', 'fonts'],
];

// list of files/folder to ignore in the compression process
const IGNORED = [
    'build.js',
    'build.bat',
    'contrast-wallet.zip',
    'mjiipclahahbedeiifgpfoagmncdcnoj.crx'
];

function copyFolderRecursive(src, dest) {
    const destFolder = path.resolve(dest, path.basename(src));
    fs.mkdirSync(destFolder, { recursive: true });
    fs.readdirSync(src).forEach(file => {
        if (fs.lstatSync(path.resolve(src, file)).isDirectory()) {
            copyFolderRecursive(path.resolve(src, file), destFolder);
        } else {
            fs.copyFileSync(path.resolve(src, file), path.resolve(destFolder, file));
            console.log(`Copied ${file} to ${path.resolve(destFolder, file)}`);
        }
    });
    console.log(`Copied folder ${src} to ${dest}`);
}
// execute the copy operations
for (const operation of COPY_OPERATIONS) {
    const src = path.resolve(__dirname, operation.shift());
    if (!fs.existsSync(src)) { console.error(`File/folder not found: ${src}`); continue; }

    let dest = DESTINATION;
    if (operation.length) { // create subfolders if needed
        for (const folder of operation) {
            dest = path.resolve(dest, folder);
            if (!fs.existsSync(dest)) fs.mkdirSync(dest);
        }
    }

    if (fs.lstatSync(src).isDirectory()) {
        copyFolderRecursive(src, dest);
    } else {
        fs.copyFileSync(src, path.resolve(dest, path.basename(src)));
        console.log(`Copied ${src} to ${DESTINATION}`);
    }
}

// Compression of the build into a zip archive
const files = [];
const folders = [];
for (const file of fs.readdirSync(__dirname)) {
    if (IGNORED.includes(file)) continue;
    const filePath = path.resolve(__dirname, file);
    
    if (fs.lstatSync(filePath).isDirectory()) {
        folders.push({ path: filePath, name: file });
    } else {
        files.push({ path: filePath, name: file });
    }
}

console.log(files)
console.log(folders)

compressFiles(path.resolve(__dirname, 'builds', version, 'contrast-wallet.zip'), files, folders);
copyFiles(path.resolve(__dirname, 'builds', version, 'contrast-wallet'), files, folders);