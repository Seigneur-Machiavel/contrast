@echo off
echo [build] Generating blobs...
node --experimental-sea-config build/sea-config-launcher.json

echo [build] Copying node.exe...
node -e "require('fs').copyFileSync(process.execPath, 'build/launcher.exe')"

echo [build] Injecting blobs...
npx postject build/launcher.exe NODE_SEA_BLOB build/sea-prep-launcher.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

echo [build] Done.