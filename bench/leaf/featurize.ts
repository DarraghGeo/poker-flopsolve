/**
 * Network inputs for the turn-leaf experiment: each row of a dataset file
 * with features a per-hand MLP reads, written as float32 for numpy.
 *
 *   node --import tsx bench/leaf/featurize.ts <in.jsonl,...> <out.f32>
 *
 * Per hand: equity, its river-by-river equity histogram (hand potential),
 * percentile within its own range, made/draw class one-hot, outs. Per public
 * state: both ranges' equity histograms, the player, pot and stack-to-pot.
 * Then the target, EV / pot, and the row's weight w * m, and the spot id.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { COMBO_CARDS, COMBOS, DECK, evaluateCards, parseCards } from '../../src/index.ts';
import type { Row } from './lib.ts';

const HAND_BINS = 6;
const RANGE_BINS = 8;
export const WIDTH = 1 + HAND_BINS + 1 + 1 + 1 + 6 + 1 + 2 * RANGE_BINS + 1 + 1 + 1;

const [inputs, out] = process.argv.slice(2);
const chunks: Float32Array[] = [];
let count = 0;
for (const file of inputs.split(',')) {
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line) continue;
		const s = JSON.parse(line) as { id: number; board?: string; pot: number; stack: number; rows: (Row & { board?: number[] })[]; label?: string; cards?: number[] };
		const board = s.board ? parseCards(s.board) : (s.cards as number[]);
		const block = featurize(s.id, board, s.pot, s.stack, s.rows);
		chunks.push(block);
		count += block.length / (WIDTH + 3);
	}
}
const all = new Float32Array(count * (WIDTH + 3));
let at = 0;
for (const c of chunks) { all.set(c, at); at += c.length; }
writeFileSync(out, Buffer.from(all.buffer));
console.log(`${count} rows x ${WIDTH} features -> ${out}`);

function featurize(id: number, board: number[], pot: number, stack: number, rows: Row[]): Float32Array {
	const reach = [new Float64Array(COMBOS), new Float64Array(COMBOS)];
	for (const r of rows) reach[r.player][r.combo] = r.w;
	const combos = [0, 1].map((p) => rows.filter((r) => r.player === p).map((r) => r.combo));
	// Equity of each hand against the other range on every river card.
	const dead = new Set(board);
	const rivers = [...Array(DECK).keys()].filter((c) => !dead.has(c));
	const perRiver = [0, 1].map(() => new Map<number, number[]>());
	const cards = [...board, 0, 0, 0];
	const strength = new Int32Array(COMBOS);
	for (const river of rivers) {
		cards[4] = river;
		for (const p of [0, 1]) for (const c of combos[p]) {
			cards[5] = COMBO_CARDS[c * 2]; cards[6] = COMBO_CARDS[c * 2 + 1];
			strength[c] = evaluateCards(cards);
		}
		for (const p of [0, 1]) {
			for (const a of combos[p]) {
				const a0 = COMBO_CARDS[a * 2], a1 = COMBO_CARDS[a * 2 + 1];
				if (a0 === river || a1 === river) continue;
				let win = 0, tot = 0;
				for (const b of combos[1 - p]) {
					const b0 = COMBO_CARDS[b * 2], b1 = COMBO_CARDS[b * 2 + 1];
					if (b0 === river || b1 === river || b0 === a0 || b0 === a1 || b1 === a0 || b1 === a1) continue;
					const w = reach[1 - p][b];
					tot += w;
					win += strength[a] > strength[b] ? w : strength[a] === strength[b] ? w / 2 : 0;
				}
				if (tot > 0) {
					let list = perRiver[p].get(a);
					if (!list) perRiver[p].set(a, (list = []));
					list.push(win / tot);
				}
			}
		}
	}
	// Each range's histogram of hand equities, weighted by w * m.
	const hist = [0, 1].map((p) => {
		const h = new Float64Array(RANGE_BINS);
		let t = 0;
		for (const r of rows) if (r.player === p) { h[Math.min(RANGE_BINS - 1, Math.floor(r.eq * RANGE_BINS))] += r.w * r.m; t += r.w * r.m; }
		return h.map((x) => x / t);
	});
	const sorted = [0, 1].map((p) => rows.filter((r) => r.player === p).sort((a, b) => a.eq - b.eq));
	const pct = new Map<string, number>();
	for (const p of [0, 1]) {
		const list = sorted[p];
		let t = 0, acc = 0;
		for (const r of list) t += r.w * r.m;
		for (const r of list) { acc += r.w * r.m; pct.set(`${p}|${r.combo}`, (acc - (r.w * r.m) / 2) / t); }
	}
	const outRows = new Float32Array(rows.length * (WIDTH + 3));
	rows.forEach((r, i) => {
		const x = outRows.subarray(i * (WIDTH + 3), (i + 1) * (WIDTH + 3));
		let k = 0;
		x[k++] = r.eq;
		const eqs = perRiver[r.player].get(r.combo) ?? [r.eq];
		for (const e of eqs) x[k + Math.min(HAND_BINS - 1, Math.floor(e * HAND_BINS))] += 1 / eqs.length;
		k += HAND_BINS;
		x[k++] = eqs.reduce((a, e) => a + e * e, 0) / eqs.length; // E[eq^2], potential
		x[k++] = pct.get(`${r.player}|${r.combo}`)!;
		x[k++] = r.outs / 20;
		x[k + r.cls6] = 1;
		k += 6;
		x[k++] = r.rangeEq;
		for (const v of hist[r.player]) x[k++] = v;
		for (const v of hist[1 - r.player]) x[k++] = v;
		x[k++] = r.player;
		x[k++] = stack / pot;
		x[k++] = pot / 100;
		// Target, weight, spot id.
		x[k++] = r.ev / pot;
		x[k++] = r.w * r.m;
		x[k++] = id;
		void x; void k;
	});
	return outRows;
}
