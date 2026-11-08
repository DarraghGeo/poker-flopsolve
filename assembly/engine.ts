/**
 * The whole traversal in WebAssembly.
 *
 * Purpose: what `traverse` in src/cfr.ts does, over 32-bit vectors and
 * storage, with SIMD wherever a loop runs over a contiguous row. It is the
 * same algorithm, step for step — deals through the `up` maps, folds and
 * showdowns over the hand lists, regret matching, DCFR or CFR+ updates — so
 * the two engines agree to float precision, and the tests hold them to that.
 *
 * Everything lives in one memory that src/engine.ts lays out: a header of
 * pointers written by `init`, the spot's structures copied in, the storage
 * (which JavaScript reads through views, so queries work unchanged), and one
 * set of buffers per traversal depth.
 */

// Modes, as in src/cfr.ts.
const TRAIN: i32 = 0;
const BEST_RESPONSE: i32 = 1;

// Node kinds, as in src/tree.ts.
const DECISION: u8 = 0;
const CHANCE: u8 = 1;
const FOLD: u8 = 2;

// Header slots; see src/engine.ts, which writes them.
let kind: usize = 0;
let round: usize = 0;
let player: usize = 0;
let firstEdge: usize = 0;
let numEdges: usize = 0;
let edgeChild: usize = 0;
let payoff: usize = 0;
let offset: usize = 0;
let rowStart: usize = 0;
let roundBase: usize = 0;
let listStart: usize = 0;
let listCount: usize = 0;
let cardA: usize = 0;
let cardB: usize = 0;
let strength: usize = 0;
let packed: usize = 0;
let multiplicity: usize = 0;
let memberStart: usize = 0;
let memberA: usize = 0;
let memberB: usize = 0;
let upRound: usize = 0;
let upStart: usize = 0;
let up: usize = 0;
let sameStart: usize = 0;
let same: usize = 0;
let childRound: usize = 0;
let childStart: usize = 0;
let orbitRound: usize = 0;
let orbitStart: usize = 0;
let runoutWeight: usize = 0;
let regret: usize = 0;
let sums: usize = 0;
let buffers: usize = 0;
let depthBytes: usize = 0;
let rowBytes: usize = 0;
let cardSums: usize = 0;
let chipScale: f64 = 1;

// Sharding across threads; see src/parallel.ts for the protocol. At the
// shard round only boards in [shardStart, shardEnd) are walked. In the
// collect phase, a chance node feeding that round records the reach the
// workers need in `exchange` and stops; in the override phase it reads back
// the totals they produced.
let shardRound: i32 = -1;
let shardStart: i32 = 0;
let shardEnd: i32 = 0;
let phase: i32 = 0;
let applyUpdates: bool = true;
let entryIndexOf: usize = 0;
let exchange: usize = 0;
let overrides: usize = 0;
let exchangeStride: usize = 0;

/** Set this thread's slice of the shard round's boards. */
export function setShard(round: i32, start: i32, end: i32): void {
	shardRound = round;
	shardStart = start;
	shardEnd = end;
}

/** Where entries are found and exchanged: per node entry index, reach out, values in, in floats per entry vector. */
export function setExchange(entries: usize, reach: usize, values: usize, stride: i32): void {
	entryIndexOf = entries;
	exchange = reach;
	overrides = values;
	exchangeStride = <usize>stride << 2;
}

/** 0 normal, 1 collect, 2 override; and whether updates apply. */
export function setPhase(value: i32, apply: i32): void {
	phase = value;
	applyUpdates = apply !== 0;
}

// Chance sampling with baselines (`Approximations.chanceSampling`); off
// while `sampleRounds` is 0. See `sampledChance` in src/cfr.ts, which this
// mirrors step for step, the deal choice included.
let sampleRounds: i32 = 0;
let sampleP: f64 = 1;
let sampleEvery: u32 = 0;
let sampleWeight: f32 = 1;
let catchUp: bool = true;
let baseOffset: usize = 0;
let boardOffset: usize = 0;
let walkOffset: usize = 0;
let baseline: usize = 0;
let lastWalk: usize = 0;
let lastUpdate: usize = 0;
let blockOffset: usize = 0;
let iteration: i32 = 0;
let dcfrRule: bool = false;

