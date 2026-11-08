/**
 * Postflop betting tree.
 *
 * Purpose: the one place betting structure is decided — which actions exist,
 * what they cost, when a street ends, and where the hand terminates.
 *
 * Unlike a from-scratch solver there are no blinds and no preflop: the spot
 * starts with a dead pot and both players even. Each betting round opens with
 * the out-of-position player.
 *
 * Payoffs are measured against a baseline where the dead pot is split, which is
 * what makes the game zero-sum. Winning a showdown in which each player put in
 * `c` is worth `pot / 2 + c`; when someone folds it is `pot / 2 +` whatever the
 * folder had already put in. All amounts are integer units (chips * chipScale).
 */

import type { Runouts } from './runouts.ts';

/**
 * One available bet size: a fraction of the pot after calling, absolute chips,
 * a multiple of the bet being faced (raises only), or a shove.
 */
export type BetSize = number | { chips: number } | { times: number } | 'allin';

/** Sizes offered when facing a bet: one row for every round, or a row per round. */
export type RaiseSizes = readonly BetSize[] | readonly (readonly BetSize[])[];

/**
 * A setting given once for both players, or apart: `{ oop: …, ip: … }`, each
 * side in the setting's own form.
 */
export type PerPlayer<T> = T | { readonly oop: T; readonly ip: T };

/** Whether a setting is given apart for each player. */
export function isPerPlayer<T>(value: PerPlayer<T>): value is { readonly oop: T; readonly ip: T } {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && 'oop' in value && 'ip' in value;
}

/** One player's side of a setting: 0 out of position, 1 in position. */
export function forPlayer<T>(value: PerPlayer<T>, player: number): T {
	return isPerPlayer(value) ? (player === 0 ? value.oop : value.ip) : value;
}

/** Apply `f` to each side of a setting, keeping its shape. */
export function mapPlayers<T, U>(value: PerPlayer<T>, f: (side: T) => U): PerPlayer<U> {
	return isPerPlayer(value) ? { oop: f(value.oop), ip: f(value.ip) } : f(value);
}

/** Whether raise sizes are given per round rather than once for all of them. */
export function raisesPerRound(sizes: RaiseSizes): sizes is readonly (readonly BetSize[])[] {
	return sizes.length > 0 && Array.isArray(sizes[0]);
}

/**
 * A setting given once or per round, expanded to one entry per round.
 * @throws if a per-round list has the wrong length
 */
export function perRound<T>(value: T | readonly T[], listed: boolean, rounds: number, name: string): T[] {
	if (!listed) return Array.from({ length: rounds }, () => value as T);
	const list = value as readonly T[];
	if (list.length === 1) return Array.from({ length: rounds }, () => list[0]);
	if (list.length !== rounds) {
		throw new Error(
			`${name} has ${list.length} entries but this board has ${rounds} betting rounds; ` +
				'give one per round, or a single value for all of them',
		);
	}
	return [...list];
}

export const NodeKind = {
	Decision: 0,
	Chance: 1,
	TerminalFold: 2,
	TerminalShowdown: 3,
} as const;

export const ActionKind = {
	Fold: 0,
	Check: 1,
	Call: 2,
	Bet: 3,
	Raise: 4,
	AllIn: 5,
} as const;

export const ACTION_LABELS = ['fold', 'check', 'call', 'bet', 'raise', 'allin'] as const;

