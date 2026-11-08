/**
 * Storage of each grafting piece of R on the issue's two flops (issue #56),
 * against R, the blueprint and T, by `defineSpot`'s estimate.
 *
 *   node --import tsx bench/graft/pieces.ts
 */
import { defineSpot } from '../../src/index.ts';
import { openingActions, pieceSpot } from './graft.ts';
import { baseGame, BOARDS, flopGame, target } from './spots.ts';

const mib = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(0)} MiB`;
for (const [name, board] of Object.entries(BOARDS)) {
	const config = flopGame(board);
	const spot = defineSpot(config);
	const { tree, potUnits, players } = spot;
	const root = openingActions(tree, 0, potUnits);
	const check = root.find((a) => a.check)!.edge;
	const after = tree.edgeChild[tree.firstEdge[0] + check];
	const rows: [string, number, number][] = [];
	for (const a of root) if (!a.check) {
		const e = pieceSpot(config, new Map([[0, a.edge]]), players[0].weights, players[1].weights).estimate;
		rows.push([`P ${a.label}`, e.bytes, e.compressedBytes]);
	}
	for (const b of openingActions(tree, after, potUnits)) {
		const e = pieceSpot(config, new Map([[0, check], [after, b.edge]]), players[0].weights, players[1].weights).estimate;
		rows.push([b.check ? 'X' : `Q ${b.label}`, e.bytes, e.compressedBytes]);
	}
	for (const [label, make] of [['blueprint (0.75)', baseGame], ['R', flopGame], ['T', target]] as const) {
		const e = defineSpot(make(board)).estimate;
		rows.push([label, e.bytes, e.compressedBytes]);
	}
	console.log(`\n${name} (${board})`);
	for (const [label, f32, i16] of rows) console.log(`  ${label.padEnd(18)} ${mib(f32).padStart(10)} f32 ${mib(i16).padStart(10)} i16`);
}
