/**
 * A compressed blueprint's turn re-solve, with its ranges rebuilt and
 * without, against the same re-solve from a blueprint of the full ranges.
 *
 *   node --import tsx bench/range-compress/resolve.ts [board,...] [workers] [tolerance,...]
 *
 * Boards and betting as `measure.ts`; `RANGES=<file>` likewise. For each
 * board it solves `solveLite` as it is, again to half the settle tolerance,
 * and with `compressRanges` at each tolerance (default 0.01), then re-solves
 * the turn (`LiteSolution.resolve`, 200 iterations) after check, check and
 * after check, the smallest bet, call, on up to three turn cards every
 * blueprint deals. Each re-solve is compared with the plain blueprint's at
 * the subgame's root and at in position's decision after a check there:
 *
 *   per hand   how far a hand's action frequencies are from the reference's,
 *              in points, averaged over the reference's range
 *   over 25    the share of that range more than 25 points off
 *   missing    the share of that range the re-solve has no strategy for
 *   range      how far the range's action frequencies are, in points
 *
 * `again` shows how far two re-solves from blueprints of the same full
 * ranges are apart.
 */

import { readFileSync } from 'node:fs';
import { formatCard, NodeKind, rootPlay, solveLite } from '../../src/index.ts';
import type { LiteSolution, ResolvedSubgame, SolveLiteOptions, SpotConfig } from '../../src/index.ts';
import { BOARDS, full, type Board } from '../blueprint-share/spots.ts';

const [boardArg, workerArg, toleranceArg] = process.argv.slice(2);
const boards = (boardArg ?? Object.keys(BOARDS).join(',')).split(',') as Board[];
const WORKERS = Number(workerArg ?? 4);
const tolerances = (toleranceArg ?? '0.01').split(',').map(Number);
const TURNS = ['2s', '7h', 'Jd', 'Ks', '5d', 'Ah', '9d', 'Qh', '3s', '6h', 'Td', '8s', '4d'];

interface Gap { hand: number; over: number; missing: number; range: number; n: number }
const zero = (): Gap => ({ hand: 0, over: 0, missing: 0, range: 0, n: 0 });

/** One re-solve against the reference, over the two decisions of the subgame's root play. */
function compare(reference: ResolvedSubgame, other: ResolvedSubgame, into: Gap): void {
	const a = rootPlay(reference.solution);
	const b = rootPlay(other.solution);
	for (let d = 0; d < a.views.length; d++) {
		const view = a.views[d];
		const actions = view.actions.length;
		const theirs = b.views[d];
		const at = new Map<number, number>();
		theirs.combos.forEach((combo, h) => at.set(combo, h));
		let total = 0;
		let present = 0;
		let hand = 0;
		let over = 0;
		const mine = new Array<number>(actions).fill(0);
		for (let h = 0; h < view.combos.length; h++) {
			const combo = view.combos[h];
			const weight = a.weights[d][combo];
			if (!(weight > 0)) continue;
			total += weight;
			for (let x = 0; x < actions; x++) mine[x] += weight * view.probs[h * actions + x];
			const k = at.get(combo);
			if (k === undefined || !(b.weights[d][combo] > 0)) continue;
			let tv = 0;
			for (let x = 0; x < actions; x++) tv += Math.abs(view.probs[h * actions + x] - theirs.probs[k * actions + x]);
			tv /= 2;
			present += weight;
			hand += weight * tv;
			if (tv > 0.25) over += weight;
		}
		const yours = new Array<number>(actions).fill(0);
		let yourTotal = 0;
		for (let k = 0; k < theirs.combos.length; k++) {
			const weight = b.weights[d][theirs.combos[k]];
			yourTotal += weight;
			for (let x = 0; x < actions; x++) yours[x] += weight * theirs.probs[k * actions + x];
		}
		let range = 0;
		for (let x = 0; x < actions; x++) range += Math.abs(mine[x] / total - yours[x] / yourTotal);
		into.hand += present > 0 ? hand / present : 0;
		into.over += present > 0 ? over / present : 0;
		into.missing += 1 - present / total;
		into.range += range / 2;
		into.n++;
	}
}

