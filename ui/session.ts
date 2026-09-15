/**
 * Solve session worker.
 *
 * Purpose: own one solve, off the server's event loop.
 *
 * Iterations run in chunks with a yield between them, which is what makes the
 * solve stoppable: control messages can only land while this thread is between
 * chunks. Chunking costs nothing over one long call.
 *
 * Exploitability is measured far less often than progress is reported, because
 * each measurement is a full best-response pass — roughly a whole extra
 * iteration.
 *
 * The worker keeps the run afterwards and answers strategy queries against it,
 * since a Solution holds live typed arrays that cannot cross threads.
 */

import type { MessagePort } from 'node:worker_threads';
import { parentPort, workerData } from 'node:worker_threads';
import {
	ACTION_LABELS,
	COMBO_CARDS,
	createRun,
	defineSpot,
	formatCards,
	NodeKind,
} from '../src/index.ts';
import type { Progress, SolveRun, SpotConfig } from '../src/index.ts';
import { boardAtRound } from '../src/runouts.ts';

if (!parentPort) throw new Error('session worker must be started as a worker thread');
const port: MessagePort = parentPort;

const { config, iterations } = workerData as { config: SpotConfig; iterations: number };

/** Progress ticks across a run; chunk size follows from this. */
const PROGRESS_TICKS = 40;

/** Exploitability measurements across a run. Each costs about one iteration. */
const EXPLOIT_SAMPLES = 8;

type State = 'building' | 'running' | 'stopped' | 'done' | 'error';
let stateValue: State = 'building';
const state = (): State => stateValue;
const setState = (next: State): void => {
	stateValue = next;
};

let run: SolveRun | null = null;
/** Nearest decision ancestor of each decision node, and how it was reached. */
let links: Map<number, { parent: number; via: string; action: number; dealt: boolean }> | null = null;

const yieldToMessages = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Reach of a player at a node: the product of their own action probabilities. */
function reachAt(node: number, board: number, player: 0 | 1): Float64Array {
	const spot = run!.spot;
	const solution = run!.snapshot();
	const index = spot.players[player];
	const out = new Float64Array(index.count).fill(1);
	const round = spot.tree.round[node];

	let current = node;
	for (;;) {
		const link = links!.get(current);
		if (!link || link.parent < 0) break;
		if (spot.tree.player[link.parent] === player) {
			const at = boardAtRound(spot.runouts.childFactor, board, round, spot.tree.round[link.parent]);
			const view = solution.strategyAt(link.parent, at);
			const actions = view.actions.length;
			for (let i = 0; i < index.count; i++) out[i] *= view.probs[i * actions + link.action];
		}
		current = link.parent;
	}
	// The range weight itself is the reach before anyone has acted.
	for (let i = 0; i < index.count; i++) out[i] *= index.weights[index.combos[i]];
	return out;
}

port.on('message', (message: Record<string, unknown>) => {
	if (message.kind === 'control') {
		if (message.action === 'stop' && state() === 'running') setState('stopped');
		return;
	}
	if (message.kind !== 'query' || !run || !links) return;

	const request = message as unknown as { id: number; node: number; board: number };
	try {
		const spot = run.spot;
		const { node, board } = request;
		const view = run.snapshot().strategyAt(node, board);
		const reach = reachAt(node, board, view.player);
		const round = spot.tree.round[node];
		const width = spot.runouts.width[round];
		const cards = spot.runouts.cards[round];

		const rows = [];
		for (let i = 0; i < view.combos.length; i++) {
			const combo = view.combos[i];
			// A hand the runout has taken cannot be held here.
			const a = COMBO_CARDS[combo * 2];
			const b = COMBO_CARDS[combo * 2 + 1];
			let onBoard = false;
			for (let c = 0; c < width; c++) {
				const card = cards[board * width + c];
				if (card === a || card === b) onBoard = true;
			}
			if (onBoard) continue;
			rows.push({
				combo,
				reach: reach[i],
				probs: Array.from(view.probs.subarray(i * view.actions.length, (i + 1) * view.actions.length)),
			});
		}

		port.postMessage({
			type: 'strategy',
			id: request.id,
			node,
			board,
			player: view.player,
			actions: view.actions,
			boardLabel: formatCards(cards.subarray(board * width, board * width + width)),
			rows,
		});
	} catch (error) {
		port.postMessage({ type: 'strategy', id: request.id, error: (error as Error).message });
	}
});