/** Turn sampling on: tables and state from src/engine.ts, rounds as a bit mask. */
export function setSampling(
	rounds: i32, p: f64, every: i32, unbiased: i32, catchUpOn: i32,
	baseOffsets: usize, boardOffsets: usize, walkOffsets: usize,
	baselines: usize, lastWalks: usize, lastUpdates: usize, blockOffsets: usize,
): void {
	sampleRounds = rounds;
	sampleP = p;
	sampleEvery = <u32>every;
	sampleWeight = unbiased !== 0 ? <f32>(1 / p) : 1;
	catchUp = catchUpOn !== 0;
	baseOffset = baseOffsets;
	boardOffset = boardOffsets;
	walkOffset = walkOffsets;
	baseline = baselines;
	lastWalk = lastWalks;
	lastUpdate = lastUpdates;
	blockOffset = blockOffsets;
}

/** The iteration a training walk is for, counted from 1, and whether it runs DCFR. */
export function setIteration(t: i32, dcfr: i32): void {
	iteration = t;
	dcfrRule = dcfr !== 0;
}

/** Whether a deal is walked on an iteration, as `sampled` in src/cfr.ts. */
function sampled(node: i32, board: i32, t: i32): bool {
	let h: u32 = (<u32>node ^ (<u32>board * 0x9e3779b1)) * 0x85ebca6b;
	if (sampleEvery > 0) {
		h ^= h >>> 13;
		h *= 0xc2b2ae35;
		h ^= h >>> 16;
		return (<u64>h + <u64>t) % <u64>sampleEvery === 0;
	}
	h ^= <u32>t * 0x27d4eb2f;
	h ^= h >>> 15;
	h *= 0xc2b2ae35;
	h ^= h >>> 13;
	h *= 0x165667b1;
	h ^= h >>> 16;
	return <f64>h / 4294967296.0 < sampleP;
}

// Per-iteration settings, from `run`.
let mode: i32 = 0;
let keepPositive: f32 = 1;
let keepNegative: f32 = 0;
let keepSum: f32 = 1;
let weight: f32 = 1;
let clamp: bool = false;

/** Read the header of pointers src/engine.ts wrote at `header`. */
export function init(header: usize): void {
	kind = <usize>load<u32>(header + 0);
	round = <usize>load<u32>(header + 4);
	player = <usize>load<u32>(header + 8);
	firstEdge = <usize>load<u32>(header + 12);
	numEdges = <usize>load<u32>(header + 16);
	edgeChild = <usize>load<u32>(header + 20);
	payoff = <usize>load<u32>(header + 24);
	offset = <usize>load<u32>(header + 28);
	rowStart = <usize>load<u32>(header + 32);
	roundBase = <usize>load<u32>(header + 36);
	listStart = <usize>load<u32>(header + 40);
	listCount = <usize>load<u32>(header + 44);
	cardA = <usize>load<u32>(header + 48);
	cardB = <usize>load<u32>(header + 52);
	strength = <usize>load<u32>(header + 56);
	packed = <usize>load<u32>(header + 60);
	multiplicity = <usize>load<u32>(header + 64);
	memberStart = <usize>load<u32>(header + 68);
	memberA = <usize>load<u32>(header + 72);
	memberB = <usize>load<u32>(header + 76);
	upRound = <usize>load<u32>(header + 80);
	upStart = <usize>load<u32>(header + 84);
	up = <usize>load<u32>(header + 88);
	sameStart = <usize>load<u32>(header + 92);
	same = <usize>load<u32>(header + 96);
	childRound = <usize>load<u32>(header + 100);
	childStart = <usize>load<u32>(header + 104);
	orbitRound = <usize>load<u32>(header + 108);
	orbitStart = <usize>load<u32>(header + 112);
	runoutWeight = <usize>load<u32>(header + 116);
	regret = <usize>load<u32>(header + 120);
	sums = <usize>load<u32>(header + 124);
	buffers = <usize>load<u32>(header + 128);
	depthBytes = <usize>load<u32>(header + 132);
	rowBytes = <usize>load<u32>(header + 136);
	cardSums = <usize>load<u32>(header + 140);
	chipScale = <f64>load<u32>(header + 144);
}

// Per-depth buffers, each `rowBytes` apart: value, reach for player 0, reach
// for player 1, then strategy and action values, `actions` rows each.
@inline function valueAt(depth: i32): usize { return buffers + <usize>depth * depthBytes; }
@inline function reachAt(depth: i32, who: i32): usize { return buffers + <usize>depth * depthBytes + rowBytes * (1 + <usize>who); }
@inline function strategyAt(depth: i32): usize { return buffers + <usize>depth * depthBytes + rowBytes * 3; }
@inline function actionsAt(depth: i32, maxActions: usize): usize { return strategyAt(depth) + rowBytes * maxActions; }