/** Everything the tree builder needs. */
export interface TreeConfig {
	/** Dead money already in the middle, in units. */
	readonly potUnits: number;
	/** Effective stack behind, per player, in units. */
	readonly stackUnits: number;
	/** Bet sizes offered on each betting round; for both players, or apart. */
	readonly betSizes: PerPlayer<readonly (readonly BetSize[])[]>;
	/**
	 * Sizes offered when facing a bet, on every round or per round. Unset,
	 * raises use the round's bet sizes.
	 */
	readonly raiseSizes?: PerPlayer<RaiseSizes | undefined>;
	/**
	 * Maximum aggressive actions per round, the opening bet the first; once or
	 * per round. Given apart, a player may bet or raise only while the round's
	 * aggressions are under their own limit.
	 */
	readonly maxRaises: PerPlayer<number | readonly number[]>;
	/** Offer a shove alongside the configured sizes; once or per round. */
	readonly allowAllIn: PerPlayer<boolean | readonly boolean[]>;
	readonly chipScale: number;
	/** Smallest legal raise increment, in units. */
	readonly minRaiseUnits: number;
	/**
	 * A bet or raise committing at least this fraction of the actor's
	 * remaining stack becomes a shove instead; once or per round. Unset or 0,
	 * never.
	 */
	readonly allInThreshold?: PerPlayer<number | readonly number[] | undefined>;
	/**
	 * Out of position may not lead into the player who made the last
	 * aggressive action of the round before; it may only check. Once or per
	 * round.
	 */
	readonly noDonk?: boolean | readonly boolean[];
	/**
	 * Pot-fraction sizes closer together than this collapse into one, their
	 * mean. Unset or 0, none.
	 */
	readonly mergeSizes?: number;
	/**
	 * Bets, raises and shoves to leave out, each by the readable path of the
	 * node it leads to — `Solution.path` — with the subtree below it. Unset,
	 * none. See `SpotConfig.removeActions`.
	 */
	readonly removeActions?: readonly string[];
	/**
	 * Keep one size at most nodes: see `SpotConfig.thinSizes`. Unset or
	 * false, every size the other settings give.
	 */
	readonly thinSizes?: boolean;
}

/**
 * Collapse pot-fraction sizes closer together than `distance` into their mean.
 * Other kinds of size pass through untouched, after the merged ones.
 */
export function mergeBetSizes(sizes: readonly BetSize[], distance: number): BetSize[] {
	if (!(distance > 0)) return [...sizes];
	const fractions = sizes.filter((size): size is number => typeof size === 'number').sort((a, b) => a - b);
	const others = sizes.filter((size) => typeof size !== 'number');
	const merged: number[] = [];
	let cluster: number[] = [];
	const flush = (): void => {
		if (cluster.length === 0) return;
		merged.push(Math.round((cluster.reduce((a, b) => a + b, 0) / cluster.length) * 1000) / 1000);
		cluster = [];
	};
	for (const size of fractions) {
		if (cluster.length > 0 && size - cluster[0] >= distance) flush();
		cluster.push(size);
	}
	flush();
	return [...merged, ...others];
}

/**
 * How a path names an action: `check`, `call`, `fold`, or the kind and the
 * actor's total investment after it in chips — `bet 18.15`, `raise 60`,
 * `allin 975`. `Solution.path` joins these with spaces, and `/` for a deal.
 */
export function actionLabel(action: number, target: number, chipScale: number): string {
	return action >= ActionKind.Bet ? `${ACTION_LABELS[action]} ${target / chipScale}` : ACTION_LABELS[action];
}

/** Structure-of-arrays betting tree. */
export interface Tree {
	readonly nodeCount: number;
	readonly edgeCount: number;
	readonly kind: Uint8Array;
	/** Player to act at a decision node, else -1. 0 is out of position. */
	readonly player: Int8Array;
	readonly round: Uint8Array;
	readonly firstEdge: Int32Array;
	readonly numEdges: Uint8Array;
	/** Total in the middle at this node, in units, including the dead pot. */
	readonly pot: Int32Array;
	/**
	 * TerminalFold: value to player 0, signed, in units.
	 * TerminalShowdown: what the winner gains, in units.
	 */
	readonly payoff: Int32Array;
	readonly edgeAction: Uint8Array;
	/** The actor's total investment after acting, in units. */
	readonly edgeTarget: Int32Array;
	readonly edgeChild: Int32Array;
	readonly decisionNodes: Int32Array;
}

interface SizedAction {
	readonly action: number;
	readonly target: number;
}

/** The pot fraction `thinSizes` keeps at most decisions. */
const THIN_BASE = 0.75;

interface BetState {
	readonly round: number;
	readonly invested: readonly [number, number];
	readonly toAct: 0 | 1;
	readonly aggressions: number;
	readonly lastRaise: number;
	readonly acted: number;
	/** What each player had in when this round opened; equal for both. */
	readonly base: number;
	/** Who last bet or raised this round, or -1. */
	readonly aggressor: number;
	/** Who last bet or raised the round before, or -1. */
	readonly previousAggressor: number;
	/** Earlier rounds that saw a bet. */
	readonly streetsBet: number;
}