async function main(): Promise<void> {
	const spot = defineSpot(config);
	// Workers split the runouts; on a flop spot that is the difference between
	// a minute and quarter of one.
	run = createRun(spot, { workers: 'auto' });

	// Betting lines are structural, so the tree can be browsed before a single
	// iteration has run.
	const tree = spot.tree;
	const label = (edge: number): string => {
		const kind = tree.edgeAction[edge];
		const amount = tree.edgeTarget[edge] / spot.chipScale;
		return kind >= 3 ? `${ACTION_LABELS[kind]} ${amount}` : ACTION_LABELS[kind];
	};

	links = new Map();
	const walk = (node: number, parent: number, via: string, action: number, dealt: boolean): void => {
		const kind = tree.kind[node];
		if (kind === NodeKind.TerminalFold || kind === NodeKind.TerminalShowdown) return;
		if (kind === NodeKind.Chance) {
			walk(tree.edgeChild[tree.firstEdge[node]], parent, via, action, true);
			return;
		}
		links!.set(node, { parent, via, action, dealt });
		for (let e = 0; e < tree.numEdges[node]; e++) {
			walk(tree.edgeChild[tree.firstEdge[node] + e], node, label(tree.firstEdge[node] + e), e, false);
		}
	};
	walk(0, -1, '', -1, false);

	const structural = run.snapshot();
	port.postMessage({
		type: 'built',
		summary: {
			board: formatCards(spot.board),
			pot: spot.potUnits / spot.chipScale,
			rounds: spot.estimate.rounds,
			runouts: spot.estimate.runouts,
			combos: spot.estimate.combos,
			decisionNodes: spot.estimate.decisionNodes,
			totalSlots: spot.estimate.totalSlots,
			bytes: spot.estimate.bytes,
		},
		nodes: Array.from(tree.decisionNodes).map((node) => {
			const link = links!.get(node) ?? { parent: -1, via: '', action: -1, dealt: false };
			return {
				id: node,
				parent: link.parent,
				via: link.via,
				dealt: link.dealt,
				path: structural.path(node),
				player: tree.player[node],
				round: tree.round[node],
				pot: tree.pot[node] / spot.chipScale,
				boards: spot.runouts.counts[tree.round[node]],
			};
		}),
		// Every combination either player holds, so the page can lay out a grid.
		oopCombos: Array.from(spot.players[0].combos),
		ipCombos: Array.from(spot.players[1].combos),
	});

	const chunk = Math.max(1, Math.round(iterations / PROGRESS_TICKS));
	const totalChunks = Math.ceil(iterations / chunk);
	const measureEvery = Math.max(1, Math.round(totalChunks / EXPLOIT_SAMPLES));
	const started = Date.now();
	let exploitability = Number.NaN;
	setState('running');

	for (let index = 0; run.completed < iterations; index++) {
		if (state() === 'stopped') break;
		run.step(Math.min(chunk, iterations - run.completed));
		const last = run.completed >= iterations;
		if (index % measureEvery === 0 || last) exploitability = run.exploitabilityPercent();
		port.postMessage({
			type: 'progress',
			iteration: run.completed,
			exploitability,
			elapsedMs: Date.now() - started,
		} satisfies Progress & { type: string });
		await yieldToMessages();
	}

	if (Number.isNaN(exploitability)) exploitability = run.exploitabilityPercent();
	const stopped = state() === 'stopped';
	setState('done');
	const final = run.snapshot();
	port.postMessage({
		type: 'done',
		stopped,
		iterations: run.completed,
		elapsedMs: Date.now() - started,
		ev: [final.ev(0), final.ev(1)],
		exploitability,
	});
}

main().catch((error: Error) => {
	setState('error');
	port.postMessage({ type: 'error', message: error.message });
});
