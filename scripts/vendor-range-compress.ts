/**
 * Copy the range compressor in from its own repository.
 *
 * Purpose: `src/vendor/range-compress.js` is poker-rangecompress's
 * `dist/range-compress.js` made an ES module, without its worker pool and
 * editing session (this package calls only the synchronous `compressBoth`,
 * and has workers of its own), and indented with tabs as `npm run lint`
 * asks. Run this after that library changes:
 *
 *   node --import tsx scripts/vendor-range-compress.ts <path to poker-rangecompress>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const from = process.argv[2];
if (!from) throw new Error('Give the path to a checkout of poker-rangecompress');
let source = readFileSync(join(from, 'dist', 'range-compress.js'), 'utf8');

/** `text` without the stretch from `start` up to, not including, `end`; throws when either is missing. */
function cut(text: string, start: string, end: string): string {
	const a = text.indexOf(start);
	const b = text.indexOf(end, a);
	if (a < 0 || b < 0) throw new Error(`The library has changed: could not find "${start}" then "${end}"`);
	return text.slice(0, a) + text.slice(b);
}

// The wrapper that picks CommonJS or a global becomes a plain function.
const head = source.slice(source.indexOf('(function (root, factory) {'), source.indexOf("'use strict';") + "'use strict';".length);
source = source.replace(head, 'function factory() {');
// Workers and the editing session go; so does what the public surface says of them.
source = cut(source, '  // ------------------------------------------------------------------ parallel versions', '  return {\n    compress, compressBoth,');
const surface = source.slice(source.lastIndexOf('  return {\n    compress, compressBoth,'));
source = source.replace(surface, [
	'  return {',
	'    compress, compressBoth, blankSuitsFor, expectedFrequencyError, parseRange, rangeToString, cardFromStr, cardToStr, handToStr,',
	'    /** true if the WebAssembly kernels loaded; setWasm(false) forces the JavaScript path */',
	'    get wasm() { return !!wasm(); }, setWasm(on) { wasmOn = !!on; }, ready, releaseMemory,',
	'  };',
	'}',
	'',
	'export default factory();',
	'',
].join('\n'));
source = source.replace('/*!\n * range-compress.js', [
	'/*!',
	' * Vendored from https://github.com/DarraghGeo/poker-rangecompress (dist/range-compress.js) by',
	' * scripts/vendor-range-compress.ts: an ES module, single-threaded. Do not edit here.',
	' *',
	' * range-compress.js',
].join('\n'));

// Two spaces a level become tabs; a doc comment's continuation keeps its one space.
const lines = source.split('\n').map((line) => {
	const spaces = /^ */.exec(line)![0].length;
	return ('\t'.repeat(spaces >> 1) + (spaces & 1 ? ' ' : '') + line.slice(spaces)).trimEnd();
});
const out = fileURLToPath(new URL('../src/vendor/range-compress.js', import.meta.url));
writeFileSync(out, `${lines.join('\n').trimEnd()}\n`);
console.log(`${out}: ${lines.length} lines`);
