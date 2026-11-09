import { defineSpot } from '../../src/index.ts';
import type { SpotConfig } from '../../src/index.ts';
const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const base = { board: process.argv[2] ?? 'As Kh 7d', pot: 55, stack: 975, oop: OOP, ip: IP, maxBytes: 2 ** 50 } as const;
const three = [0.33, 0.75, 1.5];
const variants: Record<string, Partial<SpotConfig>> = {
	T: { betSizes: [three], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3 },
	'T thr0.67': { betSizes: [three], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3, allInThreshold: 0.67 },
	'r1 / raise 0.75 noallin': { betSizes: [three, three, [0.75]], raiseSizes: [[0.75]], allowAllIn: false, maxRaises: 3 },
	'r1 / raise 0.75 noallin thr.67': { betSizes: [three, three, [0.75]], raiseSizes: [[0.75]], allowAllIn: false, maxRaises: 3, allInThreshold: 0.67 },
	'r1 / raise allin': { betSizes: [three, three, [0.75]], raiseSizes: [['allin']], allowAllIn: false, maxRaises: 3 },
	'r1 / raise 0.75+allin thr.67': { betSizes: [three, three, [0.75]], raiseSizes: [[0.75]], allowAllIn: true, maxRaises: 3, allInThreshold: 0.67 },
	'r1 / raise 0.75 noallin, mR [3,2,2]': { betSizes: [three, three, [0.75]], raiseSizes: [[0.75]], allowAllIn: false, maxRaises: [3, 2, 2] },
	'r1 / raise 0.75 noallin, mR [2,2,2]': { betSizes: [three, three, [0.75]], raiseSizes: [[0.75]], allowAllIn: false, maxRaises: 2 },
	'r1 / raise [.75+ai, ai, .75] mR3': { betSizes: [three, three, [0.75]], raiseSizes: [[0.75, 'allin'], ['allin'], [0.75]], allowAllIn: false, maxRaises: 3 },
	'2 sizes turn [.33,1.5]?': { betSizes: [three, [0.33, 1.5], [0.75]], raiseSizes: [[0.75]], allowAllIn: false, maxRaises: 3 },
	'oop 1 size, ip 3': { betSizes: { oop: [three, [0.75], [0.75]], ip: [three, three, [0.75]] }, raiseSizes: [[0.75]], allowAllIn: false, maxRaises: 3 },
};
const GiB = 2 ** 30;
for (const [name, v] of Object.entries(variants)) {
	const spot = defineSpot({ ...base, ...v } as SpotConfig);
	const e = spot.estimate;
	console.log(name.padEnd(48), 'f32', (e.bytes / GiB).toFixed(2), 'i16', (e.compressedBytes / GiB).toFixed(2), 'GiB  nodes', e.decisionNodes, 'slots', (e.totalSlots / 1e9).toFixed(2), 'G');
}
