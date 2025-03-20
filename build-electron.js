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
    publish: [{ provider: "github", owner: "Seigneur-Machiavel", repo: "contrast" }],
    productName: 'Contrast',
    buildVersion: version,
    directories: { output: 'dist' },
    win: {
      target: 'nsis',
      icon: 'electron-app/img/icon.ico',
      artifactName: `Contrast-Setup-${version}.exe`,
      certificateSubjectName: "Open Source Developer, Guillaume Bisiaux"
    },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
    asar: true,
    asarUnpack: [
      "miniLogger/*",
      "utils/clear.js",
      "utils/clear-storage.bat"
    ],
    files
  }
}).then(() => {
  console.log('Packaging done');
}).catch(err => {
  console.error('Error during packaging:', err);
});