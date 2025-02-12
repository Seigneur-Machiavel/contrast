// CLEAR STORAGE V2
const fs = await import('fs');
const path = await import('path');
import { PATH } from './utils/storage-manager.mjs';

const dirPaths = [
    PATH.BLOCKS,
    PATH.BLOCKS_INFO,
    PATH.JSON_BLOCKS,
    PATH.TRASH,
    PATH.SNAPSHOTS,
    PATH.TXS_REFS,
    PATH.CHECKPOINTS,
    path.join(PATH.STORAGE, 'ACTIVE_CHECKPOINT'),
    PATH.TEST_STORAGE
];

const filePaths = [
    path.join(PATH.STORAGE, 'AddressesTxsRefsStorage_config.json'),
    path.join(PATH.STORAGE, 'passHash.bin'),
    path.join(PATH.STORAGE, 'nodeSetting.bin')
];

for (const dirPath of dirPaths) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true });
        console.log(`${dirPath} removed.`);
    }
}

for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`${filePath} removed.`);
    }
}

console.log('Cleaning achieved, closing in 5sec...');
await new Promise(resolve => setTimeout(resolve, 5000)).then(() => process.exit(0));