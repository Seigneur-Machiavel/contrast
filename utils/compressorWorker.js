const { parentPort } = require('worker_threads');
const fs = require('fs');
const archiver = require('archiver');

function compressFiles(outputPath, files, directories) {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => { parentPort.postMessage({ success: true, size: archive.pointer() }); });
    archive.on('error', err => { throw err; });
    archive.pipe(output);

    files.forEach(file => { archive.file(file.path, { name: file.name }); });
    directories.forEach(directory => { archive.directory(directory.path, directory.name); });

    archive.finalize();
}

// Écouter le message du thread principal
parentPort.on('message', (message) => {
    const { outputPath, files, directories } = message;
    compressFiles(outputPath, files, directories);
});