import { Worker } from 'worker_threads';
import fs from 'fs';
import archiver from 'archiver';

/**
 * @typedef {Object} File
 * @property {string} path - The path to the file to compress
 * @property {string} name - The name of the file in the archive
 *
 * @typedef {Object} Directory
 * @property {string} path - The path to the directory to compress
 * @property {string} name - The name of the directory in the archive
 */

/**
 * Compress files and directories into a zip archive using a worker thread.
 * @param {string} outputPath - The path to the output archive
 * @param {File[]} files - The list of files to compress
 * @param {Directory[]} directories - The list of directories to compress
 */
export function compressWithWorker(outputPath, files, directories) {
    const worker = new Worker('./compressorWorker.js');
    worker.postMessage({ outputPath, files, directories });
    worker.on('message', (message) => { console.log(`Compression accomplished. Archive size: ${message.size} bytes`); });
    worker.on('error', (err) => { console.error(err); });
    worker.on('exit', (code) => { if (code !== 0) { console.error(`Worker stopped with code ${code}`); } });
}
export function compressFiles(outputPath, files, directories) {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', err => { throw err; });
    archive.pipe(output);

    files.forEach(file => { archive.file(file.path, { name: file.name }); });
    directories.forEach(directory => { archive.directory(directory.path, directory.name); });

    archive.finalize();
    return archive.pointer();
}
// Doing the same without compression, just copy files and directories to a destination folder
export function copyFiles(outputPath, files, directories) {
    if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });

    files.forEach(file => { fs.copyFileSync(file.path, `${outputPath}/${file.name}`); });
    directories.forEach(directory => { fs.mkdirSync(`${outputPath}/${directory.name}`, { recursive: true }); });
}
// example of use
//compressWithWorker('path/to/myArchive.zip', [{ path: 'path/to/myFile1.txt', name: 'myFile1.txt' }], [{ path: 'path/to/myFolder/', name: 'folderNameInArchive' }]);