let maxActions: usize = 1;

/** Settle the buffer layout's action count. */
export function setMaxActions(count: i32): void {
	maxActions = <usize>count;
}

@inline function i32At(base: usize, index: i32): i32 { return load<i32>(base + (<usize>index << 2)); }
@inline function f32At(base: usize, index: i32): f32 { return load<f32>(base + (<usize>index << 2)); }

/**
 * One traversal from the root for `traverser`, in `who` mode. The root reach
 * vectors must already be in `reachAt(0, ·)`... they are read from `rootMe`
 * and `rootOpp`. Returns the pointer to the traverser's values.
 */
export function run(
	runMode: i32,
	traverser: i32,
	rootMe: usize,
	rootOpp: usize,
	positive: f32,
	negative: f32,
	sum: f32,
	iterationWeight: f32,
	clampRegret: i32,
): usize {
	mode = runMode;
	keepPositive = positive;
	keepNegative = negative;
	keepSum = sum;
	weight = iterationWeight;
	clamp = clampRegret !== 0;
	return traverse(traverser, 0, 0, rootMe, rootOpp, 0);
}

/** A worker's walk: from a chance node feeding the shard round, on board 0 of its round. */
export function runChance(
	runMode: i32,
	traverser: i32,
	node: i32,
	me: usize,
	opp: usize,
	positive: f32,
	negative: f32,
	sum: f32,
	iterationWeight: f32,
	clampRegret: i32,
): usize {
	mode = runMode;
	keepPositive = positive;
	keepNegative = negative;
	keepSum = sum;
	weight = iterationWeight;
	clamp = clampRegret !== 0;
	return traverse(traverser, node, 0, me, opp, 0);
}

