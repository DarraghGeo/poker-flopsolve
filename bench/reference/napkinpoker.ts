/**
 * napkinpoker's full-hand reference solves (issue #87).
 *
 * Purpose: load the 70 flop → river solves imported from the owner's
 * napkinpoker repo as fixtures, so approximations can be scored on every
 * board texture rather than one monotone flop. See README.md beside this file
 * for where they come from and what they hold.
 *
 * - `napkinSpots()`: each spot as a `SpotConfig` for this solver, mapped as
 *   napkinpoker's `tools/bench/flopsolve/flop-vs-pfrs.mjs` maps it.
 * - `napkinNodes(street)`: the stored decision nodes, with the actor's range,
 *   strategy and per-action EVs indexed by combination like `COMBO_CARDS`.
 * - `nodeAt(spot, path)`: the node of this solver's tree a stored path leads
 *   to, with its action labels written as the stored ones are, so a stored
 *   node can be matched action for action.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { comboIndex, COMBOS, parseCard } from '../../src/cards.ts';
import type { Spot, SpotConfig } from '../../src/index.ts';
import { NodeKind } from '../../src/tree.ts';

const HERE = join(dirname(fileURLToPath(import.meta.url)), 'napkinpoker');

/** One street's betting in a stored spot. */
interface StoredStreet {
	/** Bet sizes, percent of the pot. */
	readonly bets: readonly number[];
	/** Raise-to as a multiple of the bet faced. */
	readonly raise: number;
	/** Raises allowed after the opening bet. */
	readonly raises: number;
	readonly allIn: boolean;
}

/** A stored spot as napkinpoker keeps it (`spots/<id>.json`). */
interface StoredSpot {
	readonly board: string;
	readonly pot: number;
	readonly stack: number;
	readonly oop: string;
	readonly ip: string;
	readonly name: string;
	readonly potType: string;
	readonly seats: readonly string[];
	readonly streets: readonly StoredStreet[];
}

export interface NapkinSpot {
	/** `f00` … `f99`, as the stored nodes' ids begin. */
	readonly id: string;
	/** e.g. "BU vs BB · KcKs7h · flop". */
	readonly name: string;
	/** SRP, 3BP, … */
	readonly potType: string;
	readonly config: SpotConfig;
	/** The turn and river cards whose nodes were stored (`cards.json`). */
	readonly turns: readonly string[];
	readonly rivers: readonly string[];
}

/** The stored spot's config, in this solver's terms. */
export function toConfig(stored: StoredSpot): SpotConfig {
	return {
		board: stored.board.match(/../g)!.join(' '),
		pot: stored.pot,
		stack: stored.stack,
		oop: stored.oop,
		ip: stored.ip,
		betSizes: stored.streets.map((s) => s.bets.map((b) => b / 100)),
		raiseSizes: stored.streets.map((s) => [{ times: s.raise }]),
		maxRaises: stored.streets.map((s) => s.raises + 1),
		allowAllIn: stored.streets.map((s) => s.allIn),
	};
}

let spotCache: NapkinSpot[] | undefined;

/** Every stored spot, by id. */
export function napkinSpots(): NapkinSpot[] {
	if (spotCache) return [...spotCache];
	const cards = JSON.parse(readFileSync(join(HERE, 'cards.json'), 'utf8')) as Record<
		string,
		{ turns: string[]; rivers: string[] }
	>;
	spotCache = readdirSync(join(HERE, 'spots'))
		.filter((f) => f.endsWith('.json'))
		.sort()
		.map((f) => {
			const id = f.slice(0, -5);
			const stored = JSON.parse(readFileSync(join(HERE, 'spots', f), 'utf8')) as StoredSpot;
			return {
				id,
				name: stored.name,
				potType: stored.potType,
				config: toConfig(stored),
				turns: cards[id]?.turns ?? [],
				rivers: cards[id]?.rivers ?? [],
			};
		});
	return [...spotCache];
}

/** A stored decision node. EVs are in chips, relative to the node: see README. */
export interface NapkinNode {
	/** Spot id, then the turn card dealt if any: `f00`, `f00-5h`. */
	readonly id: string;
	readonly spot: string;
	/** Board at the node, e.g. "KcKs7h5h". */
	readonly board: string;
	/** Labels from the root: `X`, `F`, `C`, `B182`, `R546`, `A9750`, `d5h`. */
	readonly path: readonly string[];
	/** 0 out of position, 1 in position. */
	readonly actor: 0 | 1;
	/** Pot at the node, chips, including any bet faced. */
	readonly pot: number;
	readonly facing: number;
	readonly stack: number;
	/** Within-street reach of the actor and the opponent. */
	readonly reach: readonly [number, number];
	/** The stored solver's action labels. */
	readonly actions: readonly string[];
	/** The actor's combinations, as `COMBO_CARDS` indices. */
	readonly combos: Uint16Array;
	/**
	 * The actor's reach per combination, in range-weight units: at its first
	 * decision this is exactly its configured range weight.
	 */
	readonly weight: Float64Array;
	/** `[action][i]`: probability, for combination `combos[i]`. */
	readonly strategy: Float64Array[];
	/** `[action][i]`: EV in chips, NaN where the solver gave none. */
	readonly ev: Float64Array[];
}

/** A stored combination name, "AsKh", as its index. */
export function comboOf(name: string): number {
	return comboIndex(parseCard(name.slice(0, 2)), parseCard(name.slice(2, 4)));
}