function timed<T>(work: () => T): { value: T; seconds: number } {
	const start = performance.now();
	const value = work();
	return { value, seconds: (performance.now() - start) / 1000 };
}

for (const board of boards) {
	let config: SpotConfig = full(board);
	if (process.env.RANGES) {
		const [oop, ip] = readFileSync(process.env.RANGES, 'utf8').split('\n').filter(Boolean);
		config = { ...config, oop, ip };
	}
	const lite = (options: SolveLiteOptions): { value: LiteSolution; seconds: number } => timed(() => solveLite(config, { workers: WORKERS, ...options }));
	const plain = lite({});
	const blueprints: [string, { value: LiteSolution; seconds: number }, boolean | undefined][] = [['again (tighter)', lite({ settle: { tolerance: 0.005 } }), undefined]];
	for (const tolerance of tolerances) {
		const solved = lite({ compressRanges: { tolerance } });
		blueprints.push([`${tolerance}, rebuilt`, solved, true], [`${tolerance}, kept only`, solved, false]);
	}
	// The turn cards every blueprint deals, and the two lines' opening nodes.
	const cardsOf = (solution: LiteSolution): string[] => {
		const { runouts } = solution.solution.spot;
		const width = runouts.width[1];
		return Array.from({ length: runouts.counts[1] }, (_, b) => formatCard(runouts.cards[1][b * width + width - 1]));
	};
	const dealt = [plain, ...blueprints.map(([, b]) => b)].map((b) => cardsOf(b.value));
	const cards = TURNS.filter((card) => dealt.every((list) => list.includes(card))).slice(0, 3);
	const { tree } = plain.value.solution.spot;
	const opening = [...tree.kind.keys()].filter((n) => tree.round[n] === 1 && tree.kind[n] === NodeKind.Decision && plain.value.solution.path(n).endsWith('/'));
	const lines = [
		opening.find((n) => plain.value.solution.path(n) === 'check check /')!,
		opening.find((n) => /^check bet [\d.]+ call \/$/.test(plain.value.solution.path(n)))!,
	];
	const resolve = (from: LiteSolution, node: number, card: string, rebuild: boolean | undefined): { value: ResolvedSubgame; seconds: number } =>
		timed(() => from.resolve(node, cardsOf(from).indexOf(card), { player: 0, iterations: 200, ...(rebuild === undefined ? {} : { rebuild }) }));

	console.log(`\n${board} (${config.board}), ${WORKERS} threads; turns ${cards.join(' ')} after ${lines.map((n) => `"${plain.value.solution.path(n)}"`).join(' and ')}`);
	console.log('turn re-solved from     combos    blueprint   re-solve   per hand   over 25   missing    range');
	const gaps = blueprints.map(() => zero());
	const seconds = blueprints.map(() => 0);
	let referenceSeconds = 0;
	let count = 0;
	for (const node of lines) {
		for (const card of cards) {
			const reference = resolve(plain.value, node, card, undefined);
			referenceSeconds += reference.seconds;
			count++;
			blueprints.forEach(([, from, rebuild], i) => {
				const other = resolve(from.value, node, card, rebuild);
				seconds[i] += other.seconds;
				compare(reference.value, other.value, gaps[i]);
			});
		}
	}
	const combos = (solution: LiteSolution): string => `${solution.solution.spot.players[0].count}/${solution.solution.spot.players[1].count}`;
	console.log(`${'plain lite'.padEnd(22)} ${combos(plain.value).padEnd(9)} ${plain.seconds.toFixed(1).padStart(7)} s ${(referenceSeconds / count).toFixed(1).padStart(7)} s`);
	blueprints.forEach(([name, from], i) => {
		const g = gaps[i];
		console.log(`${name.padEnd(22)} ${combos(from.value).padEnd(9)} ${from.seconds.toFixed(1).padStart(7)} s ${(seconds[i] / count).toFixed(1).padStart(7)} s ${((100 * g.hand) / g.n).toFixed(1).padStart(9)} ${((100 * g.over) / g.n).toFixed(0).padStart(8)}% ${((100 * g.missing) / g.n).toFixed(0).padStart(8)}% ${((100 * g.range) / g.n).toFixed(1).padStart(8)}`);
	});
}