function traverse(traverser: i32, node: i32, board: i32, reachMe: usize, reachOpp: usize, depth: i32): usize {
	const out = valueAt(depth);
	const nodeKind = load<u8>(kind + <usize>node);
	const r = <i32>load<u8>(round + <usize>node);
	const opponent = 1 - traverser;
	const listBase = (i32At(roundBase, r) + board) * 2;
	const mySlot = listBase + traverser;
	const oppSlot = listBase + opponent;
	const myFrom = i32At(listStart, mySlot);
	const myCount = i32At(listCount, mySlot);
	const oppFrom = i32At(listStart, oppSlot);
	const oppCount = i32At(listCount, oppSlot);

	if (nodeKind === FOLD) {
		let signed = <f64>i32At(payoff, node);
		if (traverser === 1) signed = -signed;
		const scale = signed * load<f64>(runoutWeight + (<usize>r << 3)) / chipScale;
		const sameFrom = i32At(sameStart, mySlot);
		if (load<u8>(packed + <usize>oppSlot)) foldPacked(reachOpp, oppFrom, oppCount, myFrom, myCount, sameFrom, scale, out);
		else fold(reachOpp, oppFrom, oppCount, myFrom, myCount, sameFrom, scale, out);
		return out;
	}
	if (nodeKind > FOLD) {
		const scale = <f64>i32At(payoff, node) * load<f64>(runoutWeight + (<usize>r << 3)) / chipScale;
		if (load<u8>(packed + <usize>oppSlot)) showdownPacked(reachOpp, oppFrom, oppCount, myFrom, myCount, scale, out);
		else showdown(reachOpp, oppFrom, oppCount, myFrom, myCount, scale, out);
		return out;
	}

	if (nodeKind === CHANCE) {
		memory.fill(out, 0, <usize>myCount << 2);
		const nextRound = r + 1;
		if (nextRound === shardRound && phase !== 0) {
			const entry = i32At(entryIndexOf, node);
			if (entry >= 0) {
				const slot = exchange + <usize>entry * 2 * exchangeStride;
				if (phase === 1) {
					memory.copy(slot, reachMe, <usize>myCount << 2);
					memory.copy(slot + exchangeStride, reachOpp, <usize>oppCount << 2);
				} else {
					memory.copy(out, overrides + <usize>entry * exchangeStride, <usize>myCount << 2);
				}
				return out;
			}
		}
		const child = i32At(edgeChild, i32At(firstEdge, node));
		const children = childStart + (<usize>i32At(childRound, nextRound) << 2);
		const orbits = orbitStart + (<usize>i32At(orbitRound, nextRound) << 2);
		const ups = upStart + (<usize>i32At(upRound, nextRound) << 2);
		const childMe = reachAt(depth, traverser);
		const childOpp = reachAt(depth, opponent);
		const nextBase = i32At(roundBase, nextRound);
		let first = i32At(children, board);
		let last = i32At(children, board + 1);
		if (nextRound === shardRound) {
			if (shardStart > first) first = shardStart;
			if (shardEnd < last) last = shardEnd;
		}
		// Chance sampling decides how each deal's values are had; how they
		// spread over the deal's mirror images is the same either way.
		const sampleHere = sampleRounds !== 0 && mode === TRAIN && applyUpdates && ((sampleRounds >> nextRound) & 1) !== 0;
		for (let childBoard = first; childBoard < last; childBoard++) {
			const childSlot = (nextBase + childBoard) * 2;
			const nMe = i32At(listCount, childSlot + traverser);
			const nOpp = i32At(listCount, childSlot + opponent);
			const firstMember = i32At(orbits, childBoard);
			const membersEnd = i32At(orbits, childBoard + 1);
			let value: usize = 0;
			for (let m = firstMember; m < membersEnd; m++) {
				const upMe = up + (<usize>i32At(ups, m * 2 + traverser) << 1);
				if (m === firstMember && sampleHere) {
					value = sampledValue(traverser, node, child, childSlot, childBoard, upMe, up + (<usize>i32At(ups, m * 2 + opponent) << 1), reachMe, reachOpp, childMe, childOpp, depth);
				} else if (m === firstMember) {
					const upOpp = up + (<usize>i32At(ups, m * 2 + opponent) << 1);
					for (let k = 0; k < nMe; k++) store<f32>(childMe + (<usize>k << 2), f32At(reachMe, <i32>load<u16>(upMe + (<usize>k << 1))));
					for (let k = 0; k < nOpp; k++) store<f32>(childOpp + (<usize>k << 2), f32At(reachOpp, <i32>load<u16>(upOpp + (<usize>k << 1))));
					value = traverse(traverser, child, childBoard, childMe, childOpp, depth + 1);
				}
				// Reach is symmetric under the member's relabelling, so one
				// walk serves every member; only the values are spread.
				if (load<u8>(packed + <usize>(childSlot + traverser))) {
					// An entry stands for its whole orbit: weight it so, and
					// share the parent's total among its own orbit below.
					const weights = multiplicity + (<usize>i32At(listStart, childSlot + traverser) << 2);
					for (let k = 0; k < nMe; k++) {
						const at = out + (<usize>load<u16>(upMe + (<usize>k << 1)) << 2);
						store<f32>(at, load<f32>(at) + f32At(value, k) * f32At(weights, k));
					}
				} else {
					for (let k = 0; k < nMe; k++) {
						const at = out + (<usize>load<u16>(upMe + (<usize>k << 1)) << 2);
						store<f32>(at, load<f32>(at) + f32At(value, k));
					}
				}
			}
		}
		if (load<u8>(packed + <usize>mySlot)) {
			const weights = multiplicity + (<usize>myFrom << 2);
			for (let i = 0; i < myCount; i++) {
				const at = out + (<usize>i << 2);
				store<f32>(at, load<f32>(at) / f32At(weights, i));
			}
		}
		return out;
	}

	// --- decision ---
	const actions = <i32>load<u8>(numEdges + <usize>node);
	const edgeBase = i32At(firstEdge, node);
	const owner = <i32>load<u8>(player + <usize>node);
	const isTraverser = owner === traverser;
	const listSlot = isTraverser ? mySlot : oppSlot;
	const n = isTraverser ? myCount : oppCount;
	const base = regret + (<usize>(i32At(offset, node) + actions * i32At(rowStart, listSlot)) << 2);
	const sumBase = sums + (<usize>(i32At(offset, node) + actions * i32At(rowStart, listSlot)) << 2);
	const strategy = strategyAt(depth);
	const rowStride = <usize>n << 2;

	if (mode === TRAIN) matchRegret(base, actions, n, strategy);
	else matchAverage(sumBase, base, actions, n, strategy);

	if (isTraverser && mode === BEST_RESPONSE) {
		for (let a = 0; a < actions; a++) {
			const value = traverse(traverser, i32At(edgeChild, edgeBase + a), board, reachMe, reachOpp, depth + 1);
			if (a === 0) memory.copy(out, value, <usize>myCount << 2);
			else for (let i = 0; i < myCount; i++) {
				const v = f32At(value, i);
				if (v > f32At(out, i)) store<f32>(out + (<usize>i << 2), v);
			}
		}
		return out;
	}

	memory.fill(out, 0, <usize>myCount << 2);
	const childReach = reachAt(depth, owner);
	const actionValues = actionsAt(depth, maxActions);
	const source = isTraverser ? reachMe : reachOpp;
	const n4 = n & ~3;
	const my4 = myCount & ~3;

	for (let a = 0; a < actions; a++) {
		const row = strategy + <usize>a * rowStride;
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			v128.store(childReach + o, f32x4.mul(v128.load(source + o), v128.load(row + o)));
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			store<f32>(childReach + o, load<f32>(source + o) * load<f32>(row + o));
		}
		const value = isTraverser
			? traverse(traverser, i32At(edgeChild, edgeBase + a), board, childReach, reachOpp, depth + 1)
			: traverse(traverser, i32At(edgeChild, edgeBase + a), board, reachMe, childReach, depth + 1);
		if (isTraverser) {
			const actionRow = actionValues + <usize>a * rowStride;
			memory.copy(actionRow, value, rowStride);
			i = 0;
			for (; i < my4; i += 4) {
				const o = <usize>i << 2;
				v128.store(out + o, f32x4.add(v128.load(out + o), f32x4.mul(v128.load(row + o), v128.load(value + o))));
			}
			for (; i < myCount; i++) {
				const o = <usize>i << 2;
				store<f32>(out + o, load<f32>(out + o) + load<f32>(row + o) * load<f32>(value + o));
			}
		} else {
			i = 0;
			for (; i < my4; i += 4) {
				const o = <usize>i << 2;
				v128.store(out + o, f32x4.add(v128.load(out + o), v128.load(value + o)));
			}
			for (; i < myCount; i++) {
				const o = <usize>i << 2;
				store<f32>(out + o, load<f32>(out + o) + load<f32>(value + o));
			}
		}
	}

	if (isTraverser && mode === TRAIN && applyUpdates && sampleRounds !== 0 && dcfrRule) {
		// A subtree sampling skipped missed those iterations' discounts;
		// nothing was added meanwhile, so each sign held.
		const block = lastUpdate + (<usize>(i32At(blockOffset, node) + board) << 2);
		const savedPositive = keepPositive;
		const savedNegative = keepNegative;
		const savedSum = keepSum;
		let positive = <f64>keepPositive;
		let negative = <f64>keepNegative;
		let sum = <f64>keepSum;
		if (catchUp) {
			for (let t = load<i32>(block) + 1; t < iteration; t++) {
				// `dcfrFactors` in src/cfr.ts at α 1.5, β 0, γ 3, without
				// pulling a general power function into the module.
				const age: f64 = t > 2 ? <f64>(t - 2) : 0;
				const grown = age * Math.sqrt(age);
				const kept = <f64>(t - 1) / <f64>t;
				positive *= grown / (grown + 1);
				negative *= 0.5;
				sum *= kept * kept * kept;
			}
		}
		store<i32>(block, iteration);
		keepPositive = <f32>positive;
		keepNegative = <f32>negative;
		keepSum = <f32>sum;
		update(base, sumBase, actions, n, reachMe, strategy, actionValues, out);
		keepPositive = savedPositive;
		keepNegative = savedNegative;
		keepSum = savedSum;
	} else if (isTraverser && mode === TRAIN && applyUpdates) {
		update(base, sumBase, actions, n, reachMe, strategy, actionValues, out);
	}
	return out;
}

