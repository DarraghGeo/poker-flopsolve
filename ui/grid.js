/**
 * Hand-matrix geometry.
 *
 * Purpose: the one place hole-card combinations are bucketed into grid cells.
 *
 * This runs in the browser, so it cannot import the library — it re-derives the
 * card encoding (`card = rank * suits + suit`) from first principles, which for
 * a 52-card deck is exactly `rank * 4 + suit`. That duplication is deliberate
 * but load-bearing, so `test/grid.test.ts` asserts the hand ordering here
 * reproduces the solver's own combination indexing exactly.
 *
 * Copied from the parameterised solver alongside this package rather than
 * imported, so this package stays self-contained if it is split out.
 *
 * Layout for two hole cards is the conventional one: ranks descending on both
 * axes, pairs on the diagonal, suited above it, offsuit below.
 */

/**
 * @typedef {'pair'|'suited'|'offsuit'|'rank'|'impossible'} CellKind
 *
 * @typedef {object} Geometry
 * @property {'matrix'|'row'|'none'} mode
 * @property {number} rows
 * @property {number} cols
 * @property {number} handCount
 * @property {string[]} rankLabels      descending, highest rank first
 * @property {Int32Array} cellOf        cell index per hand
 * @property {Int32Array} slotOf        column within the cell, per hand
 * @property {Int32Array} cellSlots     columns in each cell; 0 means impossible
 * @property {CellKind[]} cellKind
 * @property {string[]} cellLabel
 */

/**
 * Binomial, only ever called with tiny arguments here.
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
function choose(n, k) {
	if (k < 0 || k > n) return 0;
	let result = 1;
	for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
	return Math.round(result);
}

/**
 * Build the grid layout for a deck.
 *
 * @param {number} ranks
 * @param {number} suits
 * @param {number} holeCards
 * @param {string[]} rankLabels descending, highest first; from the solver
 * @returns {Geometry}
 */
export function buildGeometry(ranks, suits, holeCards, rankLabels) {
	if (holeCards === 1) return rowGeometry(ranks, suits, rankLabels);
	if (holeCards === 2) return matrixGeometry(ranks, suits, rankLabels);
	return {
		mode: /** @type {const} */ ('none'),
		rows: 0,
		cols: 0,
		handCount: 0,
		rankLabels,
		cellOf: new Int32Array(0),
		slotOf: new Int32Array(0),
		cellSlots: new Int32Array(0),
		cellKind: [],
		cellLabel: [],
	};
}

/**
 * One hole card: a single row of ranks, one column per suit.
 * @param {number} ranks
 * @param {number} suits
 * @param {string[]} rankLabels
 * @returns {Geometry}
 */
function rowGeometry(ranks, suits, rankLabels) {
	const deckSize = ranks * suits;
	const cellOf = new Int32Array(deckSize);
	const slotOf = new Int32Array(deckSize);
	const cellSlots = new Int32Array(ranks).fill(suits);

	for (let card = 0; card < deckSize; card++) {
		const rank = (card / suits) | 0;
		cellOf[card] = ranks - 1 - rank;
		slotOf[card] = card % suits;
	}

	return {
		mode: /** @type {const} */ ('row'),
		rows: 1,
		cols: ranks,
		handCount: deckSize,
		rankLabels,
		cellOf,
		slotOf,
		cellSlots,
		cellKind: /** @type {CellKind[]} */ (new Array(ranks).fill('rank')),
		cellLabel: rankLabels.slice(0, ranks),
	};
}

/**
 * Two hole cards: the familiar rank matrix.
 * @param {number} ranks
 * @param {number} suits
 * @param {string[]} rankLabels
 * @returns {Geometry}
 */
function matrixGeometry(ranks, suits, rankLabels) {
	const deckSize = ranks * suits;
	const handCount = choose(deckSize, 2);
	const cells = ranks * ranks;

	// Slot lookups, so the inner loop is two array reads.
	const pairSlot = new Int32Array(suits * suits).fill(-1);
	let n = 0;
	for (let x = 0; x < suits; x++) {
		for (let y = x + 1; y < suits; y++) pairSlot[x * suits + y] = n++;
	}
	const offsuitSlot = new Int32Array(suits * suits).fill(-1);
	n = 0;
	for (let x = 0; x < suits; x++) {
		for (let y = 0; y < suits; y++) {
			if (x !== y) offsuitSlot[x * suits + y] = n++;
		}
	}

	const cellOf = new Int32Array(handCount);
	const slotOf = new Int32Array(handCount);
	const cellSlots = new Int32Array(cells);
	/** @type {CellKind[]} */
	const cellKind = new Array(cells).fill('impossible');
	/** @type {string[]} */
	const cellLabel = new Array(cells).fill('');

	// Hands are enumerated exactly as the solver does: colex order, which for
	// two cards is `for b, for a < b`.
	let hand = 0;
	for (let b = 1; b < deckSize; b++) {
		for (let a = 0; a < b; a++, hand++) {
			const rankA = (a / suits) | 0;
			const rankB = (b / suits) | 0;
			const suitA = a % suits;
			const suitB = b % suits;

			// b > a, so rankB >= rankA: b is the high card unless they tie.
			const high = ranks - 1 - rankB;
			const low = ranks - 1 - rankA;

			let cell;
			let slot;
			/** @type {CellKind} */
			let kind;
			if (rankA === rankB) {
				cell = high * ranks + high;
				slot = pairSlot[Math.min(suitA, suitB) * suits + Math.max(suitA, suitB)];
				kind = 'pair';
			} else if (suitA === suitB) {
				cell = high * ranks + low;
				slot = suitB;
				kind = 'suited';
			} else {
				cell = low * ranks + high;
				slot = offsuitSlot[suitB * suits + suitA];
				kind = 'offsuit';
			}

			cellOf[hand] = cell;
			slotOf[hand] = slot;
			cellKind[cell] = kind;
			if (slot + 1 > cellSlots[cell]) cellSlots[cell] = slot + 1;
		}
	}

	for (let row = 0; row < ranks; row++) {
		for (let col = 0; col < ranks; col++) {
			const cell = row * ranks + col;
			if (cellSlots[cell] === 0) continue;
			const kind = cellKind[cell];
			cellLabel[cell] =
				kind === 'pair'
					? rankLabels[row] + rankLabels[row]
					: kind === 'suited'
						? `${rankLabels[row]}${rankLabels[col]}s`
						: `${rankLabels[col]}${rankLabels[row]}o`;
		}
	}

	return {
		mode: /** @type {const} */ ('matrix'),
		rows: ranks,
		cols: ranks,
		handCount,
		rankLabels,
		cellOf,
		slotOf,
		cellSlots,
		cellKind,
		cellLabel,
	};
}

/**
 * Map a board index back to its ancestor at an earlier round.
 *
 * Board levels are built so that `child = parent * childFactor[round] + local`,
 * so walking up is repeated integer division. Rounds are stepped one at a time
 * rather than assuming the gap is one.
 *
 * @param {ArrayLike<number>} childFactor per-round factors from the solver
 * @param {number} board board index at `round`
 * @param {number} round the board's round
 * @param {number} target the earlier round wanted
 */
export function boardAtRound(childFactor, board, round, target) {
	let index = board;
	for (let r = round; r > target; r--) index = (index / childFactor[r]) | 0;
	return index;
}
