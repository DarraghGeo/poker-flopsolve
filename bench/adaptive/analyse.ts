/**
 * Summarise the size census of a reference solve (issue #51).
 *
 *   node --import tsx bench/adaptive/analyse.ts <board>-<tree>
 *
 * Reads `results/<board>-<tree>.json` and prints, for each street and for
 * opening bets against raises, each size's share of the storage, how often it
 * is used, and the EV it contributes (`CensusRow.evLoss`), with the totals
 * for lines used less than 1% of the time.
 */

import { readFileSync } from 'node:fs';
import type { CensusRow } from './measure.ts';

const name = process.argv[2] ?? 'rainbow-T0';
const data = JSON.parse(readFileSync(new URL(`./results/${name}.json`, import.meta.url), 'utf8')) as {
	census: CensusRow[];
	bytes: number;
};
const rows = data.census;
// Storage is almost all decision slots, 8 bytes each at 32 bits.
const totalSlots = data.bytes / 8;
const streets = ['flop', 'turn', 'river'];

const sizeName = (r: CensusRow): string =>
	r.kind === 'allin' ? 'shove' : `${r.kind} ${Math.abs(r.fraction - 0.33) < 0.03 ? '0.33' : Math.abs(r.fraction - 0.75) < 0.03 ? '0.75' : Math.abs(r.fraction - 1.5) < 0.05 ? '1.5' : r.fraction.toFixed(2)}`;

interface Group {
	lines: number;
	slots: number;
	frequency: number;
	ev: number;
	rareLines: number;
	rareSlots: number;
	rareEv: number;
}
const groups = new Map<string, Group>();
for (const r of rows) {
	const key = `${streets[r.round]} ${r.aggressions === 0 ? 'opening' : `facing ${r.aggressions}`} ${sizeName(r)}`;
	const g = groups.get(key) ?? { lines: 0, slots: 0, frequency: 0, ev: 0, rareLines: 0, rareSlots: 0, rareEv: 0 };
	g.lines++;
	g.slots += r.slots;
	g.frequency += r.frequency;
	g.ev += r.evLoss;
	if (r.frequency < 0.01) {
		g.rareLines++;
		g.rareSlots += r.slots;
		g.rareEv += r.evLoss;
	}
	groups.set(key, g);
}

console.log(`${name}: ${rows.length} sized lines; % of storage below the action, frequency summed over its lines, EV contribution in % of pot`);
console.log('group'.padEnd(34), 'lines', ' storage', '  freq', '     EV', '  | <1%: lines storage     EV');
for (const [key, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
	console.log(
		key.padEnd(34),
		String(g.lines).padStart(5),
		`${((100 * g.slots) / totalSlots).toFixed(1)}%`.padStart(8),
		g.frequency.toFixed(3).padStart(6),
		g.ev.toFixed(3).padStart(7),
		'  |',
		String(g.rareLines).padStart(10),
		`${((100 * g.rareSlots) / totalSlots).toFixed(1)}%`.padStart(7),
		g.rareEv.toFixed(3).padStart(6),
	);
}

// River opening bets by EV per storage, and how much storage the least
// useful hold. These subtrees are disjoint; lines on earlier streets nest.
const ranked = rows.filter((r) => r.round === 2 && r.aggressions === 0).sort((a, b) => a.evLoss / a.slots - b.evLoss / b.slots);
let slots = 0;
let ev = 0;
const marks = [0.25, 0.5, 0.75, 0.9];
let mark = 0;
for (const r of ranked) {
	slots += r.slots;
	ev += Math.max(0, r.evLoss);
	while (mark < marks.length && slots / totalSlots >= marks[mark]) {
		console.log(`least useful river opening bets holding ${(100 * marks[mark]).toFixed(0)}% of storage contribute ${ev.toFixed(3)}% of pot`);
		mark++;
	}
}
console.log('top 15 lines by EV contribution:');
for (const r of [...rows].sort((a, b) => b.evLoss - a.evLoss).slice(0, 15)) {
	console.log(`  ${r.evLoss.toFixed(3)}% freq ${r.frequency.toFixed(3)} storage ${((100 * r.slots) / totalSlots).toFixed(2)}%  ${r.path}`);
}
