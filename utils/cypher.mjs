/**
 * Encrypt/decrypt data using Argon2id + AES-256-GCM.
 * Storage format (concatenated Buffer → Base64):
 *   [32 bytes salt][12 bytes iv][...ciphertext][16 bytes auth tag] */

import { Argon2Unified } from "hive-p2p";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SALT_LEN = 32;
const IV_LEN   = 12; // 96-bit IV, GCM standard
const TAG_LEN  = 16; // AES-GCM auth tag
const KEY_LEN  = 32; // AES-256

const argon2 = new Argon2Unified();

/** @param {string} hex @returns {Buffer} */
const hexToBuffer = hex => Buffer.from(hex, 'hex');

/** @param {Buffer} b @returns {string} */
const toBase64 = b => b.toString('base64');

/** @param {string} s @returns {Buffer} */
const fromBase64 = s => Buffer.from(s, 'base64');

/** Derive a 256-bit key from password + salt using Argon2id.
 * @param {string} password
 * @param {Buffer} salt       - 32 raw bytes
 * @returns {Promise<Buffer>} */
const deriveKey = async (password, salt) => {
    // Argon2Unified expects hex string as salt on Node (wraps with Buffer.from internally)
    const result = await argon2.hash(password, salt.toString('hex'), 2 ** 16, 3, 1, 2, KEY_LEN);
    if (!result) throw new Error('Argon2 hashing failed');
    return Buffer.from(result.hash); // result.hash is already Uint8Array
};

// -- Public API ---------------------------------------------------------------

/** Encrypt data with a password.
 * @param {string} hex - Hex-encoded data to cypher (e.g. private key)
 * @param {string} password
 * @returns {Promise<string>} Base64 blob (salt + iv + ciphertext + tag) */
export const encrypt = async (hex, password) => {
    const salt   = randomBytes(SALT_LEN);
    const iv     = randomBytes(IV_LEN);
    const key    = await deriveKey(password, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    const ct  = Buffer.concat([cipher.update(hexToBuffer(hex)), cipher.final()]);
    const tag = cipher.getAuthTag(); // 16 bytes, appended for format parity with WebCrypto

    return toBase64(Buffer.concat([salt, iv, ct, tag]));
};

/** Decrypt data with a password.
 * @param {string} blob     - Base64 blob from encryption
 * @param {string} password */
export const decrypt = async (blob, password) => {
    const raw  = fromBase64(blob);
    const salt = raw.subarray(0, SALT_LEN);
    const iv   = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag  = raw.subarray(raw.length - TAG_LEN);
    const ct   = raw.subarray(SALT_LEN + IV_LEN, raw.length - TAG_LEN);
    const key  = await deriveKey(password, salt);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('hex');
};