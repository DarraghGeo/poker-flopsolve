/**
 * Spots and combinations for issue #102: the round's target T and its
 * smaller sibling T₀ on As Kh 7d (the #51 spots, `bench/adaptive/spots.ts`),
 * and the memory levers that can be stacked on them.
 */

import type { SolveOptions, SpotConfig } from '../../src/index.ts';
import { wasmStorage } from '../../src/wasm-storage.ts';
import { spotOn } from '../adaptive/spots.ts';
import { TREES } from '../adaptive/trees.ts';

export const SPOTS: Record<string, SpotConfig> = {
	T: spotOn('rainbow', TREES.T),
	T0: spotOn('rainbow', TREES.T0),
	Tmono: spotOn('monotone', TREES.T),
	T0mono: spotOn('monotone', TREES.T0),
};

/**
 * A combination named by `+`-joined levers:
 * - `thin`: `thinSizes`;
 * - `share`: river `shareHistories` (`share1` from the turn);
 * - `i16`: 16-bit storage; `compact`: `compactStorage` with sums;
 * - `b3`: `runoutBuckets: 3`;
 * - `sample`: `chanceSampling` at its defaults;
 * - `js`: the JavaScript engine instead of WebAssembly.
 * 16-bit and compact storage run on the WebAssembly engine (`wasmStorage`).
 */
export function combination(name: string): { config: Partial<SpotConfig>; options: SolveOptions } {
	const levers = name.split('+');
	const known = new Set(['exact', 'thin', 'share', 'share1', 'i16', 'compact', 'b3', 'sample', 'js']);
	for (const lever of levers) if (!known.has(lever)) throw new Error(`unknown lever ${lever}`);
	const has = (lever: string): boolean => levers.includes(lever);
	const config: Partial<SpotConfig> = {
		...(has('thin') ? { thinSizes: true } : {}),
		...(has('share') ? { shareHistories: true } : {}),
		...(has('share1') ? { shareHistories: { fromRound: 1 } } : {}),
		...(has('compact') ? { compactStorage: {} } : {}),
		...(has('b3') ? { runoutBuckets: 3 } : {}),
	};
	const options: SolveOptions = {
		...(has('i16') ? { precision: 'i16' } : {}),
		...(has('js') ? { engine: 'js' } : (has('i16') || has('compact')) ? { wasmStorage } : {}),
		...(has('sample') ? { approximations: { chanceSampling: {} } } : {}),
	};
	return { config, options };
}