/**
 * One deal's values in a sampled chance node's training walk, as
 * `sampledValue` in src/cfr.ts: a deal not walked gives its baseline, the
 * values it returned when last walked; a walked deal gives `b + (v - b) / p`
 * and becomes the new baseline. A deal never walked yet is always walked.
 */
function sampledValue(
	traverser: i32, node: i32, child: i32, childSlot: i32, childBoard: i32, upMe: usize, upOpp: usize,
	reachMe: usize, reachOpp: usize, childMe: usize, childOpp: usize, depth: i32,
): usize {
	const opponent = 1 - traverser;
	const nMe = i32At(listCount, childSlot + traverser);
	const at = baseline + (<usize>(i32At(baseOffset, node) + i32At(boardOffset, childSlot + traverser)) << 2);
	const walkAt = lastWalk + (<usize>(i32At(walkOffset, node) + childBoard * 2 + traverser) << 2);
	const fresh = load<i32>(walkAt) === 0;
	if (!fresh && !sampled(node, childBoard, iteration)) return at;
	const nOpp = i32At(listCount, childSlot + opponent);
	for (let k = 0; k < nMe; k++) store<f32>(childMe + (<usize>k << 2), f32At(reachMe, <i32>load<u16>(upMe + (<usize>k << 1))));
	for (let k = 0; k < nOpp; k++) store<f32>(childOpp + (<usize>k << 2), f32At(reachOpp, <i32>load<u16>(upOpp + (<usize>k << 1))));
	const value = traverse(traverser, child, childBoard, childMe, childOpp, depth + 1);
	for (let k = 0; k < nMe; k++) {
		const o = <usize>k << 2;
		const v = load<f32>(value + o);
		const b = load<f32>(at + o);
		store<f32>(at + o, v);
		// `v + (w - 1)(v - b)` is `b + w(v - b)`, and exactly `v` at w = 1.
		if (!fresh) store<f32>(value + o, v + (sampleWeight - 1) * (v - b));
	}
	store<i32>(walkAt, iteration);
	return value;
}

