/**
 * Does seeding a lite solve with an outside strategy make it settle sooner?
 *
 *   node --import tsx bench/lite/warm-napkin.ts <root-play.json> <variants,...> [workers]
 *
 * Keep the file outside this public repository when its ranges are private:
 * napkinpoker writes it to its own tools/bench/flopsolve/out/.
 *
 * The strategy comes in as data, not code: `root-play.json` is what
 * napkinpoker's `tools/bench/flopsolve/export-root-play.mjs` writes, per spot
 * id a list of nodes, each `{ path, player, actions: [{ action, amount }],
 * shares: { combo: [share per action] } }`. Any engine can write one.
 *
 * Variants: `cold` (litePreset as is), `r<c>` (before the first iteration,
 * each given node's regrets are set to c × pot × the given share of each
 * action, so regret matching plays that mix there). Nothing else is seeded.
 *
 * Each run is stepped and stopped exactly as solveLite stops (trackSettle with
 * the preset's settle options), and its root play is scored as napkin.ts
 * scores it: loss at the stored solve's per-action EVs, % of pot. The given
 * play is scored the same way.
 */

import { readFileSync } from 'node:fs';
import { createRun, defineSpot, litePreset, trackSettle } from '../../src/index.ts';
import type { SettleOptions, Solution } from '../../src/index.ts';
import { comboIndex, parseCard } from '../../src/cards.ts';
import { ActionKind } from '../../src/tree.ts';
import { REGRET_STEPS, writeBlock } from '../../src/warm.ts';
import { rootPlayNodes } from '../../src/settle.ts';
import { matchLabel, napkinNodes, napkinSpots, nodeAt } from '../reference/napkinpoker.ts';

const [seedArg, variantArg, workerArg] = process.argv.slice(2);
const given: { id: string; nodes: { path: string[]; player: number; actions: unknown[]; shares: Record<string, number[]> }[] }[] =
	JSON.parse(readFileSync(seedArg, 'utf8'));
const variants = variantArg.split(',');
const workers = Number(workerArg ?? 4);
const flop = napkinNodes('flop');

type Shares = Map<number, number[]>; // combo -> share per tree edge

/** napkinpoker's play at a node, mapped onto the tree's edges. */
function napkinShares(spotTree: Solution['spot']['tree'], node: number, result: any): Shares {
	const edges = Array.from({ length: spotTree.numEdges[node] }, (_, e) => spotTree.firstEdge[node] + e);
	const bets = edges.filter((e) => spotTree.edgeAction[e] === ActionKind.Bet).sort((a, b) => spotTree.edgeTarget[a] - spotTree.edgeTarget[b]);
	const napkinBets = result.actions.map((a: any, k: number) => ({ ...a, k })).filter((a: any) => a.action === 'bet').sort((a: any, b: any) => a.amount - b.amount);
	if (bets.length !== napkinBets.length) throw new Error(`bets: tree ${bets.length}, napkin ${napkinBets.length}`);
	const edgeOf = result.actions.map((a: any, k: number) => {
		if (a.action === 'bet') return bets[napkinBets.findIndex((b: any) => b.k === k)];
		const kind = a.action === 'check' ? ActionKind.Check : a.action === 'allin' ? ActionKind.AllIn : -1;
		const edge = edges.find((e) => spotTree.edgeAction[e] === kind);
		if (edge === undefined) throw new Error(`no edge for ${a.action}`);
		return edge;
	});
	const shares: Shares = new Map();
	for (const [name, given] of Object.entries(result.shares as Record<string, number[]>)) {
		const combo = comboIndex(parseCard(name.slice(0, 2)), parseCard(name.slice(2, 4)));
		const row = new Array(edges.length).fill(0);
		given.forEach((share, k) => (row[edgeOf[k] - spotTree.firstEdge[node]] += share));
		shares.set(combo, row);
	}
	return shares;
}

/** Set the regrets at `node` so regret matching plays `shares`, at c × pot. */
function seed(run: ReturnType<typeof createRun>, node: number, shares: Shares, c: number): void {
	const ctx = run.solver.ctx as any;
	const tree = run.spot.tree;
	const owner = tree.player[node];
	const actions = tree.numEdges[node];
	const slot = (ctx.active.roundBase[0] + 0) * 2 + owner;
	const start = ctx.active.start[slot];
	const count = ctx.active.count[slot];
	const values = new Float64Array(actions * count);
	const scale = c * tree.pot[node];
	for (let i = 0; i < count; i++) {
		const first = ctx.active.memberStart[start + i];
		const end = ctx.active.memberStart[start + i + 1];
		for (let m = first; m < end; m++) {
			const row = shares.get(ctx.active.memberCombo[m]);
			if (!row) continue;
			for (let a = 0; a < actions; a++) values[a * count + i] += (scale * row[a]) / (end - first);
		}
	}
	if (ctx.layout.compactFrom === 0) throw new Error('compact flop storage not handled');
	const block = ctx.layout.blockOffset[node];
	const base = ctx.layout.offset[node] + actions * ctx.layout.rowStart[slot];
	writeBlock(ctx.regret, ctx.regretScale, REGRET_STEPS, block, base, actions * count, values);
}

