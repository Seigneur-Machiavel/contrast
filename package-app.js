const fs = require('fs');
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
});