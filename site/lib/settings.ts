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

/** The bet size menus, pot fractions on every street. */
export const SIZE_PRESETS = {
	small: { label: '33% pot', sizes: [0.33] },
	one: { label: '66% pot', sizes: [0.66] },
	large: { label: '100% pot', sizes: [1] },
	two: { label: '33% + 75% pot', sizes: [0.33, 0.75] },
} as const;

export type SizeKey = keyof typeof SIZE_PRESETS;

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
	readonly sizes: SizeKey;
	/** One raise allowed after a bet. */
	readonly raise: boolean;
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
	sizes: 'one',
	raise: false,
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
		betSizes: [[...SIZE_PRESETS[settings.sizes].sizes]],
		maxRaises: settings.raise ? 2 : 1,
		allowAllIn: settings.allIn,
	};
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
	const sizes = params.get('sizes');
	return {
		board: normaliseBoard(params.get('board') ?? '') ?? d.board,
		oop: range('oop', d.oop),
		ip: range('ip', d.ip),
		pot: number('pot', d.pot, (n) => n > 0 && n <= 1e6),
		stack: number('stack', d.stack, (n) => n > 0 && n <= 1e6),
		sizes: sizes !== null && sizes in SIZE_PRESETS ? (sizes as SizeKey) : d.sizes,
		raise: flag('raise', d.raise),
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
	put('sizes', settings.sizes, d.sizes);
	put('raise', settings.raise ? '1' : '0', d.raise ? '1' : '0');
	put('allin', settings.allIn ? '1' : '0', d.allIn ? '1' : '0');
	put('target', String(settings.target), String(d.target));
	put('threads', String(settings.threads), String(d.threads));
	put('mode', settings.mode, d.mode);
	put('memory', String(settings.memory), String(d.memory));
	return params.toString();
}
