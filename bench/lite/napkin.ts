/**
 * Issue #100: lite mode on napkinpoker's reference spots (issue #87), its
 * root play scored at postflop-solver's stored per-action EVs.
 *
 *   node --import tsx bench/lite/napkin.ts [count] [variant,...]
 *
 * The stored spots are a different game from the blueprint lite solves: two
 * flop sizes, 75% on the turn and river, a 3× raise and all-in every street,
 * solved whole to 0.3% of pot. Lite keeps their flop and plays one 75% bet
 * and no raise or shove on the turn and river. So this measures what the lite
 * blueprint's root play gives up against the full game's own values, on real
 * weighted ranges and every texture, with the stored solve's 0.3% precision
 * as the floor (see the fixtures' README).
 *
 * Spots: `count` (default 8) picked to spread textures: the first stored spot
 * of each (pot type, texture) pair, in id order, round robin.
 *
 * Variants: `base` (`solveLite` defaults, one thread), `unshared` (lite's tree
 * with no sharing or sampling, 4 threads, stopped by the same rule), and
 * `minWeight=<w>`.
 *
 * Root play loss: for OOP at the root and IP after a check, each hand's best
 * stored action EV minus the stored EV of the mix lite plays, weighted by the
 * stored reach, as % of the pot. The stored solve's own play, scored the same
 * way, is printed beside it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { solveLite } from '../../src/index.ts';
import type { SolveLiteOptions } from '../../src/index.ts';
import { matchLabel, napkinNodes, napkinSpots, nodeAt } from '../reference/napkinpoker.ts';

const [countArg, variantArg] = process.argv.slice(2);
const COUNT = Number(countArg ?? 8);
const variant = variantArg ?? 'base';

function texture(board: string): string {
	const cards = board.replaceAll(' ', '').match(/../g)!;
	const suits = new Set(cards.map((c) => c[1])).size;
	const paired = new Set(cards.map((c) => c[0])).size < cards.length;
	return `${paired ? 'paired ' : ''}${suits === 1 ? 'monotone' : suits === 2 ? 'two-tone' : 'rainbow'}`;
}

const all = napkinSpots();
const groups = new Map<string, typeof all>();
for (const s of all) {
	const key = `${s.potType} ${texture(s.config.board)}`;
	groups.set(key, [...(groups.get(key) ?? []), s]);
}
const picked: typeof all = [];
for (let round = 0; picked.length < COUNT; round++) {
	let added = false;
	for (const list of groups.values()) {
		if (picked.length >= COUNT) break;
		if (list[round]) {
			picked.push(list[round]);
			added = true;
		}
	}
	if (!added) break;
}

const flop = napkinNodes('flop');
const options: SolveLiteOptions =
	variant === 'unshared' ? { workers: 4, shareHistories: false, sampling: false } : { workers: 1 };
const rows: unknown[] = [];
for (const s of picked) {
	const config = variant.startsWith('minWeight=') ? { ...s.config, minWeight: Number(variant.slice(10)) } : s.config;
	const t = performance.now();
	const lite = solveLite({ ...config, maxBytes: 3 * 2 ** 30 }, options);
	const seconds = (performance.now() - t) / 1000;
	const sol = lite.solution;
	const pot = s.config.pot;
	const losses = (
		[
			[[], 0],
			[['X'], 1],
		] as const
	).map(([path, actor]) => {
		const stored = flop.find((n) => n.spot === s.id && n.path.join() === path.join());
		if (!stored || stored.actor !== actor) throw new Error(`${s.id}: no stored node at ${path.join(' ') || 'root'}`);
		const match = nodeAt(sol.spot, path);
		const view = sol.strategyAt(match.node, 0);
		// The stored action each of ours is.
		const order = stored.actions.map((label) => {
			const i = matchLabel(match.labels, label);
			if (i < 0) throw new Error(`${s.id}: stored action ${label} not among ${match.labels}`);
			return i;
		});
		const at = new Map<number, number>();
		for (let i = 0; i < view.combos.length; i++) at.set(view.combos[i], i);
		const n = view.actions.length;
		if (n !== stored.actions.length) throw new Error(`${s.id}: ${n} actions against ${stored.actions.length}`);
		let lost = 0;
		let own = 0;
		let mass = 0;
		for (let j = 0; j < stored.combos.length; j++) {
			const w = stored.weight[j];
			const i = at.get(stored.combos[j]);
			if (!(w > 0) || i === undefined || stored.ev.some((a) => Number.isNaN(a[j]))) continue;
			let best = -Infinity;
			let played = 0;
			let theirs = 0;
			for (let a = 0; a < n; a++) {
				const ev = stored.ev[a][j];
				best = Math.max(best, ev);
				played += view.probs[i * n + order[a]] * ev;
				theirs += stored.strategy[a][j] * ev;
			}
			lost += w * (best - played);
			own += w * (best - theirs);
			mass += w;
		}
		return { lite: (100 * lost) / mass / pot, stored: (100 * own) / mass / pot };
	});
	const row = {
		id: s.id, name: s.name, potType: s.potType, texture: texture(s.config.board),
		storageMiB: lite.solution.spot.estimate.bytes / 2 ** 20, iterations: sol.iterations, stoppedAt: sol.stoppedAt, seconds,
		loss: losses.map((l) => l.lite), storedLoss: losses.map((l) => l.stored),
	};
	rows.push(row);
	console.log(
		`${s.id} ${s.name} (${s.potType}, ${row.texture}): ${row.storageMiB.toFixed(0)} MiB, ${sol.stoppedAt} at ${sol.iterations} it, ${seconds.toFixed(1)} s; ` +
			`root play loss ${row.loss.map((x) => x.toFixed(3)).join(' / ')}% of pot (stored solve's own ${row.storedLoss.map((x) => x.toFixed(3)).join(' / ')})`,
	);
}
const mean = (k: 'loss' | 'storedLoss', d: number): number =>
	(rows as { loss: number[]; storedLoss: number[] }[]).reduce((sum, r) => sum + r[k][d], 0) / rows.length;
console.log(
	`mean root play loss ${[0, 1].map((d) => mean('loss', d).toFixed(3)).join(' / ')}% of pot; ` +
		`stored solve's own ${[0, 1].map((d) => mean('storedLoss', d).toFixed(3)).join(' / ')}`,
);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/napkin-${variant}.json`, import.meta.url), JSON.stringify(rows, null, 1));