/** Current strategy: each hand's share of positive regret, uniform where none. */
function matchRegret(base: usize, actions: i32, n: i32, strategy: usize): void {
	const rowStride = <usize>n << 2;
	const total = strategy + <usize>actions * rowStride; // scratch: the action-values area's first row
	const zero = f32x4.splat(0);
	const n4 = n & ~3;
	memory.fill(total, 0, rowStride);
	for (let a = 0; a < actions; a++) {
		const src = base + <usize>a * rowStride;
		const dst = strategy + <usize>a * rowStride;
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			const p = f32x4.max(v128.load(src + o), zero);
			v128.store(dst + o, p);
			v128.store(total + o, f32x4.add(v128.load(total + o), p));
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const v = load<f32>(src + o);
			const p: f32 = v > 0 ? v : 0;
			store<f32>(dst + o, p);
			store<f32>(total + o, load<f32>(total + o) + p);
		}
	}
	normaliseRows(strategy, total, actions, n);
}

/** Average strategy: share of strategy sums; positive regret where those are zero; else uniform. */
function matchAverage(sumBase: usize, regretBase: usize, actions: i32, n: i32, strategy: usize): void {
	const rowStride = <usize>n << 2;
	const total = strategy + <usize>actions * rowStride;
	memory.fill(total, 0, rowStride);
	for (let a = 0; a < actions; a++) {
		const src = sumBase + <usize>a * rowStride;
		const dst = strategy + <usize>a * rowStride;
		for (let i = 0; i < n; i++) {
			const o = <usize>i << 2;
			const v = load<f32>(src + o);
			store<f32>(dst + o, v);
			store<f32>(total + o, load<f32>(total + o) + v);
		}
	}
	// Hands that never reached this node fall back to the current strategy.
	for (let i = 0; i < n; i++) {
		const o = <usize>i << 2;
		if (load<f32>(total + o) > 0) continue;
		let positive: f32 = 0;
		for (let a = 0; a < actions; a++) {
			const v = load<f32>(regretBase + <usize>a * rowStride + o);
			const p: f32 = v > 0 ? v : 0;
			store<f32>(strategy + <usize>a * rowStride + o, p);
			positive += p;
		}
		store<f32>(total + o, positive);
	}
	normaliseRows(strategy, total, actions, n);
}

function normaliseRows(strategy: usize, total: usize, actions: i32, n: i32): void {
	const rowStride = <usize>n << 2;
	const zero = f32x4.splat(0);
	const uniform = f32x4.splat(<f32>1 / <f32>actions);
	const n4 = n & ~3;
	for (let a = 0; a < actions; a++) {
		const row = strategy + <usize>a * rowStride;
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			const t = v128.load(total + o);
			v128.store(row + o, v128.bitselect(f32x4.div(v128.load(row + o), t), uniform, f32x4.gt(t, zero)));
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const t = load<f32>(total + o);
			store<f32>(row + o, t > 0 ? load<f32>(row + o) / t : <f32>1 / <f32>actions);
		}
	}
}

