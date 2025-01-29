/*const fs = require('fs');
const packager = require('electron-packager');
const ignorePatterns = fs.readFileSync('.gitignore', 'utf-8')
  .split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('#'))
  .map(line => line.replace('\r', ''));

packager({
  dir: '.',
  out: 'release-builds',
  platform: 'win32',
  arch: 'x64',
  ignore: ignorePatterns
}).then(packages => {
  console.log('Packaging done:', packages);
}).catch(err => {
  console.error('Error during packaging:', err);
});*/

// UPDATED WITH electron-builder
//process.env.DEBUG = 'electron-builder';
const fs = require('fs');
const version = JSON.parse(fs.readFileSync('package.json')).version;
console.log('Building version:', version);

const builder = require('electron-builder');
const files = ["**/*"]
const ignorePatterns = fs.readFileSync('.gitignore', 'utf-8')
  .split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('#'))
  .map(line => line.replace('\r', ''));

for (const pattern of ignorePatterns) {
  // exceptions: node_modules
  if (pattern === 'node_modules') continue;
  files.push(`!${pattern}`);
}

// Manual ignore
files.push('!wallet-plugin');

builder.build({
  config: {
    appId: 'science.contrast',
    publish: [
      { provider: "github", owner: "Seigneur-Machiavel", repo: "contrast" }
    ],
    productName: 'Contrast',
    buildVersion: version,
    directories: { output: 'release-builds' },
    win: { target: 'nsis', icon: 'img/icon.ico' },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
    asar: true,
    asarUnpack: [
      //"miniLogger/mini-logger-config-custom.json",
      "miniLogger/*",
      "node/storage/*",
      "utils/storage-manager.mjs"
    ],
    files
  }
}).then(() => {
  console.log('Packaging done');
}).catch(err => {
  console.error('Error during packaging:', err);
});