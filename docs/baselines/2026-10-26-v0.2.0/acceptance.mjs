import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { normalizeLabel } = await import(pathToFileURL(process.argv[2]));
let checks = 0;
for (const [input, expected] of [
 ['  HeLLo  ', 'hello'], ['A   B', 'a b'], [' A\t\tB\nC\r\nD ', 'a b c d'],
 ['', ''], [' \t\n\r ', ''], ['A\u00a0\u2003B', 'a b'], ['\uFEFFA\uFEFF', 'a'],
 ['A-B_C.42', 'a-b_c.42'], ['A\u200bB', 'a\u200bb']
]) { assert.equal(normalizeLabel(input), expected); checks++; }
for (const input of [null, undefined, 42, true, {}, [], new String('A'), {trim: () => 'A'}]) {
 assert.throws(() => normalizeLabel(input), TypeError); checks++;
}
console.log(JSON.stringify({ok:true,checks}));