/** DCFR or CFR+ update of one block, from this visit's action values. */
function update(base: usize, sumBase: usize, actions: i32, n: i32, reachMe: usize, strategy: usize, actionValues: usize, value: usize): void {
	const rowStride = <usize>n << 2;
	const zero = f32x4.splat(0);
	const pos = f32x4.splat(keepPositive);
	const neg = f32x4.splat(keepNegative);
	const keep = f32x4.splat(keepSum);
	const w = f32x4.splat(weight);
	const n4 = n & ~3;
	for (let a = 0; a < actions; a++) {
		const row = <usize>a * rowStride;
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			const r = v128.load(base + row + o);
			const factor = v128.bitselect(pos, neg, f32x4.gt(r, zero));
			let updated = f32x4.add(f32x4.mul(r, factor), f32x4.sub(v128.load(actionValues + row + o), v128.load(value + o)));
			if (clamp) updated = f32x4.max(updated, zero);
			v128.store(base + row + o, updated);
			const s = f32x4.add(f32x4.mul(v128.load(sumBase + row + o), keep), f32x4.mul(w, f32x4.mul(v128.load(reachMe + o), v128.load(strategy + row + o))));
			v128.store(sumBase + row + o, s);
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const r = load<f32>(base + row + o);
			let updated = r * (r > 0 ? keepPositive : keepNegative) + load<f32>(actionValues + row + o) - load<f32>(value + o);
			if (clamp && updated < 0) updated = 0;
			store<f32>(base + row + o, updated);
			store<f32>(sumBase + row + o, load<f32>(sumBase + row + o) * keepSum + weight * load<f32>(reachMe + o) * load<f32>(strategy + row + o));
		}
	}
}

/** Fold values: card-removal inclusion–exclusion, as `foldValuesHands`. */
function fold(reachOpp: usize, oppFrom: i32, oppCount: i32, myFrom: i32, myCount: i32, sameFrom: i32, scale: f64, out: usize): void {
	let total: f64 = 0;
	for (let j = 0; j < oppCount; j++) {
		const v = <f64>f32At(reachOpp, j);
		total += v;
		const a = cardSums + (<usize>load<u8>(cardA + <usize>(oppFrom + j)) << 3);
		store<f64>(a, load<f64>(a) + v);
		const b = cardSums + (<usize>load<u8>(cardB + <usize>(oppFrom + j)) << 3);
		store<f64>(b, load<f64>(b) + v);
	}
	for (let i = 0; i < myCount; i++) {
		const twin = i32At(same, sameFrom + i);
		const both: f64 = twin >= 0 ? <f64>f32At(reachOpp, twin) : 0;
		const blocked = load<f64>(cardSums + (<usize>load<u8>(cardA + <usize>(myFrom + i)) << 3))
			+ load<f64>(cardSums + (<usize>load<u8>(cardB + <usize>(myFrom + i)) << 3)) - both;
		store<f32>(out + (<usize>i << 2), <f32>(scale * (total - blocked)));
	}
	memory.fill(cardSums, 0, 52 * 8);
}

/** Showdown values: two sweeps over strength-sorted lists, as `showdownValuesHands`. */
function showdown(reachOpp: usize, oppFrom: i32, oppCount: i32, myFrom: i32, myCount: i32, scale: f64, out: usize): void {
	// The ascending sweep's results wait in the value buffer as f32 would
	// lose precision on the subtraction, so they go through a double each.
	let running: f64 = 0;
	let j = 0;
	const wins = cardSums + 52 * 8; // myCount doubles of scratch after the card sums
	for (let i = 0; i < myCount; i++) {
		const level = i32At(strength, myFrom + i);
		while (j < oppCount && i32At(strength, oppFrom + j) < level) {
			const v = <f64>f32At(reachOpp, j);
			running += v;
			const a = cardSums + (<usize>load<u8>(cardA + <usize>(oppFrom + j)) << 3);
			store<f64>(a, load<f64>(a) + v);
			const b = cardSums + (<usize>load<u8>(cardB + <usize>(oppFrom + j)) << 3);
			store<f64>(b, load<f64>(b) + v);
			j++;
		}
		store<f64>(wins + (<usize>i << 3), running
			- (load<f64>(cardSums + (<usize>load<u8>(cardA + <usize>(myFrom + i)) << 3))
				+ load<f64>(cardSums + (<usize>load<u8>(cardB + <usize>(myFrom + i)) << 3))));
	}
	memory.fill(cardSums, 0, 52 * 8);
	running = 0;
	j = oppCount - 1;
	for (let i = myCount - 1; i >= 0; i--) {
		const level = i32At(strength, myFrom + i);
		while (j >= 0 && i32At(strength, oppFrom + j) > level) {
			const v = <f64>f32At(reachOpp, j);
			running += v;
			const a = cardSums + (<usize>load<u8>(cardA + <usize>(oppFrom + j)) << 3);
			store<f64>(a, load<f64>(a) + v);
			const b = cardSums + (<usize>load<u8>(cardB + <usize>(oppFrom + j)) << 3);
			store<f64>(b, load<f64>(b) + v);
			j--;
		}
		const lose = running
			- (load<f64>(cardSums + (<usize>load<u8>(cardA + <usize>(myFrom + i)) << 3))
				+ load<f64>(cardSums + (<usize>load<u8>(cardB + <usize>(myFrom + i)) << 3)));
		store<f32>(out + (<usize>i << 2), <f32>(scale * (load<f64>(wins + (<usize>i << 3)) - lose)));
	}
	memory.fill(cardSums, 0, 52 * 8);
}

