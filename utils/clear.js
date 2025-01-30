const fs = require('fs');
console.log('Cleaning...');

const directories = [
    "blocks",
    "blocks-info",
    "json-blocks",
    "trash",
    "snapshots",
    "addresses-txs-refs"
];
directories.forEach(dir => {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        console.log(`${dir} removed.`);
    }
});

const files = [
    "AddressesTxsRefsStorage_config.json"
];
files.forEach(file => {
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`${file} removed.`);
    }
});

console.log('Cleaning achieved.');