/** One line of `flop.jsonl.gz` / `turn.jsonl.gz`, as stored. */
interface StoredNode {
	readonly id: string;
	readonly board: string;
	readonly path: string[];
	readonly actor: 0 | 1;
	readonly pot: number;
	readonly facing: number;
	readonly stack: number;
	readonly reach: [number, number];
	readonly actions: string[];
	readonly names: string[];
	readonly w: number[];
	readonly s: number[][];
	readonly ev: (number | null)[][];
}

const nodeCache = new Map<string, NapkinNode[]>();

/**
 * The stored nodes of one street: every flop decision node kept (up to three
 * actions in), or the first decision of the turn on each stored turn card.
 */
export function napkinNodes(street: 'flop' | 'turn'): NapkinNode[] {
	const cached = nodeCache.get(street);
	if (cached) return [...cached];
	const text = gunzipSync(readFileSync(join(HERE, `${street}.jsonl.gz`))).toString('utf8');
	const nodes = text
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line): NapkinNode => {
			const row = JSON.parse(line) as StoredNode;
			return {
				id: row.id,
				spot: row.id.split('-')[0],
				board: row.board,
				path: row.path,
				actor: row.actor,
				pot: row.pot,
				facing: row.facing,
				stack: row.stack,
				reach: row.reach,
				actions: row.actions,
				combos: Uint16Array.from(row.names, comboOf),
				weight: Float64Array.from(row.w, (w) => w / 10000),
				strategy: row.s.map((a) => Float64Array.from(a, (p) => p / 1000)),
				ev: row.ev.map((a) => Float64Array.from(a, (v) => (v === null ? Number.NaN : v / 100))),
			};
		});
	nodeCache.set(street, nodes);
	return [...nodes];
}

/** Where a stored path leads in this solver's tree. */
export interface NodeMatch {
	readonly node: number;
	/** The actor there, 0 or 1. */
	readonly actor: number;
	/** Its actions, labelled as the stored solver labels them (chips ×100 within the street). */
	readonly labels: string[];
	/** Each label's edge index, in the same order. */
	readonly edges: number[];
	/** Cards dealt along the path, in order. */
	readonly dealt: string[];
}

/** Stored action letter per `ActionKind`: fold, check, call, bet, raise, all-in. */
const LETTERS = ['F', 'X', 'C', 'B', 'R', 'A'];

/**
 * Follow a stored path through a spot's tree. Bets and raises match by their
 * within-street amount to the nearest unit of the stored labels (a hundredth
 * of a chip), which absorbs the stored solver's rounding. Dealt cards are
 * returned, not followed: the tree is the same after every card.
 *
 * @throws if a step has no matching action
 */
export function nodeAt(spot: Spot, path: readonly string[]): NodeMatch {
	const { tree } = spot;
	const perLabel = spot.chipScale / 100;
	let node = 0;
	let base = 0;
	const dealt: string[] = [];
	const describe = (at: number): { labels: string[]; edges: number[] } => {
		const labels: string[] = [];
		const edges: number[] = [];
		for (let e = tree.firstEdge[at]; e < tree.firstEdge[at] + tree.numEdges[at]; e++) {
			const letter = LETTERS[tree.edgeAction[e]];
			if (letter === undefined) throw new Error(`unknown action kind ${tree.edgeAction[e]}`);
			const sized = letter === 'B' || letter === 'R' || letter === 'A';
			labels.push(sized ? `${letter}${Math.round((tree.edgeTarget[e] - base) / perLabel)}` : letter);
			edges.push(e);
		}
		return { labels, edges };
	};
	for (const step of path) {
		if (step.startsWith('d')) {
			if (tree.kind[node] !== NodeKind.Chance) throw new Error(`"${step}" at a node that deals no card`);
			dealt.push(step.slice(1));
			node = tree.edgeChild[tree.firstEdge[node]];
			base = (tree.pot[node] - spot.potUnits) / 2;
			continue;
		}
		if (tree.kind[node] !== NodeKind.Decision) throw new Error(`"${step}" at a node that is not a decision`);
		const { labels, edges } = describe(node);
		const i = matchLabel(labels, step);
		if (i < 0) throw new Error(`no action "${step}" among ${labels.join(', ')}`);
		node = tree.edgeChild[edges[i]];
	}
	if (tree.kind[node] !== NodeKind.Decision) throw new Error('the path does not end at a decision');
	return { node, actor: tree.player[node], ...describe(node), dealt };
}

/** Index of the label matching a stored one, amounts within one unit; -1 if none. */
export function matchLabel(labels: readonly string[], stored: string): number {
	const kind = stored[0];
	const amount = Number(stored.slice(1));
	return labels.findIndex(
		(label) => label[0] === kind && (label.length === 1 || Math.abs(Number(label.slice(1)) - amount) <= 1),
	);
}

/**
 * Pair each stored action with one of ours, one to one: entry `i` is the
 * index in `labels` of stored action `i`, or null if the two menus differ
 * (an action unmatched, matched twice, or a different count).
 */
export function pairActions(labels: readonly string[], stored: readonly string[]): number[] | null {
	if (labels.length !== stored.length) return null;
	const used = new Set<number>();
	const out: number[] = [];
	for (const action of stored) {
		const i = matchLabel(labels, action);
		if (i < 0 || used.has(i)) return null;
		used.add(i);
		out.push(i);
	}
	return out;
}

/** A stored node's reach as a 1326-long weight vector, in range-weight units. */
export function weightsOf(node: NapkinNode): Float64Array {
	const out = new Float64Array(COMBOS);
	node.combos.forEach((combo, i) => (out[combo] = node.weight[i]));
	return out;
}
