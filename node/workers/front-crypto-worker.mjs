// front-crypto-worker.mjs
// Runs in a Worker thread - imports hive-p2p and does the heavy lifting.
// Adjust the import path to match your project layout (web vs extension).
import { Argon2Unified, xchacha20poly1305, randomBytes, Converter }
    from '../../hive-p2p.min.js';

const argon2    = new Argon2Unified();
const converter = new Converter();

// --- helpers ---

async function cipher(data, password) {
    const salt    = randomBytes(32);
    const saltStr = converter.bytesToHex(salt);
    const a       = await argon2.hash(password, saltStr, 128 * 1024, 2, 2, 2, 32);
    if (!a) throw new Error('Argon2 hashing failed');

    const nonce      = randomBytes(24);
    const cipherData = xchacha20poly1305(a.hash, nonce).encrypt(data);

    const blob = new Uint8Array(32 + 24 + cipherData.length);
    blob.set(salt, 0);
    blob.set(nonce, 32);
    blob.set(cipherData, 56);
    return blob;
}

async function decipher(blob, password) {
    const salt       = blob.slice(0, 32);
    const nonce      = blob.slice(32, 56);
    const cipherData = blob.slice(56);

    const saltStr  = converter.bytesToHex(salt);
    const a        = await argon2.hash(password, saltStr, 128 * 1024, 2, 2, 2, 32);
    if (!a) throw new Error('Argon2 hashing failed');

    const decrypted = xchacha20poly1305(a.hash, nonce).decrypt(cipherData);
    if (!decrypted) throw new Error('Decryption failed — wrong password or corrupted data.');
    return decrypted;
}

// --- message dispatcher ---

self.onmessage = async ({ data: { id, op, payload } }) => {
    try {
        let result;
        if (op === 'cipher')   result = await cipher(payload.data, payload.password);
        if (op === 'decipher') result = await decipher(payload.blob, payload.password);

        // Transfer the underlying buffer — zero-copy back to the main thread
        self.postMessage({ id, result }, [result.buffer]);
    } catch (error) {
        self.postMessage({ id, error: error.message });
    }
};
