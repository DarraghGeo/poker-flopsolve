/**
 * What a preset changed (issue #115).
 *
 * Purpose: `solveLite` and `largeTree` take any caller betting and turn it
 * into a cheaper game. Nothing they do may be silent, so each hands back a
 * `PresetChanges`: the bet, raise and shove sizes its tree no longer offers,
 * found by walking the caller's betting tree beside the preset's, the rounds
 * that lost any, and every other setting it set or dropped, each with a
 * sentence a page can show as it is.
 */

import { bettingTree } from './betting.ts';
import { parseCards } from './cards.ts';
import type { SpotConfig } from './index.ts';
import { ActionKind, NodeKind } from './tree.ts';
import type { Tree } from './tree.ts';

/** A betting round by name. */
export type Street = 'flop' | 'turn' | 'river';

/** Sizes one player's decisions of one kind lost on one round. */
export interface SizesCut {
	readonly street: Street;
	readonly player: 'oop' | 'ip';
	/** 'bet' opens the round's betting; 'raise' answers a bet. */
	readonly facing: 'bet' | 'raise';
	/**
	 * The sizes cut, ascending: each a fraction of the pot after a call, to
	 * two places, as `betSizes` and `raiseSizes` give them, or 'allin'.
	 * Where the caller's sizes resolve to different chips at different pots,
	 * one caller size can show as neighbouring fractions.
	 */
	readonly sizes: readonly (number | 'allin')[];
	/** The caller's decisions of this kind that lost at least one size. */
	readonly decisions: number;
	/** The caller's decisions of this kind that offered any size at all. */
	readonly of: number;
}

/** A setting a preset set, changed or dropped. */
export interface SettingChange {
	/** The setting's name: a `SpotConfig` field, or a `SolveOptions` one (`approximations.chanceSampling`, `precision`, ...). */
	readonly setting: string;
	/** The caller's value; undefined where it was unset. */
	readonly from: unknown;
	/** The preset's value; undefined where it dropped it. */
	readonly to: unknown;
}

/** Everything a preset changed against the caller's spot. */
export interface PresetChanges {
	/** Sizes the preset's tree no longer offers, by street, player and kind. */
	readonly sizesCut: readonly SizesCut[];
	/** Streets whose betting lost any size: the rounds simplified. */
	readonly roundsSimplified: readonly Street[];
	/** Every other setting set, changed or dropped, the approximations included. */
	readonly settings: readonly SettingChange[];
	/** One sentence per change, sizes first, in plain words. */
	readonly notes: readonly string[];
}

/**
 * Every bet, raise and shove the caller's tree offers and `preset`'s does
 * not. The trees are walked side by side, an action matched by its kind and
 * the chips it puts in; below a cut action nothing more is counted, and a
 * line `preset` adds (one the caller cut with `removeActions` below a deal,
 * say) is not walked.
 */
