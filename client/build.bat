@echo off
cd %~dp0
echo [build] Generating blobs...
node --experimental-sea-config sea-config.json

echo [build] Copying node.exe...
node -e "require('fs').copyFileSync(process.execPath, 'pink_acevo_modding.exe')"

echo [build] Injecting blobs...
npx postject pink_acevo_modding.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

echo [build] Done.
pause