/**
 * Packed lists' card-removal sums: an entry's reach counted once per hand it
 * stands for, on that hand's own cards. Returns the reach times their number.
 */
@inline function addMembers(v: f64, entry: i32): f64 {
	const from = i32At(memberStart, entry);
	const to = i32At(memberStart, entry + 1);
	for (let m = from; m < to; m++) {
		const a = cardSums + (<usize>load<u8>(memberA + <usize>m) << 3);
		store<f64>(a, load<f64>(a) + v);
		const b = cardSums + (<usize>load<u8>(memberB + <usize>m) << 3);
		store<f64>(b, load<f64>(b) + v);
	}
	return v * <f64>(to - from);
}

/** `fold` over packed lists, as `foldValuesPacked`. */
function foldPacked(reachOpp: usize, oppFrom: i32, oppCount: i32, myFrom: i32, myCount: i32, sameFrom: i32, scale: f64, out: usize): void {
	let total: f64 = 0;
	for (let j = 0; j < oppCount; j++) total += addMembers(<f64>f32At(reachOpp, j), oppFrom + j);
	for (let i = 0; i < myCount; i++) {
		const twin = i32At(same, sameFrom + i);
		const both: f64 = twin >= 0 ? <f64>f32At(reachOpp, twin) : 0;
		const blocked = load<f64>(cardSums + (<usize>load<u8>(cardA + <usize>(myFrom + i)) << 3))
			+ load<f64>(cardSums + (<usize>load<u8>(cardB + <usize>(myFrom + i)) << 3)) - both;
		store<f32>(out + (<usize>i << 2), <f32>(scale * (total - blocked)));
	}
	memory.fill(cardSums, 0, 52 * 8);
}

/** `showdown` over packed lists, as `showdownValuesPacked`. */
function showdownPacked(reachOpp: usize, oppFrom: i32, oppCount: i32, myFrom: i32, myCount: i32, scale: f64, out: usize): void {
	let running: f64 = 0;
	let j = 0;
	const wins = cardSums + 52 * 8;
	for (let i = 0; i < myCount; i++) {
		const level = i32At(strength, myFrom + i);
		while (j < oppCount && i32At(strength, oppFrom + j) < level) {
			running += addMembers(<f64>f32At(reachOpp, j), oppFrom + j);
			j++;
		}
		store<f64>(wins + (<usize>i << 3), running
			- (load<f64>(cardSums + (<usize>load<u8>(cardA + <usize>(myFrom + i)) << 3))
				+ load<f64>(cardSums + (<usize>load<u8>(cardB + <usize>(myFrom + i)) << 3))));
	}
	memory.fill(cardSums, 0, 52 * 8);
	running = 0;
	j = oppCount - 1;
	for (let i = myCount - 1; i >= 0; i--) {
		const level = i32At(strength, myFrom + i);
		while (j >= 0 && i32At(strength, oppFrom + j) > level) {
			running += addMembers(<f64>f32At(reachOpp, j), oppFrom + j);
			j--;
		}
		const lose = running
			- (load<f64>(cardSums + (<usize>load<u8>(cardA + <usize>(myFrom + i)) << 3))
				+ load<f64>(cardSums + (<usize>load<u8>(cardB + <usize>(myFrom + i)) << 3)));
		store<f32>(out + (<usize>i << 2), <f32>(scale * (load<f64>(wins + (<usize>i << 3)) - lose)));
	}
	memory.fill(cardSums, 0, 52 * 8);
}
