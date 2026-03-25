// @ts-check
// Ledger storage architecture benchmark
// Compares dir/file layout strategies for address ledger files on NTFS.
//
// cold_ms = dir creation + file write (new addresses)
// warm_ms = read + rewrite (existing addresses, no mkdirSync overhead)
//
// Lower is better. Focus on cold for initial sync, warm for steady-state.
// Run multiple times — first run may be skewed by FS cache warmup.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dir, 'test-results');
const BASE_DIR = path.join(__dir, '.bench-tmp');
if (fs.existsSync(BASE_DIR)) fs.rmSync(BASE_DIR, { recursive: true });

// Base58 charset (no 0, O, I, l)
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Generate N fake 7-char Base58 addresses with C prefix @param {number} n */
function generateAddresses(n) {
    const addrs = [];
    for (let i = 0; i < n; i++) {
        let addr = 'C';
        for (let j = 0; j < 6; j++) addr += BASE58[Math.floor(Math.random() * 58)];
        addrs.push(addr);
    }
    return addrs;
}

/** Fake ledger binary payload (26 bytes header, no UTXOs) */
//const DUMMY_PAYLOAD = Buffer.alloc(26, 0xAB);

/** Fake ledger binary payload (26 bytes header + 100KB of dummy UTXOs) */
const DUMMY_PAYLOAD = Buffer.alloc(100_000, 0xAB); // 100KB

// ─── ARCHITECTURES ───────────────────────────────────────────────────────────

/** A: current — C3/x7/C3x7f2a.bin */
const archA = {
    label: 'A: C3/x7/C3x7f2a.bin (current)',
    dir:   /** @param {string} addr */ (addr) => path.join(BASE_DIR, 'A', addr.slice(0, 2), addr.slice(2, 4)),
    file:  /** @param {string} addr @param {string} dir */ (addr, dir) => path.join(dir, `${addr}.bin`),
};

/** B: proposed — C/12/34/56.bin */
const archB = {
    label: 'B: C/12/34/56.bin',
    dir:   /** @param {string} addr */ (addr) => path.join(BASE_DIR, 'B', addr[0], addr.slice(1, 3), addr.slice(3, 5)),
    file:  /** @param {string} addr @param {string} dir */ (addr, dir) => path.join(dir, `${addr.slice(5)}.bin`),
};

/** C: flat+shard — C/12/3456.bin */
const archC = {
    label: 'C: C/12/3456.bin',
    dir:   /** @param {string} addr */ (addr) => path.join(BASE_DIR, 'C', addr[0], addr.slice(1, 3)),
    file:  /** @param {string} addr @param {string} dir */ (addr, dir) => path.join(dir, `${addr.slice(3)}.bin`),
};

/** D: 4-char shard — C123/456.bin */
const archD = {
    label: 'D: C123/456.bin',
    dir:   /** @param {string} addr */ (addr) => path.join(BASE_DIR, 'D', addr.slice(0, 4)),
    file:  /** @param {string} addr @param {string} dir */ (addr, dir) => path.join(dir, `${addr.slice(4)}.bin`),
};

const ARCHS = [archA, archB, archC, archD];

// ─── BENCH RUNNERS ───────────────────────────────────────────────────────────

/** Cold sync @param {object} arch @param {string[]} addresses */
function benchCold(arch, addresses) {
    const start = performance.now();
    for (const addr of addresses) { // @ts-ignore
        const dir = arch.dir(addr);
        fs.mkdirSync(dir, { recursive: true }); // @ts-ignore
        fs.writeFileSync(arch.file(addr, dir), DUMMY_PAYLOAD);
    }
    return performance.now() - start;
}

/** Warm sync @param {object} arch @param {string[]} addresses */
function benchWarm(arch, addresses) {
    const start = performance.now();
    for (const addr of addresses) { // @ts-ignore
        const dir = arch.dir(addr); // @ts-ignore
        const file = arch.file(addr, dir);
        const _ = fs.readFileSync(file);
        fs.writeFileSync(file, DUMMY_PAYLOAD);
    }
    return performance.now() - start;
}

/** Cold async — parallel @param {object} arch @param {string[]} addresses */
async function benchColdAsync(arch, addresses) {
    const start = performance.now();
    await Promise.all(addresses.map(async addr => { // @ts-ignore
        const dir = arch.dir(addr);
        await fs.promises.mkdir(dir, { recursive: true }); // @ts-ignore
        await fs.promises.writeFile(arch.file(addr, dir), DUMMY_PAYLOAD);
    }));
    return performance.now() - start;
}

/** Warm async — parallel @param {object} arch @param {string[]} addresses */
async function benchWarmAsync(arch, addresses) {
    const start = performance.now();
    await Promise.all(addresses.map(async addr => { // @ts-ignore
        const dir = arch.dir(addr); // @ts-ignore
        const file = arch.file(addr, dir);
        await fs.promises.readFile(file);
        await fs.promises.writeFile(file, DUMMY_PAYLOAD);
    }));
    return performance.now() - start;
}

/** Cleanup a single arch temp dir @param {object} arch */
function cleanup(arch) { // @ts-ignore
    const dir = path.join(BASE_DIR, arch.label[0]);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const COUNTS = [100, 1000, 5000];
const results = [];

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(BASE_DIR,    { recursive: true });

for (const n of COUNTS) {
    console.log(`\n── N = ${n} ──────────────────────────`);
    const addresses = generateAddresses(n);

    for (const arch of ARCHS) {
        // SYNC
        cleanup(arch);
        const cold      = benchCold(arch, addresses);
        const warm      = benchWarm(arch, addresses);

        // ASYNC
        cleanup(arch);
        const coldAsync = await benchColdAsync(arch, addresses);
        const warmAsync = await benchWarmAsync(arch, addresses);

        const row = { n, arch: arch.label,
            sync_cold_ms:  +cold.toFixed(2),       sync_warm_ms:  +warm.toFixed(2),
            async_cold_ms: +coldAsync.toFixed(2),   async_warm_ms: +warmAsync.toFixed(2),
        };
        results.push(row);
        console.log(`${arch.label}`);
        console.log(`  sync  — cold: ${cold.toFixed(2)}ms  |  warm: ${warm.toFixed(2)}ms`);
        console.log(`  async — cold: ${coldAsync.toFixed(2)}ms  |  warm: ${warmAsync.toFixed(2)}ms`);
    }
}

// ─── SAVE RESULTS ─────────────────────────────────────────────────────────────

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(RESULTS_DIR, `bench-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nResults saved to: ${outPath}`);