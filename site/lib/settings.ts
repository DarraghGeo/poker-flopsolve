/**
 * The benchmark page's settings: what the form holds, the spot it makes, and
 * the shareable link that carries it.
 *
 * Purpose: one checked place for the page's choices, so a link someone edits
 * by hand can only ever load a valid spot (a bad field falls back to its
 * default).
 */

import { formatCards, parseCards } from '../../src/cards.ts';
import type { SpotConfig } from '../../src/index.ts';
import { parseRange } from '../../src/range.ts';
import { RANGE_PRESETS } from './ranges.ts';

/** Bet sizes offered, pot fractions on every street; any mix of them. */
export const BET_SIZES = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.5, 2] as const;

/** Raise sizes offered, multiples of the bet faced; none picked raises with the bet sizes. */
export const RAISE_SIZES = [2, 2.5, 3, 4, 5] as const;

/** At most this many bet sizes, and as many raise sizes: each one multiplies the work. */
export const MAX_SIZES = 4;

/** Raises after the opening bet, per street. */
export const MAX_RAISES = 3;

/** The bet size menus of links made before sizes could be mixed freely. */
const LEGACY_SIZES: Record<string, readonly number[]> = {
	small: [0.33],
	one: [0.66],
	large: [1],
	two: [0.33, 0.75],
};

/** Targets offered, % of pot. */
export const TARGETS = [2, 1, 0.5, 0.3] as const;

/** Memory caps offered, MiB; 0 picks one for the device. */
export const MEMORY_CAPS = [0, 512, 1024, 2048] as const;

/** Exact solves the whole game; Lite a simplified one, for big flops. */
export type Mode = 'exact' | 'lite';

/** Iteration cap, should the target never come. */
export const ITERATION_CAP = 2000;

/** Everything the form sets. */
export interface Settings {
	/** Three to five cards, space separated. */
	readonly board: string;
	readonly oop: string;
	readonly ip: string;
	/** In big blinds. */
	readonly pot: number;
	/** Effective stack behind, big blinds. */
	readonly stack: number;
	/** Bet sizes, pot fractions from `BET_SIZES`, ascending, one to `MAX_SIZES`. */
	readonly bets: readonly number[];
	/** Raises allowed after the opening bet, 0 to `MAX_RAISES`. */
	readonly raises: number;
	/** Raise sizes, multiples from `RAISE_SIZES`, ascending; empty raises with the bet sizes. */
	readonly raiseSizes: readonly number[];
	readonly allIn: boolean;
	/** Stop at this exploitability, % of pot. */
	readonly target: number;
	/** Threads; 0 for every core. */
	readonly threads: number;
	readonly mode: Mode;
	/** Memory cap, MiB; 0 for the device's own (`autoMemory`). */
	readonly memory: number;
}

const preset = (name: string): string => RANGE_PRESETS.find((p) => p.name === name)!.range;

/** BTN open against a BB defend on a dry king-high flop, one size. */
export const DEFAULT_SETTINGS: Settings = {
	board: 'Ks 9d 4c',
	oop: preset('BB defend'),
	ip: preset('BTN open'),
	pot: 5.5,
	stack: 97.5,
	bets: [0.66],
	raises: 0,
	raiseSizes: [],
	allIn: false,
	target: 0.5,
	threads: 0,
	mode: 'exact',
	memory: 0,
};

/**
 * A memory cap for this device, MiB: 2 GiB where it reports 8 GB or more,
 * 512 MiB on phones or devices reporting under 4 GB, else 1 GiB.
 */
export function autoMemory(device: { deviceMemory: number | undefined; mobile: boolean }): number {
	if (device.mobile) return 512;
	if (device.deviceMemory === undefined) return 1024;
	return device.deviceMemory >= 8 ? 2048 : device.deviceMemory >= 4 ? 1024 : 512;
}

/** The memory cap a solve uses, MiB. */
export function memoryOf(settings: Settings, auto: number): number {
	return settings.memory > 0 ? settings.memory : auto;
}

