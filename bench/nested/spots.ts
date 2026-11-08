/**
 * The spots issue #47 measures: the round's target T (and its smaller sibling
 * T₀) on AsKh7d and Ks9s4s, and blueprints that keep T's flop betting but
 * simplify the turn and river.
 */

import type { Precision, SpotConfig } from '../../src/index.ts';

const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

export const BOARDS = { rainbow: 'As Kh 7d', monotone: 'Ks 9s 4s' } as const;
export type BoardName = keyof typeof BOARDS;

const base = (board: BoardName): Pick<SpotConfig, 'board' | 'pot' | 'stack' | 'oop' | 'ip'> => ({
	board: BOARDS[board],
	pot: 55,
	stack: 975,
	oop: OOP,
	ip: IP,
});

const SIZES = [0.33, 0.75, 1.5];

/** T: three sizes, a 0.75 raise, all-in, three aggressions, every street. */
export function target(board: BoardName): SpotConfig {
	return {
		...base(board),
		betSizes: [SIZES],
		raiseSizes: [[0.75]],
		allowAllIn: true,
		maxRaises: 3,
		maxBytes: 64 * 2 ** 30,
	};
}

/** T₀: three sizes, all-in as the only raise, two aggressions. */
export function small(board: BoardName): SpotConfig {
	return {
		...base(board),
		betSizes: [SIZES],
		raiseSizes: ['allin'],
		allowAllIn: true,
		maxRaises: 2,
		maxBytes: 64 * 2 ** 30,
	};
}

/** Turn and river betting of a blueprint. */
export interface Later {
	readonly sizes: readonly number[];
	/** Aggressions per turn and river round; 1 is a bet and no raise. */
	readonly maxRaises: number;
	/** Raise sizes when maxRaises > 1: all-in only, or the bet sizes. */
	readonly raise?: 'allin' | 'sizes';
	readonly allowAllIn?: boolean;
}

/**
 * A blueprint of `full`: the same flop betting, the turn and river simplified.
 */
export function blueprint(full: SpotConfig, later: Later): SpotConfig {
	const given = full.raiseSizes as readonly unknown[];
	const flopRaise = Array.isArray(given[0]) ? given[0] : given;
	const laterRaise = later.raise === 'allin' ? ['allin'] : later.sizes;
	return {
		...full,
		betSizes: [SIZES, later.sizes, later.sizes],
		raiseSizes: [flopRaise, laterRaise, laterRaise] as SpotConfig['raiseSizes'],
		maxRaises: [full.maxRaises as number, later.maxRaises, later.maxRaises],
		allowAllIn: [true, later.allowAllIn ?? false, later.allowAllIn ?? false],
	};
}

/** Turn cards sampled on each board: a blank, a broadway card, a pairing or flush card. */
export const TURNS: Record<BoardName, readonly string[]> = {
	rainbow: ['2c', 'Qs', '7c'],
	monotone: ['2h', 'Qd', 'As'],
};

/** The blueprints measured: turn and river betting, runout buckets, storage. */
export const VARIANTS: Record<string, { later: Later; buckets?: number; precision?: Precision }> = {
	'1size': { later: { sizes: [0.75], maxRaises: 1 } },
	'1size-b3': { later: { sizes: [0.75], maxRaises: 1 }, buckets: 3 },
	'1size-i16': { later: { sizes: [0.75], maxRaises: 1 }, precision: 'i16' },
	'1size-b3-i16': { later: { sizes: [0.75], maxRaises: 1 }, buckets: 3, precision: 'i16' },
	'1size-allin': { later: { sizes: [0.75], maxRaises: 1, allowAllIn: true } },
	'2size': { later: { sizes: [0.33, 1.5], maxRaises: 1 } },
	'2size-i16': { later: { sizes: [0.33, 1.5], maxRaises: 1 }, precision: 'i16' },
	'2size-b3-i16': { later: { sizes: [0.33, 1.5], maxRaises: 1 }, buckets: 3, precision: 'i16' },
	'3size-b3-i16': { later: { sizes: [0.33, 0.75, 1.5], maxRaises: 1 }, buckets: 3, precision: 'i16' },
};