/**
 * Build the betting tree for a spot.
 *
 * @param config betting structure, in units
 * @param runouts board completions, which fix the number of rounds
 */
export function buildTree(config: TreeConfig, runouts: Runouts): Tree {
	const kind: number[] = [];
	const player: number[] = [];
	const round: number[] = [];
	const firstEdge: number[] = [];
	const numEdges: number[] = [];
	const pot: number[] = [];
	const payoff: number[] = [];
	const edgeAction: number[] = [];
	const edgeTarget: number[] = [];
	const edgeChild: number[] = [];

	const { potUnits, stackUnits, chipScale, minRaiseUnits } = config;
	const rounds = runouts.rounds;
	// Every betting setting resolved per player, then per round.
	const players = [0, 1] as const;
	const maxRaises = players.map((p) => {
		const value = forPlayer(config.maxRaises, p);
		return perRound(value, Array.isArray(value), rounds, 'maxRaises');
	});
	const allowAllIn = players.map((p) => {
		const value = forPlayer(config.allowAllIn, p);
		return perRound(value, Array.isArray(value), rounds, 'allowAllIn');
	});
	const merge = config.mergeSizes ?? 0;
	const raiseSizes = players.map((p) => {
		const value = forPlayer(config.raiseSizes, p);
		return value
			? perRound<readonly BetSize[]>(value, raisesPerRound(value), rounds, 'raiseSizes').map((row) => mergeBetSizes(row, merge))
			: null;
	});
	const betSizes = players.map((p) => forPlayer(config.betSizes, p).map((row) => mergeBetSizes(row, merge)));
	const threshold = players.map((p) => {
		const value = forPlayer(config.allInThreshold, p) ?? 0;
		return perRound(value, Array.isArray(value), rounds, 'allInThreshold');
	});
	const noDonk = perRound(config.noDonk ?? false, Array.isArray(config.noDonk), rounds, 'noDonk');
	const half = Math.round(potUnits / 2);
	// Lines to cut, and which of them were found. Paths are only built when
	// there is something to cut, so a tree without cuts is built as before.
	const remove = config.removeActions && config.removeActions.length > 0 ? new Set(config.removeActions) : null;
	const removed = new Set<string>();
	const extend = (path: string, step: string): string => (remove ? (path ? `${path} ${step}` : step) : '');

	// The sizes `thinSizes` keeps at a decision, in the order they came.
	const thin = config.thinSizes === true;
	const thinned = (sized: readonly SizedAction[], state: BetState): readonly SizedAction[] => {
		// Every size where the first round opens.
		if (state.round === 0 && state.aggressions === 0 && state.acted === 0) return sized;
		const me = state.toAct;
		const mine = state.invested[me];
		const owed = Math.max(0, state.invested[1 - me] - mine);
		const potAfterCall = potUnits + state.invested[0] + state.invested[1] + owed;
		const fraction = (target: number): number => (target - mine - owed) / potAfterCall;
		// The size nearest three quarters of the pot: a shove where that is one.
		let nearest = -1;
		sized.forEach((entry, i) => {
			const distance = Math.abs(fraction(entry.target) - THIN_BASE);
			if (nearest < 0 || distance < Math.abs(fraction(sized[nearest].target) - THIN_BASE)) nearest = i;
		});
		// Opening the last round after an earlier one saw a bet: the big sizes too.
		const big = rounds > 1 && state.round === rounds - 1 && owed === 0 && state.streetsBet > 0;
		return sized.filter(
			(entry, i) => i === nearest || (big && (entry.action === ActionKind.AllIn || fraction(entry.target) > 1)),
		);
	};

	const addNode = (
		nodeKind: number,
		nodePlayer: number,
		nodeRound: number,
		nodePot: number,
		nodePayoff: number,
	): number => {
		kind.push(nodeKind);
		player.push(nodePlayer);
		round.push(nodeRound);
		firstEdge.push(-1);
		numEdges.push(0);
		pot.push(nodePot);
		payoff.push(nodePayoff);
		return kind.length - 1;
	};

	/** What follows once a round's betting has closed. */
	const closeRound = (state: BetState, path: string): number => {
		const total = potUnits + state.invested[0] + state.invested[1];
		const allIn = state.invested[0] >= stackUnits || state.invested[1] >= stackUnits;

		if (state.round + 1 >= runouts.rounds) {
			// Both invested the same, so the winner gains half the dead pot plus
			// the opponent's investment.
			return addNode(NodeKind.TerminalShowdown, -1, state.round, total, half + state.invested[0]);
		}

		const node = addNode(NodeKind.Chance, -1, state.round, total, 0);
		const next: BetState = {
			round: state.round + 1,
			invested: state.invested,
			toAct: 0,
			aggressions: 0,
			lastRaise: minRaiseUnits,
			acted: 0,
			base: state.invested[0],
			aggressor: -1,
			previousAggressor: state.aggressor,
			streetsBet: state.streetsBet + (state.aggressions > 0 ? 1 : 0),
		};
		// With someone already all in there is nothing left to decide, so the
		// remaining streets run out straight to showdown.
		const child = allIn ? closeRound(next, extend(path, '/')) : buildDecision(next, extend(path, '/'));

		firstEdge[node] = edgeChild.length;
		numEdges[node] = 1;
		edgeAction.push(ActionKind.Check);
		edgeTarget.push(0);
		edgeChild.push(child);
		return node;
	};

	/** Resolve one bet size to a total-investment target, or null if illegal. */
	const resolveTarget = (size: BetSize, state: BetState, cap: number): number | null => {
		const me = state.toAct;
		const opp = (1 - me) as 0 | 1;
		const mine = state.invested[me];
		const theirs = state.invested[opp];
		const owed = Math.max(0, theirs - mine);
		const potAfterCall = potUnits + state.invested[0] + state.invested[1] + owed;

		let target: number;
		if (size === 'allin') target = cap;
		else if (typeof size === 'number') target = mine + owed + Math.round(size * potAfterCall);
		else if ('times' in size) target = state.base + Math.round(size.times * (theirs - state.base));
		else target = mine + owed + Math.round(size.chips * chipScale);

		target = Math.min(target, cap);
		if (target <= theirs) return null;

		// Short of a full raise: bumped up to one where the stack allows it,
		// and otherwise all-in for less. A player can always put in everything
		// they have, raise or not — dropping that shove left a short stack
		// facing a bet only call or fold.
		const raiseSize = target - theirs;
		const minimum = Math.max(state.lastRaise, minRaiseUnits);
		if (raiseSize < minimum) target = Math.min(theirs + minimum, cap);
		return target;
	};

	const buildDecision = (state: BetState, path: string): number => {
		const me = state.toAct;
		const opp = (1 - me) as 0 | 1;
		const mine = state.invested[me];
		const theirs = state.invested[opp];
		const owed = Math.max(0, theirs - mine);
		const myRemaining = stackUnits - mine;

		const total = potUnits + state.invested[0] + state.invested[1];
		const node = addNode(NodeKind.Decision, me, state.round, total, 0);

		const actions: { action: number; target: number }[] = [];
		if (owed > 0) actions.push({ action: ActionKind.Fold, target: mine });
		actions.push({
			action: owed > 0 ? ActionKind.Call : ActionKind.Check,
			target: mine + Math.min(owed, myRemaining),
		});

		// Nobody can put in more than the opponent is able to match.
		const cap = Math.min(stackUnits, theirs + (stackUnits - theirs));
		// A donk bet: out of position opening a round into the player who
		// took the betting lead the round before.
		const donk =
			noDonk[state.round] && me === 0 && owed === 0 && state.aggressions === 0 && state.previousAggressor === 1;
		if (state.aggressions < maxRaises[me][state.round] && myRemaining > owed && !donk) {
			const seen = new Set<number>();
			const sized: { action: number; target: number }[] = [];
			const myRaises = raiseSizes[me];
			const sizes: BetSize[] =
				owed > 0 && myRaises
					? [...myRaises[state.round]]
					: [...(betSizes[me][state.round] ?? [])].filter((size) => !(typeof size === 'object' && 'times' in size));
			if (allowAllIn[me][state.round]) sizes.push('allin');

			for (const size of sizes) {
				let target = resolveTarget(size, state, cap);
				// Close enough to everything that the rest is not worth keeping.
				if (target !== null && threshold[me][state.round] > 0 && target - mine >= threshold[me][state.round] * myRemaining) {
					target = cap;
				}
				if (target === null || seen.has(target)) continue;
				seen.add(target);
				const isShove = target >= stackUnits;
				sized.push({ action: isShove ? ActionKind.AllIn : owed > 0 ? ActionKind.Raise : ActionKind.Bet, target });
			}
			for (const entry of thin ? thinned(sized, state) : sized) {
				if (remove) {
					const line = extend(path, actionLabel(entry.action, entry.target, chipScale));
					if (remove.has(line)) {
						removed.add(line);
						continue;
					}
				}
				actions.push(entry);
			}
		}

		const base = edgeChild.length;
		firstEdge[node] = base;
		numEdges[node] = actions.length;
		for (const entry of actions) {
			edgeAction.push(entry.action);
			edgeTarget.push(entry.target);
			edgeChild.push(-1);
		}

		actions.forEach((entry, i) => {
			const line = extend(path, actionLabel(entry.action, entry.target, chipScale));
			const invested: [number, number] =
				me === 0 ? [entry.target, theirs] : [theirs, entry.target];
			let child: number;

			if (entry.action === ActionKind.Fold) {
				// The folder forfeits what they put in, and the dead pot goes
				// to the other player.
				const value = me === 0 ? -(half + mine) : half + mine;
				child = addNode(NodeKind.TerminalFold, -1, state.round, total, value);
			} else if (entry.action === ActionKind.Check || entry.action === ActionKind.Call) {
				const closed = invested[0] === invested[1] && state.acted + 1 >= 2;
				child = closed
					? closeRound({ ...state, invested, acted: state.acted + 1 }, line)
					: buildDecision({ ...state, invested, toAct: opp, acted: state.acted + 1 }, line);
			} else {
				child = buildDecision({
					round: state.round,
					invested,
					toAct: opp,
					aggressions: state.aggressions + 1,
					lastRaise: entry.target - theirs,
					acted: state.acted + 1,
					base: state.base,
					aggressor: me,
					previousAggressor: state.previousAggressor,
					streetsBet: state.streetsBet,
				}, line);
			}
			edgeChild[base + i] = child;
		});

		return node;
	};

	buildDecision({
		round: 0,
		invested: [0, 0],
		toAct: 0,
		aggressions: 0,
		lastRaise: minRaiseUnits,
		acted: 0,
		base: 0,
		aggressor: -1,
		previousAggressor: -1,
		streetsBet: 0,
	}, '');

	if (remove && removed.size < remove.size) {
		const missing = [...remove].filter((line) => !removed.has(line));
		throw new Error(
			`removeActions: no bet, raise or shove in this tree ends the line ${missing.map((m) => `"${m}"`).join(', ')}. ` +
				'Give each as Solution.path writes the node the action leads to, e.g. "check bet 18.15"; ' +
				'checks, calls and folds cannot be removed',
		);
	}

	const decisionNodes: number[] = [];
	for (let i = 0; i < kind.length; i++) if (kind[i] === NodeKind.Decision) decisionNodes.push(i);

	return {
		nodeCount: kind.length,
		edgeCount: edgeChild.length,
		kind: Uint8Array.from(kind),
		player: Int8Array.from(player),
		round: Uint8Array.from(round),
		firstEdge: Int32Array.from(firstEdge),
		numEdges: Uint8Array.from(numEdges),
		pot: Int32Array.from(pot),
		payoff: Int32Array.from(payoff),
		edgeAction: Uint8Array.from(edgeAction),
		edgeTarget: Int32Array.from(edgeTarget),
		edgeChild: Int32Array.from(edgeChild),
		decisionNodes: Int32Array.from(decisionNodes),
	};
}