export function sizesCut(caller: SpotConfig, preset: SpotConfig): SizesCut[] {
	const from = bettingTree(caller);
	const to = bettingTree(preset);
	const rounds = 6 - parseCards(caller.board).length;
	const streets: readonly Street[] = (['flop', 'turn', 'river'] as const).slice(3 - rounds);
	const groups = new Map<string, { cut: Map<string, number | 'allin'>; decisions: number; of: number }>();

	const walk = (a: number, b: number, invested: readonly [number, number]): void => {
		const kind = from.kind[a];
		if (kind === NodeKind.Chance) {
			// One edge each: the deal.
			walk(from.edgeChild[from.firstEdge[a]], to.edgeChild[to.firstEdge[b]], invested);
			return;
		}
		if (kind !== NodeKind.Decision) return;
		const me = from.player[a];
		const owed = Math.max(0, invested[1 - me] - invested[me]);
		const facing = owed > 0 ? 'raise' : 'bet';
		const key = `${from.round[a]} ${me} ${facing}`;
		const group = groups.get(key) ?? { cut: new Map(), decisions: 0, of: 0 };
		groups.set(key, group);
		const theirs = edgesOf(to, b);
		let sized = false;
		let lost = false;
		for (let e = from.firstEdge[a]; e < from.firstEdge[a] + from.numEdges[a]; e++) {
			const action = from.edgeAction[e];
			const target = from.edgeTarget[e];
			const aggressive = action === ActionKind.Bet || action === ActionKind.Raise || action === ActionKind.AllIn;
			if (aggressive) sized = true;
			const match = theirs.get(`${action} ${target}`);
			if (match === undefined) {
				if (!aggressive) throw new Error(`sizesCut: the preset's tree lost a fold, check or call at node ${a}`);
				lost = true;
				const size = action === ActionKind.AllIn ? 'allin' : fraction(from, a, target, invested, me, owed);
				group.cut.set(String(size), size);
				continue;
			}
			const next: [number, number] = [invested[0], invested[1]];
			next[me] = target;
			walk(from.edgeChild[e], to.edgeChild[match], next);
		}
		if (sized) group.of++;
		if (lost) group.decisions++;
	};
	walk(0, 0, [0, 0]);

	const out: SizesCut[] = [];
	for (const [key, group] of groups) {
		if (group.cut.size === 0) continue;
		const [round, player, facing] = key.split(' ');
		const sizes = [...group.cut.values()].sort((x, y) => (x === 'allin' ? 1 : y === 'allin' ? -1 : x - y));
		out.push({
			street: streets[Number(round)],
			player: player === '0' ? 'oop' : 'ip',
			facing: facing as 'bet' | 'raise',
			sizes,
			decisions: group.decisions,
			of: group.of,
		});
	}
	const order = (c: SizesCut): number =>
		streets.indexOf(c.street) * 4 + (c.player === 'oop' ? 0 : 2) + (c.facing === 'bet' ? 0 : 1);
	return out.sort((x, y) => order(x) - order(y));
}

/** A node's edges by action and target. */
function edgesOf(tree: Tree, node: number): Map<string, number> {
	const out = new Map<string, number>();
	for (let e = tree.firstEdge[node]; e < tree.firstEdge[node] + tree.numEdges[node]; e++) {
		out.set(`${tree.edgeAction[e]} ${tree.edgeTarget[e]}`, e);
	}
	return out;
}

/** A sized action as a fraction of the pot after a call, to two places. */
function fraction(tree: Tree, node: number, target: number, invested: readonly [number, number], me: number, owed: number): number {
	const potAfterCall = tree.pot[node] + owed;
	return Math.round(((target - invested[me] - owed) / potAfterCall) * 100) / 100;
}

/** Assemble a report: the sizes cut, the rounds they leave simplified, the other settings, and a sentence each. */
export function presetChanges(caller: SpotConfig, preset: SpotConfig, settings: readonly SettingChange[], notes: readonly string[]): PresetChanges {
	const cuts = sizesCut(caller, preset);
	const roundsSimplified = (['flop', 'turn', 'river'] as const).filter((s) => cuts.some((c) => c.street === s));
	const sizeNotes = cuts.map((c) => {
		const sizes = c.sizes.map((s) => (s === 'allin' ? 'all-in' : String(s))).join(', ');
		const who = c.player === 'oop' ? 'OOP' : 'IP';
		const what = c.facing === 'bet' ? 'bet' : 'raise';
		return `${c.street}: ${who} loses the ${what} size${c.sizes.length > 1 ? 's' : ''} ${sizes} at ${c.decisions} of ${c.of} decisions`;
	});
	return { sizesCut: cuts, roundsSimplified, settings, notes: [...sizeNotes, ...notes] };
}

/** The settings two configs differ in, among `keys`, as changes from `caller` to `preset`. */
export function configChanges(caller: SpotConfig, preset: SpotConfig, keys: readonly (keyof SpotConfig)[]): SettingChange[] {
	const out: SettingChange[] = [];
	for (const key of keys) {
		const before = caller[key];
		const after = preset[key];
		if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ setting: key, from: before, to: after });
	}
	return out;
}
