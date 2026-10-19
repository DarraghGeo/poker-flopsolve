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
	/** Bet sizes offered on each betting round. */
	readonly betSizes: readonly (readonly BetSize[])[];
	/**
	 * Sizes offered when facing a bet, on every round. Unset, raises use the
	 * round's bet sizes.
	 */
	readonly raiseSizes?: readonly BetSize[];
	/** Maximum aggressive actions per round; the opening bet is the first. */
	readonly maxRaises: number;
	/** Offer a shove alongside the configured sizes. */
	readonly allowAllIn: boolean;
	readonly chipScale: number;
	/** Smallest legal raise increment, in units. */
	readonly minRaiseUnits: number;
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

interface BetState {
	readonly round: number;
	readonly invested: readonly [number, number];
	readonly toAct: 0 | 1;
	readonly aggressions: number;
	readonly lastRaise: number;
	readonly acted: number;
	/** What each player had in when this round opened; equal for both. */
	readonly base: number;
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

	const { potUnits, stackUnits, maxRaises, chipScale, minRaiseUnits } = config;
	const half = Math.round(potUnits / 2);

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
	const closeRound = (state: BetState): number => {
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
		};
		// With someone already all in there is nothing left to decide, so the
		// remaining streets run out straight to showdown.
		const child = allIn ? closeRound(next) : buildDecision(next);

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

		const raiseSize = target - theirs;
		const minimum = Math.max(state.lastRaise, minRaiseUnits);
		if (raiseSize < minimum) {
			const bumped = theirs + minimum;
			if (bumped > cap) return null;
			target = bumped;
		}
		return target;
	};

	const buildDecision = (state: BetState): number => {
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
		if (state.aggressions < maxRaises && myRemaining > owed) {
			const seen = new Set<number>();
			const sizes: BetSize[] =
				owed > 0 && config.raiseSizes
					? [...config.raiseSizes]
					: [...(config.betSizes[state.round] ?? [])].filter((size) => !(typeof size === 'object' && 'times' in size));
			if (config.allowAllIn) sizes.push('allin');

			for (const size of sizes) {
				const target = resolveTarget(size, state, cap);
				if (target === null || seen.has(target)) continue;
				seen.add(target);
				const isShove = target >= stackUnits;
				actions.push({
					action: isShove ? ActionKind.AllIn : owed > 0 ? ActionKind.Raise : ActionKind.Bet,
					target,
				});
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
					? closeRound({ ...state, invested, acted: state.acted + 1 })
					: buildDecision({ ...state, invested, toAct: opp, acted: state.acted + 1 });
			} else {
				child = buildDecision({
					round: state.round,
					invested,
					toAct: opp,
					aggressions: state.aggressions + 1,
					lastRaise: entry.target - theirs,
					acted: state.acted + 1,
					base: state.base,
				});
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
	});

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
