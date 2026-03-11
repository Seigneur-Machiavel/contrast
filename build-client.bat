@echo off
echo [build] Generating blobs...
node --experimental-sea-config client/sea-config.json

echo [build] Copying node.exe...
node -e "require('fs').copyFileSync(process.execPath, 'client/contrast.exe')"

echo [build] Injecting blobs...
npx postject client/contrast.exe NODE_SEA_BLOB client/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

echo [build] Done.