function rootLoss(sol: Solution, id: string, pot: number): number[] {
	return ([[[], 0], [['X'], 1]] as const).map(([path, actor]) => {
		const stored = flop.find((n) => n.spot === id && n.path.join() === path.join())!;
		if (stored.actor !== actor) throw new Error('actor');
		const match = nodeAt(sol.spot, path);
		const view = sol.strategyAt(match.node, 0);
		const order = stored.actions.map((label) => matchLabel(match.labels, label));
		const at = new Map<number, number>();
		for (let i = 0; i < view.combos.length; i++) at.set(view.combos[i], i);
		const n = view.actions.length;
		let lost = 0;
		let mass = 0;
		for (let j = 0; j < stored.combos.length; j++) {
			const w = stored.weight[j];
			const i = at.get(stored.combos[j]);
			if (!(w > 0) || i === undefined || stored.ev.some((a) => Number.isNaN(a[j]))) continue;
			let best = -Infinity;
			let played = 0;
			for (let a = 0; a < n; a++) {
				best = Math.max(best, stored.ev[a][j]);
				played += view.probs[i * n + order[a]] * stored.ev[a][j];
			}
			lost += w * (best - played);
			mass += w;
		}
		return (100 * lost) / mass / pot;
	});
}

/** napkinpoker's own root play, scored the same way. */
function napkinLoss(sol: Solution, id: string, pot: number, shares: Shares[]): number[] {
	const nodes = rootPlayNodes(sol);
	return [0, 1].map((d) => {
		const path = d === 0 ? [] : ['X'];
		const stored = flop.find((n) => n.spot === id && n.path.join() === path.join())!;
		const match = nodeAt(sol.spot, path);
		if (match.node !== nodes[d]) throw new Error('node');
		const order = stored.actions.map((label) => matchLabel(match.labels, label));
		let lost = 0;
		let mass = 0;
		for (let j = 0; j < stored.combos.length; j++) {
			const w = stored.weight[j];
			const row = shares[d].get(stored.combos[j]);
			if (!(w > 0) || !row || stored.ev.some((a) => Number.isNaN(a[j]))) continue;
			let best = -Infinity;
			let played = 0;
			for (let a = 0; a < stored.actions.length; a++) {
				best = Math.max(best, stored.ev[a][j]);
				played += row[order[a]] * stored.ev[a][j];
			}
			lost += w * (best - played);
			mass += w;
		}
		return (100 * lost) / mass / pot;
	});
}

const all = napkinSpots();
for (const { id, nodes: givenNodes } of given) {
	const s = all.find((x) => x.id === id)!;
	const preset = litePreset({ ...s.config, maxBytes: 3 * 2 ** 30 }, { workers });
	const spot = defineSpot(preset.config);
	const nodes = rootPlayNodes({ spot } as Solution);
	const shares = nodes.map((node, d) => {
		const at = givenNodes.find((n) => n.path.join() === (d === 0 ? '' : 'X'));
		if (!at || nodeAt(spot, at.path).node !== node) throw new Error(`${id}: no given play at node ${node}`);
		return napkinShares(spot.tree, node, at);
	});
	for (const variant of variants) {
		const run = createRun(spot, preset.options);
		if (variant !== 'cold' && !variant.startsWith('cold')) {
			const c = Number(variant.slice(1));
			nodes.forEach((node, d) => seed(run, node, shares[d], c));
		}
		const tracker = trackSettle(preset.options.settle as SettleOptions);
		const every = (preset.options.settle as SettleOptions).every ?? 20;
		const t = performance.now();
		let done = 0;
		const trail: string[] = [];
		while (done < (preset.options.iterations ?? 2000)) {
			run.step(every);
			done += every;
			const settled = tracker.check(run.snapshot(), done);
			if (done <= 100 || done % 100 === 0) trail.push(`${done}:${tracker.movement.toFixed(3)}`);
			if (settled) break;
		}
		const seconds = (performance.now() - t) / 1000;
		const sol = run.snapshot();
		const loss = rootLoss(sol, id, s.config.pot);
		const napkin = napkinLoss(sol, id, s.config.pot, shares);
		run.close();
		console.log(JSON.stringify({
			id, potType: s.potType, board: s.config.board, variant, iterations: done, seconds: +seconds.toFixed(1),
			loss: loss.map((x) => +x.toFixed(4)), napkinLoss: napkin.map((x) => +x.toFixed(4)), trail: trail.join(' '),
		}));
	}
}