/** The solver's spot for these settings, under `auto` MiB when the memory is the device's. */
export function configOf(settings: Settings, auto = 512): SpotConfig {
	return {
		maxBytes: memoryOf(settings, auto) * 2 ** 20,
		board: settings.board,
		pot: settings.pot,
		stack: settings.stack,
		oop: settings.oop,
		ip: settings.ip,
		betSizes: [[...settings.bets]],
		raiseSizes: settings.raises > 0 && settings.raiseSizes.length > 0 ? settings.raiseSizes.map((times) => ({ times })) : undefined,
		maxRaises: 1 + settings.raises,
		allowAllIn: settings.allIn,
	};
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** The betting in plain words, e.g. "33% + 75% pot, 1 raise of 3×, all-in". */
export function bettingLabel(settings: Settings): string {
	let text = `${settings.bets.map(percent).join(' + ')} pot`;
	if (settings.raises > 0) {
		text += `, ${settings.raises} raise${settings.raises === 1 ? '' : 's'}`;
		if (settings.raiseSizes.length > 0) text += ` of ${settings.raiseSizes.map((x) => `${x}×`).join(' or ')}`;
	}
	if (settings.allIn) text += ', all-in';
	return text;
}

/**
 * Sizes from a link's comma list, ascending without repeats, or null unless
 * every one is offered and there are `min` to `MAX_SIZES` of them.
 */
function sizeList(text: string, offered: readonly number[], min: number): number[] | null {
	const items = text.trim() === '' ? [] : text.split(',').map((item) => Number(item));
	if (!items.every((n) => offered.includes(n))) return null;
	const sizes = [...new Set(items)].sort((a, b) => a - b);
	return sizes.length >= min && sizes.length <= MAX_SIZES ? sizes : null;
}

/** A board of three to five distinct cards, normalised, or null. */
export function normaliseBoard(text: string): string | null {
	try {
		const cards = parseCards(text);
		if (cards.length < 3 || cards.length > 5) return null;
		return formatCards(cards);
	} catch {
		return null;
	}
}

/** Whether the solver reads this range and it holds a hand. */
export function validRange(text: string): boolean {
	try {
		return parseRange(text).some((weight) => weight > 0);
	} catch {
		return false;
	}
}

/** Settings from a link's query (the page's hash), each bad field at its default. */
export function readSettings(query: string): Settings {
	const params = new URLSearchParams(query.replace(/^[#?]/, ''));
	const d = DEFAULT_SETTINGS;
	const number = (key: string, fallback: number, ok: (n: number) => boolean): number => {
		const text = params.get(key);
		if (text === null || text.trim() === '') return fallback;
		const n = Number(text);
		return Number.isFinite(n) && ok(n) ? n : fallback;
	};
	const flag = (key: string, fallback: boolean): boolean => {
		const text = params.get(key);
		return text === '1' ? true : text === '0' ? false : fallback;
	};
	const range = (key: string, fallback: string): string => {
		const text = params.get(key);
		return text !== null && validRange(text) ? text : fallback;
	};
	const legacy = params.get('sizes');
	const betsText = params.get('bets');
	const raiseText = params.get('rx');
	const raiseFlag = params.get('raise');
	const bets =
		betsText !== null
			? sizeList(betsText, BET_SIZES, 1)
			: legacy !== null && Object.hasOwn(LEGACY_SIZES, legacy) ? [...LEGACY_SIZES[legacy]] : null;
	return {
		board: normaliseBoard(params.get('board') ?? '') ?? d.board,
		oop: range('oop', d.oop),
		ip: range('ip', d.ip),
		pot: number('pot', d.pot, (n) => n > 0 && n <= 1e6),
		stack: number('stack', d.stack, (n) => n > 0 && n <= 1e6),
		bets: bets ?? d.bets,
		raises: params.has('raises')
			? number('raises', d.raises, (n) => Number.isInteger(n) && n >= 0 && n <= MAX_RAISES)
			: raiseFlag === '1' ? 1 : d.raises,
		raiseSizes: (raiseText !== null ? sizeList(raiseText, RAISE_SIZES, 0) : null) ?? d.raiseSizes,
		allIn: flag('allin', d.allIn),
		target: number('target', d.target, (n) => (TARGETS as readonly number[]).includes(n)),
		threads: number('threads', d.threads, (n) => Number.isInteger(n) && n >= 0 && n <= 256),
		mode: params.get('mode') === 'lite' ? 'lite' : d.mode,
		memory: number('memory', d.memory, (n) => (MEMORY_CAPS as readonly number[]).includes(n)),
	};
}

/** A link's query for these settings, only what differs from the defaults. */
export function writeSettings(settings: Settings): string {
	const d = DEFAULT_SETTINGS;
	const params = new URLSearchParams();
	const put = (key: string, value: string, fallback: string): void => {
		if (value !== fallback) params.set(key, value);
	};
	put('board', settings.board, d.board);
	put('oop', settings.oop, d.oop);
	put('ip', settings.ip, d.ip);
	put('pot', String(settings.pot), String(d.pot));
	put('stack', String(settings.stack), String(d.stack));
	put('bets', settings.bets.join(','), d.bets.join(','));
	put('raises', String(settings.raises), String(d.raises));
	put('rx', settings.raiseSizes.join(','), d.raiseSizes.join(','));
	put('allin', settings.allIn ? '1' : '0', d.allIn ? '1' : '0');
	put('target', String(settings.target), String(d.target));
	put('threads', String(settings.threads), String(d.threads));
	put('mode', settings.mode, d.mode);
	put('memory', String(settings.memory), String(d.memory));
	return params.toString();
}
