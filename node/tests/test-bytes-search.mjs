import crypto from 'crypto';

const l = 32; // pattern length
const pattern = crypto.randomBytes(l);
const creationStart = performance.now();
const bytes = crypto.randomBytes(1024 * 1024);
// replace last bytes by the pattern to ensure at least one match
for (let i = 0; i < l; i++) bytes[bytes.length - l + i] = pattern[i];
console.log('Pattern:', pattern.join(' '));
console.log('Control:', bytes.subarray(bytes.length - l, bytes.length).join(' '));
console.log(`1MB buffer generation took ${performance.now() - creationStart} ms`);

// SEARCH FOR A PATTERN (We know structure: batches of l bytes)
const search1Start = performance.now();
let [start, match] = [0, false];
let index1 = -1;
for (let i = 0; i <= bytes.length / l; i++) {
	start = i * l;
	match = true;
	for (let j = 0; j < l; j++)
		if (bytes[start + j] === pattern[j]) continue;
	else { match = false; break; }

	if (match) { index1 = start; break; };
}

console.log(`[LOOP SEARCH] Time: ${(performance.now() - search1Start).toFixed(5)} ms | Index: ${index1}`);

// Search indexOf (Optimized if we dont know the data structure)
const search2Start = performance.now();
const index2 = bytes.indexOf(pattern);
console.log(`[INDEXOF SEARCH] Time: ${(performance.now() - search2Start).toFixed(5)} ms | Index: ${index2}`);