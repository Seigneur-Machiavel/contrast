@echo off
echo Nettoyage en cours...

if exist "blocks" (
    rmdir /s /q "blocks"
    echo Dossier "blocks" supprime.
) else (
    echo Dossier "blocks" introuvable.
)

if exist "blocks-info" (
    rmdir /s /q "blocks-info"
    echo Dossier "blocks-info" supprime.
) else (
    echo Dossier "blocks-info" introuvable.
)

if exist "json-blocks" (
    rmdir /s /q "json-blocks"
    echo Dossier "json-blocks" supprime.
) else (
    echo Dossier "json-blocks" introuvable.
)

if exist "trash" (
    rmdir /s /q "trash"
    echo Dossier "trash" supprime.
) else (
    echo Dossier "trash" introuvable.
)

if exist "snapshots" (
    rmdir /s /q "snapshots"
    echo Dossier "snapshots" supprime.
) else (
    echo Dossier "snapshots" introuvable.
)

if exist "addresses-txs-refs" (
    rmdir /s /q "addresses-txs-refs"
    echo Dossier "addresses-txs-refs" supprime.
) else (
    echo Dossier "addresses-txs-refs" introuvable.
)

if exist "AddressesTxsRefsStorage_config.json" (
    del /q "AddressesTxsRefsStorage_config.json"
    echo Fichier "AddressesTxsRefsStorage_config.json" supprime.
) else (
    echo Fichier "AddressesTxsRefsStorage_config.json" introuvable.
)

echo Nettoyage termine.
pause