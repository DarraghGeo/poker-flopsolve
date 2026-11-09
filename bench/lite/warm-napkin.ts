/**
 * Does seeding a lite solve with napkinpoker's flop play make it settle sooner?
 *
 *   node --import tsx bench/lite/warm-napkin.ts <spot ids,...> <variants,...> [workers]
 *
 * Variants: `cold` (litePreset as is), `r<c>` (before the first iteration,
 * the regrets of OOP at the root and of IP after a check are set to
 * c × pot × napkinpoker's share of each action, so regret matching plays
 * napkinpoker's mix there). Nothing else is seeded: the rest of the tree, the
 * turn and the river start cold. IP's napkinpoker play is computed against
 * OOP's checking range as napkinpoker itself plays it.
 *
 * Each run is stepped and stopped exactly as solveLite stops (trackSettle with
 * the preset's settle options), and its root play is scored as napkin.ts
 * scores it: loss at the stored solve's per-action EVs, % of pot.
 */

import { readFileSync } from 'node:fs';
import { createRun, defineSpot, litePreset, trackSettle } from '../../src/index.ts';
import type { SettleOptions, Solution } from '../../src/index.ts';
import { comboIndex, parseCard } from '../../src/cards.ts';
import { ActionKind } from '../../src/tree.ts';
import { REGRET_STEPS, writeBlock } from '../../src/warm.ts';
import { rootPlayNodes } from '../../src/settle.ts';
import { matchLabel, napkinDir, napkinNodes, napkinSpots, nodeAt } from '../reference/napkinpoker.ts';
// @ts-expect-error plain JavaScript from the sibling checkout
import { approxEV } from '../../../napkinpoker/src/index.js';

const [idArg, variantArg, workerArg] = process.argv.slice(2);
const ids = idArg.split(',');
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
	result.names.forEach((name: string, i: number) => {
		const combo = comboIndex(parseCard(name.slice(0, 2)), parseCard(name.slice(2, 4)));
		const row = new Array(edges.length).fill(0);
		result.actions.forEach((_: unknown, k: number) => (row[edgeOf[k] - spotTree.firstEdge[node]] += result.strategy[k][i]));
		shares.set(combo, row);
	});
	return shares;
}

function rangeString(weights: Map<string, number>): string {
	return [...weights].filter(([, w]) => w > 1e-6).map(([c, w]) => `${c}:${+w.toFixed(5)}`).join(',');
}

/** napkinpoker's OOP root play and IP's play after OOP's check (against OOP's napkin checking range). */
function napkinPlay(stored: any) {
	const oop = approxEV({ board: stored.board, hero: stored.oop, villain: stored.ip, pot: stored.pot, stack: stored.stack, facing: 0, ip: false });
	const check = oop.actions.findIndex((a: any) => a.action === 'check');
	const oopWeights = new Map<string, number>(stored.oop.split(',').map((s: string) => [s.split(':')[0], Number(s.split(':')[1] ?? 1)]));
	const checking = new Map<string, number>();
	oop.names.forEach((name: string, i: number) => checking.set(name, (oopWeights.get(name) ?? 0) * oop.strategy[check][i]));
	const ip = approxEV({
		board: stored.board, hero: stored.ip, villain: rangeString(checking), pot: stored.pot, stack: stored.stack, facing: 0, ip: true,
		line: [[{ player: 0, kind: 'X', amount: 0 }]],
	});
	return [oop, ip];
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
for (const id of ids) {
	const s = all.find((x) => x.id === id)!;
	const stored = JSON.parse(readFileSync(`${napkinDir()}/spots/${id}.json`, 'utf8'));
	const preset = litePreset({ ...s.config, maxBytes: 3 * 2 ** 30 }, { workers });
	const spot = defineSpot(preset.config);
	const t0 = performance.now();
	const play = napkinPlay(stored);
	const napkinSeconds = (performance.now() - t0) / 1000;
	const nodes = rootPlayNodes({ spot } as Solution);
	const shares = nodes.map((node, d) => napkinShares(spot.tree, node, play[d]));
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
			loss: loss.map((x) => +x.toFixed(4)), napkinLoss: napkin.map((x) => +x.toFixed(4)), napkinSeconds: +napkinSeconds.toFixed(1), trail: trail.join(' '),
		}));
	}
}
