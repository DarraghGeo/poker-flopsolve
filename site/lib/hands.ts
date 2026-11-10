/**
 * The 13×13 hand grid and range notation for the benchmark page.
 *
 * Purpose: map between the grid the page paints (one weight per hand class)
 * and the range notation the solver reads, both ways.
 *
 * Cells run row-major with aces first on both axes: the diagonal holds the
 * pairs, above it the suited hands, below it the offsuit ones. A card is the
 * solver's `rank * 4 + suit`, rank 0 the deuce (src/cards.ts).
 */

/** Ranks as the grid shows them, aces first. */
export const GRID_RANKS = 'AKQJT98765432';

/** Hand classes on the grid. */
export const CELLS = 169;

/** Two-card combinations in a deck. */
export const TOTAL_COMBOS = 1326;

/** What sort of hand class a cell holds. */
export type CellKind = 'pair' | 'suited' | 'offsuit';

/** The solver's rank (0 = deuce) of a grid row or column (0 = ace). */
const rankAt = (index: number): number => 12 - index;

/** A cell's row and column. */
export function cellPosition(cell: number): { row: number; col: number } {
	return { row: Math.floor(cell / 13), col: cell % 13 };
}

/** Pair, suited (above the diagonal) or offsuit (below). */
export function cellKind(cell: number): CellKind {
	const { row, col } = cellPosition(cell);
	return row === col ? 'pair' : row < col ? 'suited' : 'offsuit';
}

/** A cell's name: "AA", "AKs", "AKo". */
export function cellLabel(cell: number): string {
	const { row, col } = cellPosition(cell);
	const high = GRID_RANKS[Math.min(row, col)];
	const low = GRID_RANKS[Math.max(row, col)];
	const kind = cellKind(cell);
	return kind === 'pair' ? high + low : high + low + (kind === 'suited' ? 's' : 'o');
}

/** Combinations in a cell: 6 for a pair, 4 suited, 12 offsuit. */
export function cellCombos(cell: number): number {
	const kind = cellKind(cell);
	return kind === 'pair' ? 6 : kind === 'suited' ? 4 : 12;
}

/** The cell of two hole cards in the solver's encoding. */
export function cellOfCards(a: number, b: number): number {
	const high = Math.max(a >> 2, b >> 2);
	const low = Math.min(a >> 2, b >> 2);
	const hi = 12 - high;
	const lo = 12 - low;
	if (high === low) return hi * 13 + hi;
	return (a & 3) === (b & 3) ? hi * 13 + lo : lo * 13 + hi;
}

/**
 * Cell weights from per-combination weights: each cell the mean of its
 * combinations, rounded to hundredths.
 * @param weights per combination, as `parseRange` returns
 * @param comboCards the two cards of each combination (`COMBO_CARDS`)
 */
export function cellsFromCombos(weights: ArrayLike<number>, comboCards: ArrayLike<number>): Float64Array {
	const sum = new Float64Array(CELLS);
	for (let combo = 0; combo < TOTAL_COMBOS; combo++) {
		sum[cellOfCards(comboCards[combo * 2], comboCards[combo * 2 + 1])] += weights[combo];
	}
	const cells = new Float64Array(CELLS);
	for (let cell = 0; cell < CELLS; cell++) cells[cell] = Math.round((sum[cell] / cellCombos(cell)) * 100) / 100;
	return cells;
}

/** Weighted combinations a grid holds. */
export function comboCount(cells: ArrayLike<number>): number {
	let total = 0;
	for (let cell = 0; cell < CELLS; cell++) total += cells[cell] * cellCombos(cell);
	return total;
}

/** Runs of consecutive ranks, highest first, in a descending list. */
function runs(ranks: readonly number[]): number[][] {
	const out: number[][] = [];
	for (const rank of ranks) {
		const last = out[out.length - 1];
		if (last && last[last.length - 1] === rank + 1) last.push(rank);
		else out.push([rank]);
	}
	return out;
}

const char = (rank: number): string => GRID_RANKS[12 - rank];

/** Notation for a set of cells: pairs, then suited and offsuit hands by their high card. */
function notationOf(cells: ReadonlySet<number>): string[] {
	const parts: string[] = [];
	const pairs: number[] = [];
	for (let index = 0; index < 13; index++) if (cells.has(index * 13 + index)) pairs.push(rankAt(index));
	for (const run of runs(pairs)) {
		const top = run[0];
		const bottom = run[run.length - 1];
		const name = (rank: number): string => char(rank) + char(rank);
		if (run.length === 1) parts.push(name(top));
		else if (top === 12) parts.push(`${name(bottom)}+`);
		else parts.push(`${name(top)}-${name(bottom)}`);
	}
	for (const kind of ['s', 'o'] as const) {
		for (let hi = 0; hi < 12; hi++) {
			const kickers: number[] = [];
			for (let lo = hi + 1; lo < 13; lo++) {
				const cell = kind === 's' ? hi * 13 + lo : lo * 13 + hi;
				if (cells.has(cell)) kickers.push(rankAt(lo));
			}
			const high = rankAt(hi);
			for (const run of runs(kickers)) {
				const top = run[0];
				const bottom = run[run.length - 1];
				const name = (low: number): string => char(high) + char(low) + kind;
				if (run.length === 1) parts.push(name(top));
				else if (top === high - 1) parts.push(`${name(bottom)}+`);
				else parts.push(`${name(top)}-${name(bottom)}`);
			}
		}
	}
	return parts;
}

/** Format a weight as notation does: "0.5", "0.25". */
const weightText = (weight: number): string => String(Math.round(weight * 100) / 100);

/**
 * Range notation for a grid, compressed: "TT+,A2s+,KQo,99:0.5". Cells are
 * grouped by weight, full weight first; a cell at 0 is left out.
 */
export function rangeOfCells(cells: ArrayLike<number>): string {
	const groups = new Map<number, Set<number>>();
	for (let cell = 0; cell < CELLS; cell++) {
		const weight = Math.round(Math.min(1, Math.max(0, cells[cell])) * 100) / 100;
		if (weight <= 0) continue;
		if (!groups.has(weight)) groups.set(weight, new Set());
		groups.get(weight)!.add(cell);
	}
	const parts: string[] = [];
	for (const weight of [...groups.keys()].sort((a, b) => b - a)) {
		const suffix = weight === 1 ? '' : `:${weightText(weight)}`;
		for (const part of notationOf(groups.get(weight)!)) parts.push(part + suffix);
	}
	return parts.join(',');
}
