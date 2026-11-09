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

/**
 * Built twice. False: the default engine, 32-bit storage only. True: the
 * engine `poker-flopsolve/wasm-storage` ships (issue #84), which adds 16-bit
 * storage (`precision: 'i16'`) and `compactStorage` as src/cfr.ts keeps
 * them. scripts/build-wasm.ts sets it; with it false, -O3 drops every path
 * it guards, so the default module is what it was before they existed.
 */
const STORAGE: bool = false;

// Storage kinds of a node's regrets or strategy sums, with STORAGE.
const F32: i32 = 0;
const I16: i32 = 1;
const U16: i32 = 2;
const I8: i32 = 3;
const U8: i32 = 4;
const NONE: i32 = 5;

// Compact storage's modes, as `CompactPlan` in src/cfr.ts.
const PER_HAND: i32 = 1;
const BLOCK_SCALE: i32 = 2;
const FLOAT: i32 = 3;

// The storage settings, read by `init` from the block header slot 37 points
// to; see `createEngine` in src/engine.ts, which writes them.
let storageBlock: usize = 0;
let quantised: bool = false;
let compactFrom: i32 = 255;
let compactMode: i32 = 0;
let compactSums: bool = false;
let stochastic: bool = false;
let steps: f64 = 127;
let regretScale: usize = 0;
let sumScale: usize = 0;
let compactChunk: usize = 0;
let handOffset: usize = 0;
let chunkRegret: usize = 0;
let chunkShift: usize = 0;
let chunkSum: usize = 0;
let chunkSumShift: usize = 0;
let chunkStart: usize = 0;
let compactScale: usize = 0;

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

// History sharing (`SpotConfig.shareHistories`): per block, the iteration
// DCFR last discounted it in, so a block shared by several histories is
// discounted once an iteration, as `discounted` in src/cfr.ts. Off while 0.
let discounted: usize = 0;
// Per node, nonzero where a shared node's regret is weighted by own reach; 0 for none.
let weightedNodes: usize = 0;

/** Turn the once-an-iteration discount on: its marks, the block table, the weighted nodes (or 0). */
export function setShared(marks: usize, blockOffsets: usize, weighted: usize): void {
	discounted = marks;
	blockOffset = blockOffsets;
	weightedNodes = weighted;
}

/** The iteration a training walk is for, counted from 1, and whether it runs DCFR. */
export function setIteration(t: i32, dcfr: i32): void {
	iteration = t;
	dcfrRule = dcfr !== 0;
}

// What DCFR has a block keep this iteration, set by `blockFactors`.
let blockPositive: f64 = 1;
let blockNegative: f64 = 0;
let blockSum: f64 = 1;

/**
 * `blockFactors` in src/cfr.ts: what DCFR has block `block` keep as the
 * iteration updates it, from the iteration's own factors, into
 * `blockPositive`, `blockNegative` and `blockSum`. The order matters: first,
 * a shared block another history already discounted this iteration keeps
 * everything; then, with chance sampling, the discounts of the iterations a
 * skipped block missed are multiplied in. Marks the block discounted and
 * updated. Under CFR+ the factors pass through unchanged.
 */
function blockFactors(block: usize, positive: f64, negative: f64, sum: f64): void {
	if (dcfrRule && discounted !== 0) {
		// Another history already discounted this shared block this iteration.
		const mark = discounted + (block << 2);
		if (load<i32>(mark) === iteration) {
			positive = 1;
			negative = 1;
			sum = 1;
		}
		store<i32>(mark, iteration);
	}
	if (dcfrRule && sampleRounds !== 0) {
		// A subtree sampling skipped missed those iterations' discounts;
		// nothing was added meanwhile, so each sign held.
		const at = lastUpdate + (block << 2);
		if (catchUp) {
			for (let t = load<i32>(at) + 1; t < iteration; t++) {
				// `dcfrFactors` in src/cfr.ts at its α 1.5, β 0, γ 3 (`DCFR_ALPHA`,
				// `DCFR_BETA`, `DCFR_GAMMA` there), the only copy in this module:
				// s^1.5 as s·√s, s^0 / (s^0 + 1) as 0.5, and a cube, without
				// pulling a general power function into the module.
				const age: f64 = t > 2 ? <f64>(t - 2) : 0;
				const grown = age * Math.sqrt(age);
				const kept = <f64>(t - 1) / <f64>t;
				positive *= grown / (grown + 1);
				negative *= 0.5;
				sum *= kept * kept * kept;
			}
		}
		store<i32>(at, iteration);
	}
	blockPositive = positive;
	blockNegative = negative;
	blockSum = sum;
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
	if (STORAGE) {
		const at = <usize>load<u32>(header + 148);
		storageBlock = at;
		quantised = load<u32>(at + 0) !== 0;
		compactFrom = <i32>load<u32>(at + 4);
		compactMode = <i32>load<u32>(at + 8);
		compactSums = load<u32>(at + 12) !== 0;
		stochastic = load<u32>(at + 16) !== 0;
		steps = <f64>load<u32>(at + 20);
		regretScale = <usize>load<u32>(at + 24);
		sumScale = <usize>load<u32>(at + 28);
		blockOffset = <usize>load<u32>(at + 32);
		compactChunk = <usize>load<u32>(at + 36);
		handOffset = <usize>load<u32>(at + 40);
		chunkRegret = <usize>load<u32>(at + 44);
		chunkShift = <usize>load<u32>(at + 48);
		chunkSum = <usize>load<u32>(at + 52);
		chunkSumShift = <usize>load<u32>(at + 56);
		chunkStart = <usize>load<u32>(at + 60);
		compactScale = <usize>load<u32>(at + 64);
	}
}

// With STORAGE: the update rule's factors as float64, which src/engine.ts
// writes into the storage block before each walk, as src/cfr.ts uses them.
@inline function factorPositive(): f64 { return load<f64>(storageBlock + 80); }
@inline function factorNegative(): f64 { return load<f64>(storageBlock + 88); }
@inline function factorSum(): f64 { return load<f64>(storageBlock + 96); }
@inline function factorWeight(): f64 { return load<f64>(storageBlock + 104); }

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
	let base = regret + (<usize>(i32At(offset, node) + actions * i32At(rowStart, listSlot)) << 2);
	let sumBase = sums + (<usize>(i32At(offset, node) + actions * i32At(rowStart, listSlot)) << 2);
	const strategy = strategyAt(depth);
	const rowStride = <usize>n << 2;

	// With STORAGE, where this node's accumulators are and how they are kept.
	let regretKind = F32;
	let sumKind = F32;
	let slot = 0;
	let chunk = -1;
	if (STORAGE) {
		slot = i32At(offset, node) + actions * i32At(rowStart, listSlot);
		if (r >= compactFrom) {
			chunk = i32At(compactChunk, node);
			const regrets = <usize>load<u32>(chunkRegret + (<usize>chunk << 2));
			if (compactMode === FLOAT) {
				base = regrets + (<usize>slot << 2);
			} else {
				regretKind = I8;
				base = regrets + <usize>slot;
			}
			if (compactSums) {
				sumKind = U8;
				sumBase = <usize>load<u32>(chunkSum + (<usize>chunk << 2)) + <usize>slot;
			} else {
				sumKind = NONE;
			}
		} else if (quantised) {
			regretKind = I16;
			sumKind = U16;
			base = regret + (<usize>slot << 1);
			sumBase = sums + (<usize>slot << 1);
		}
	}

	if (STORAGE && (regretKind !== F32 || sumKind !== F32)) {
		// A compactly stored node without sums plays the current profile
		// wherever a strategy is read, as `traverse` in src/cfr.ts.
		if (mode === TRAIN || sumKind === NONE) {
			decode(base, regretKind, actions * n, strategy);
			matchRegret(strategy, actions, n, strategy);
		} else {
			matchAverageStored(sumBase, sumKind, base, regretKind, actions, n, strategy);
		}
	} else if (mode === TRAIN) matchRegret(base, actions, n, strategy);
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

	if (isTraverser && mode === TRAIN && applyUpdates) snapTies(actionValues, out, actions, myCount, rowStride);
	if (weightedNodes !== 0 && isTraverser && mode === TRAIN && applyUpdates && load<u8>(weightedNodes + <usize>node) !== 0) {
		// Each history's regret counts as often as this hand plays into it.
		for (let a = 0; a < actions; a++) {
			const actionRow = actionValues + <usize>a * rowStride;
			for (let i = 0; i < myCount; i++) {
				const o = <usize>i << 2;
				const v = load<f32>(out + o);
				store<f32>(actionRow + o, v + load<f32>(reachMe + o) * (load<f32>(actionRow + o) - v));
			}
		}
	}
	if (STORAGE && isTraverser && mode === TRAIN && applyUpdates && chunk >= 0) {
		updateCompact(
			<usize>(i32At(blockOffset, node) + board), node, chunk, slot, i32At(handOffset, node) + i32At(rowStart, listSlot),
			base, sumBase, actions, n, reachMe, strategy, actionValues, out,
		);
	} else if (STORAGE && isTraverser && mode === TRAIN && applyUpdates && regretKind === I16) {
		updateI16(<usize>(i32At(blockOffset, node) + board), node, slot, base, sumBase, actions, n, reachMe, strategy, actionValues, out);
	} else if (isTraverser && mode === TRAIN && applyUpdates && (sampleRounds !== 0 || discounted !== 0) && dcfrRule) {
		const savedPositive = keepPositive;
		const savedNegative = keepNegative;
		const savedSum = keepSum;
		blockFactors(<usize>(i32At(blockOffset, node) + board), <f64>keepPositive, <f64>keepNegative, <f64>keepSum);
		keepPositive = <f32>blockPositive;
		keepNegative = <f32>blockNegative;
		keepSum = <f32>blockSum;
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

/** `TIE_TOLERANCE` in src/cfr.ts: 2^-20, 8 to 16 float32 ulps of the larger value. test/ties.test.ts holds the two equal. */
const TIE_TOLERANCE: f32 = 9.5367431640625e-7;

/**
 * Snap each action value that ties the hand's node value onto it, so the
 * regret it adds is exactly 0, as `snapTies` in src/cfr.ts (issue #117).
 */
function snapTies(actionValues: usize, value: usize, actions: i32, n: i32, rowStride: usize): void {
	const tolerance = f32x4.splat(TIE_TOLERANCE);
	const n4 = n & ~3;
	for (let a = 0; a < actions; a++) {
		const row = actionValues + <usize>a * rowStride;
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			const v = v128.load(row + o);
			const w = v128.load(value + o);
			const size = f32x4.max(f32x4.abs(v), f32x4.abs(w));
			const tied = f32x4.le(f32x4.abs(f32x4.sub(v, w)), f32x4.mul(tolerance, size));
			v128.store(row + o, v128.bitselect(w, v, tied));
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const v = load<f32>(row + o);
			const w = load<f32>(value + o);
			if (Mathf.abs(v - w) <= TIE_TOLERANCE * Mathf.max(Mathf.abs(v), Mathf.abs(w))) store<f32>(row + o, w);
		}
	}
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
	// Hands with no sum here (under CFR+, never reached) fall back to the current strategy.
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
			// DCFR adds the strategy unweighted by own reach (issue #8); CFR+ keeps the weight.
			let played = v128.load(strategy + row + o);
			if (clamp) played = f32x4.mul(v128.load(reachMe + o), played);
			const added = f32x4.mul(w, played);
			const s = f32x4.add(f32x4.mul(v128.load(sumBase + row + o), keep), added);
			v128.store(sumBase + row + o, s);
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const r = load<f32>(base + row + o);
			let updated = r * (r > 0 ? keepPositive : keepNegative) + load<f32>(actionValues + row + o) - load<f32>(value + o);
			if (clamp && updated < 0) updated = 0;
			store<f32>(base + row + o, updated);
			let played = load<f32>(strategy + row + o);
			if (clamp) played = load<f32>(reachMe + o) * played;
			store<f32>(sumBase + row + o, load<f32>(sumBase + row + o) * keepSum + weight * played);
		}
	}
}

// --- 16-bit and compact storage, with STORAGE (issue #84) ---

/** One stored value as a float, by its kind. A stored scale cancels in everything read from it. */
@inline function loadStored(base: usize, kind: i32, index: i32): f32 {
	const i = <usize>index;
	if (kind === I16) return <f32>load<i16>(base + (i << 1));
	if (kind === U16) return <f32>load<u16>(base + (i << 1));
	if (kind === I8) return <f32>load<i8>(base + i);
	if (kind === U8) return <f32>load<u8>(base + i);
	return load<f32>(base + (i << 2));
}

/** `count` stored values as floats at `into`, eight at a time where the kind is 16- or 8-bit. */
function decode(base: usize, kind: i32, count: i32, into: usize): void {
	let i = 0;
	if (kind === I16) {
		const count8 = count & ~7;
		for (; i < count8; i += 8) {
			const v = v128.load(base + (<usize>i << 1));
			const o = into + (<usize>i << 2);
			v128.store(o, f32x4.convert_i32x4_s(i32x4.extend_low_i16x8_s(v)));
			v128.store(o + 16, f32x4.convert_i32x4_s(i32x4.extend_high_i16x8_s(v)));
		}
	} else if (kind === I8) {
		const count16 = count & ~15;
		for (; i < count16; i += 16) {
			const v = v128.load(base + <usize>i);
			const low = i16x8.extend_low_i8x16_s(v);
			const high = i16x8.extend_high_i8x16_s(v);
			const o = into + (<usize>i << 2);
			v128.store(o, f32x4.convert_i32x4_s(i32x4.extend_low_i16x8_s(low)));
			v128.store(o + 16, f32x4.convert_i32x4_s(i32x4.extend_high_i16x8_s(low)));
			v128.store(o + 32, f32x4.convert_i32x4_s(i32x4.extend_low_i16x8_s(high)));
			v128.store(o + 48, f32x4.convert_i32x4_s(i32x4.extend_high_i16x8_s(high)));
		}
	}
	for (; i < count; i++) store<f32>(into + (<usize>i << 2), loadStored(base, kind, i));
}

/** `matchAverage` over stored sums and regrets of any kind. */
function matchAverageStored(sumBase: usize, sumKind: i32, regretBase: usize, regretKind: i32, actions: i32, n: i32, strategy: usize): void {
	const rowStride = <usize>n << 2;
	const total = strategy + <usize>actions * rowStride;
	memory.fill(total, 0, rowStride);
	for (let a = 0; a < actions; a++) {
		const dst = strategy + <usize>a * rowStride;
		for (let i = 0; i < n; i++) {
			const o = <usize>i << 2;
			const v = loadStored(sumBase, sumKind, a * n + i);
			store<f32>(dst + o, v);
			store<f32>(total + o, load<f32>(total + o) + v);
		}
	}
	// Hands with no sum here (under CFR+, never reached) fall back to the current strategy.
	for (let i = 0; i < n; i++) {
		const o = <usize>i << 2;
		if (load<f32>(total + o) > 0) continue;
		let positive: f32 = 0;
		for (let a = 0; a < actions; a++) {
			const v = loadStored(regretBase, regretKind, a * n + i);
			const p: f32 = v > 0 ? v : 0;
			store<f32>(strategy + <usize>a * rowStride + o, p);
			positive += p;
		}
		store<f32>(total + o, positive);
	}
	normaliseRows(strategy, total, actions, n);
}

/** The largest of a vector's four lanes. */
@inline function largestLane(v: v128): f32 {
	const a = Mathf.max(f32x4.extract_lane(v, 0), f32x4.extract_lane(v, 1));
	const b = Mathf.max(f32x4.extract_lane(v, 2), f32x4.extract_lane(v, 3));
	return Mathf.max(a, b);
}

/** `dither`'s iteration and salt (src/cfr.ts), mixed once for a block. */
@inline function ditherMix(t: i32, salt: i32): i32 {
	return (t * <i32>0x9e3779b1) ^ (salt * <i32>0x27d4eb2f);
}

/** Four of `dither`'s hashes, for slots `slot` to `slot + 3` under `ditherMix`, as floats in [0, 1) to 24 bits. */
@inline function ditherLanes(slot: i32, mix: i32): v128 {
	const slots = i32x4.add(i32x4.splat(slot), i32x4(0, 1, 2, 3));
	let h = i32x4.mul(v128.xor(slots, i32x4.splat(mix)), i32x4.splat(<i32>0x85ebca6b));
	h = v128.xor(h, i32x4.shr_u(h, 13));
	h = i32x4.mul(h, i32x4.splat(<i32>0xc2b2ae35));
	h = v128.xor(h, i32x4.shr_u(h, 16));
	return f32x4.mul(f32x4.convert_i32x4_u(i32x4.shr_u(h, 8)), f32x4.splat(<f32>1 / <f32>16777216));
}

/** `dither` to 24 bits, as `ditherLanes` gives it. */
@inline function ditherOne(slot: i32, mix: i32): f32 {
	let h: u32 = <u32>(slot ^ mix) * 0x85ebca6b;
	h ^= h >>> 13;
	h *= 0xc2b2ae35;
	h ^= h >>> 16;
	return <f32>(h >>> 8) / <f32>16777216;
}

/**
 * `updateQuantised` in src/cfr.ts: the 16-bit update of one block, decoded,
 * updated as the rule says and re-encoded against the block's new largest
 * value; regrets rounded to nearest, sums at random by the same hash of slot
 * and iteration, salted with the history's `node` when storage is shared.
 * In 32-bit floats, four hands at a time, as the 32-bit update is: a 16-bit
 * value has far less precision than that, so the stored result differs
 * from JavaScript's float64 only where a value lies within float32 precision
 * of a rounding boundary. The new values are staged in the action values and
 * the strategy, as JavaScript stages them.
 */
function updateI16(
	block: usize, node: i32, slot: i32, base: usize, sumBase: usize, actions: i32, n: i32,
	reachMe: usize, strategy: usize, actionValues: usize, value: usize,
): void {
	const regretAt = regretScale + (block << 3);
	const sumAt = sumScale + (block << 3);
	blockFactors(block, factorPositive(), factorNegative(), factorSum());
	const positive = blockPositive;
	const negative = blockNegative;
	const keep = blockSum;
	const oldRegret = <f32>load<f64>(regretAt);
	const oldSum = <f32>(load<f64>(sumAt) * keep);
	const w = <f32>factorWeight();
	const pos = f32x4.splat(<f32>positive);
	const neg = f32x4.splat(<f32>negative);
	const scaleR = f32x4.splat(oldRegret);
	const scaleS = f32x4.splat(oldSum);
	const weight = f32x4.splat(w);
	const zero = f32x4.splat(0);
	const rowStride = <usize>n << 2;
	const n4 = n & ~3;
	let topR = zero;
	let topS = zero;
	for (let a = 0; a < actions; a++) {
		const row = <usize>a * rowStride;
		const q = base + (<usize>(a * n) << 1);
		const s = sumBase + (<usize>(a * n) << 1);
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			const qv = v128.load64_zero(q + (<usize>i << 1));
			const r = f32x4.mul(f32x4.convert_i32x4_s(i32x4.extend_low_i16x8_s(qv)), scaleR);
			let u = f32x4.sub(f32x4.add(f32x4.mul(r, v128.bitselect(pos, neg, f32x4.gt(r, zero))), v128.load(actionValues + row + o)), v128.load(value + o));
			if (clamp) u = f32x4.max(u, zero);
			v128.store(actionValues + row + o, u);
			topR = f32x4.max(topR, f32x4.abs(u));
			// DCFR adds the strategy unweighted by own reach (issue #8); CFR+ keeps the weight.
			let added = f32x4.mul(weight, v128.load(strategy + row + o));
			if (clamp) added = f32x4.mul(f32x4.mul(weight, v128.load(reachMe + o)), v128.load(strategy + row + o));
			const sv = v128.load64_zero(s + (<usize>i << 1));
			const sum = f32x4.add(f32x4.mul(f32x4.convert_i32x4_u(i32x4.extend_low_i16x8_u(sv)), scaleS), added);
			v128.store(strategy + row + o, sum);
			topS = f32x4.max(topS, sum);
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const r = <f32>load<i16>(q + (<usize>i << 1)) * oldRegret;
			let u = r * (r > 0 ? <f32>positive : <f32>negative) + load<f32>(actionValues + row + o) - load<f32>(value + o);
			if (clamp && u < 0) u = 0;
			store<f32>(actionValues + row + o, u);
			topR = f32x4.max(topR, f32x4.splat(Mathf.abs(u)));
			const played = load<f32>(strategy + row + o);
			const added = clamp ? w * load<f32>(reachMe + o) * played : w * played;
			const sum = <f32>load<u16>(s + (<usize>i << 1)) * oldSum + added;
			store<f32>(strategy + row + o, sum);
			topS = f32x4.max(topS, f32x4.splat(sum));
		}
	}

	// Storing into a 16-bit array truncates toward zero, so adding a half away
	// from zero rounds to nearest, and adding the dither rounds at random;
	// the narrowing saturates, which caps a sum at the top of the range.
	const largestRegret = largestLane(topR);
	const largestSum = largestLane(topS);
	const regretStep = largestRegret > 0 ? <f32>(32767 / <f64>largestRegret) : 0;
	const sumStep = largestSum > 0 ? <f32>(65535 / <f64>largestSum) : 0;
	const stepR = f32x4.splat(regretStep);
	const stepS = f32x4.splat(sumStep);
	const half = f32x4.splat(0.5);
	const sign = i32x4.splat(<i32>0x80000000);
	// Which history is re-encoding a shared block; 0 keeps unshared streams as they were.
	const mix = ditherMix(iteration, discounted !== 0 ? node : 0);
	for (let a = 0; a < actions; a++) {
		const row = <usize>a * rowStride;
		const q = base + (<usize>(a * n) << 1);
		const s = sumBase + (<usize>(a * n) << 1);
		let i = 0;
		for (; i < n4; i += 4) {
			const o = <usize>i << 2;
			const r = f32x4.mul(v128.load(actionValues + row + o), stepR);
			const rounded = i32x4.trunc_sat_f32x4_s(f32x4.add(r, v128.or(half, v128.and(r, sign))));
			v128.store64_lane(q + (<usize>i << 1), i16x8.narrow_i32x4_s(rounded, rounded), 0);
			const d = f32x4.add(f32x4.mul(v128.load(strategy + row + o), stepS), ditherLanes(slot + a * n + i, mix));
			const sum = i32x4.trunc_sat_f32x4_u(d);
			v128.store64_lane(s + (<usize>i << 1), i16x8.narrow_i32x4_u(sum, sum), 0);
		}
		for (; i < n; i++) {
			const o = <usize>i << 2;
			const r = load<f32>(actionValues + row + o) * regretStep;
			store<i16>(q + (<usize>i << 1), <i16><i32>(r < 0 ? r - 0.5 : r + 0.5));
			const d = load<f32>(strategy + row + o) * sumStep + ditherOne(slot + a * n + i, mix);
			store<u16>(s + (<usize>i << 1), <u16><u32>(d < 65535 ? d : <f32>65535));
		}
	}
	store<f64>(regretAt, <f64>largestRegret / 32767);
	store<f64>(sumAt, <f64>largestSum / 65535);
}

/** `2^(shift - 160)`, a compact hand's scale; 0 for a shift of 0. See `SHIFT_SCALE` in src/cfr.ts. */
@inline function shiftScale(shift: i32): f64 {
	return shift === 0 ? 0 : reinterpret<f64>(<u64>(shift - 160 + 1023) << 52);
}

/** `1 / shiftScale(shift)`, exactly, for a shift of 1 or more. */
@inline function shiftInverse(shift: i32): f64 {
	return reinterpret<f64>(<u64>(1023 + 160 - shift) << 52);
}

/** `scaleExponent` in src/cfr.ts: the smallest power of two bringing `largest` within `top`, biased. */
function scaleExponent(largest: f64, top: f64): i32 {
	if (!(largest > 0)) return 0;
	const bits = reinterpret<u64>(largest / top);
	let exponent = <i32>((bits >> 52) & 0x7ff) - 1023 + 160;
	if ((bits & 0xfffffffffffff) !== 0) exponent++;
	return exponent < 1 ? 0 : exponent > 255 ? 255 : exponent;
}

/** `streamSeed` in src/cfr.ts: the start of a slot's random stream on an iteration, for one history. */
@inline function streamSeed(slot: u32, t: i32, salt: u32): u32 {
	return ((slot ^ (<u32>t * 0x9e3779b1) ^ (salt * 0x7feb352d) ^ 0x5bd1e995) * 0x85ebca6b) | 1;
}

/** `nextState` in src/cfr.ts. */
@inline function nextState(h: u32): u32 {
	h ^= h >>> 15;
	h *= 0x2c1b3c6d;
	return h ^ (h >>> 12);
}

/**
 * `updateCompact` in src/cfr.ts: one compactly stored block, decoded,
 * updated in float64 as the rule says and re-encoded, in whichever mode
 * compact storage runs; a block shared by several histories is discounted
 * once an iteration, and with chance sampling, the DCFR discounts a skipped
 * block missed first. Values are worked out twice rather than staged, as in
 * `updateI16`. With shared storage the history's `node` salts the rounding
 * streams, as in the JavaScript `updateCompact` (issue #88).
 */
function updateCompact(
	block: usize, node: i32, chunk: i32, slot: i32, handBase: i32, base: usize, sumBase: usize, actions: i32, n: i32,
	reachMe: usize, strategy: usize, actionValues: usize, value: usize,
): void {
	const w = factorWeight();
	blockFactors(block, factorPositive(), factorNegative(), factorSum());
	const positive = blockPositive;
	const negative = blockNegative;
	const keep = blockSum;
	const total = actions * n;
	const rowStride = <usize>n << 2;

	if (compactMode === FLOAT) {
		for (let k = 0; k < total; k++) {
			const q = base + (<usize>k << 2);
			const accumulated = <f64>load<f32>(q);
			const updated = accumulated * (accumulated > 0 ? positive : negative)
				+ <f64>load<f32>(actionValues + (<usize>k << 2)) - <f64>load<f32>(value + (<usize>(k % n) << 2));
			store<f32>(q, <f32>(clamp && updated < 0 ? 0 : updated));
		}
		return;
	}

	const hashBase = load<u32>(chunkStart + (<usize>chunk << 2)) + <u32>slot;
	// Which history is re-encoding a shared block; 0 keeps unshared streams as they were.
	const salt: u32 = discounted !== 0 ? <u32>node : 0;
	if (compactMode === BLOCK_SCALE) {
		// One scale for the block, as 16-bit storage keeps.
		const scaleAt = compactScale + (block << 3);
		const old = load<f64>(scaleAt);
		let largest: f64 = 0;
		for (let pass = 0; pass < 2; pass++) {
			const step: f64 = largest > 0 ? steps / largest : 0;
			for (let a = 0; a < actions; a++) {
				const row = a * n;
				// One hash per row, stepped on for each hand.
				let h: u32 = stochastic ? streamSeed(hashBase + <u32>row, iteration, salt) : 0;
				for (let i = 0; i < n; i++) {
					const q = base + <usize>(row + i);
					const accumulated = <f64>load<i8>(q) * old;
					let updated = accumulated * (accumulated > 0 ? positive : negative)
						+ <f64>load<f32>(actionValues + <usize>a * rowStride + (<usize>i << 2)) - <f64>load<f32>(value + (<usize>i << 2));
					if (clamp && updated < 0) updated = 0;
					if (pass === 0) {
						const magnitude = updated < 0 ? -updated : updated;
						if (magnitude > largest) largest = magnitude;
						continue;
					}
					const v = updated * step;
					let rounded: f64;
					if (stochastic) {
						h = nextState(h);
						rounded = Math.floor(v + <f64>h / 4294967296.0);
					} else {
						rounded = Math.round(v);
					}
					store<i8>(q, <i8><i32>(rounded > steps ? steps : rounded < -steps ? -steps : rounded));
				}
			}
		}
		store<f64>(scaleAt, largest / steps);
		return;
	}

	const shifts = <usize>load<u32>(chunkShift + (<usize>chunk << 2)) + <usize>handBase;
	const sumShifts = compactSums ? <usize>load<u32>(chunkSumShift + (<usize>chunk << 2)) + <usize>handBase : 0;
	// Four hands at a time, in 32-bit floats, as `updateI16` works; the rest one by one.
	const n4 = n & ~3;
	const zero = f32x4.splat(0);
	const pos = f32x4.splat(<f32>positive);
	const neg = f32x4.splat(<f32>negative);
	const weight = f32x4.splat(<f32>w);
	const kept = f32x4.splat(<f32>keep);
	const top = f32x4.splat(<f32>steps);
	const bottom = f32x4.neg(top);
	const half = f32x4.splat(0.5);
	const byteTop = f32x4.splat(255);
	for (let i = 0; i < n4; i += 4) {
		const o = <usize>i << 2;
		const out4 = v128.load(value + o);
		const scale4 = scalesOf(v128.load32_zero(shifts + <usize>i));
		let largest = zero;
		for (let a = 0; a < actions; a++) {
			const at = actionValues + <usize>a * rowStride + o;
			const r = f32x4.mul(signedBytes(base + <usize>(a * n + i)), scale4);
			let u = f32x4.sub(f32x4.add(f32x4.mul(r, v128.bitselect(pos, neg, f32x4.gt(r, zero))), v128.load(at)), out4);
			if (clamp) u = f32x4.max(u, zero);
			v128.store(at, u);
			largest = f32x4.max(largest, f32x4.abs(u));
		}
		const exponent = exponentsOf(largest, <f32>steps);
		v128.store32_lane(shifts + <usize>i, bytesOf(exponent), 0);
		const inverse = inversesOf(exponent);
		// One stream per hand, stepped on for each action.
		let h = stochastic || compactSums ? seedsOf(hashBase + <u32>i, iteration, salt) : zero;
		for (let a = 0; a < actions; a++) {
			const v = f32x4.mul(v128.load(actionValues + <usize>a * rowStride + o), inverse);
			let rounded: v128;
			if (stochastic) {
				h = nextStates(h);
				rounded = f32x4.floor(f32x4.add(v, uniformsOf(h)));
			} else {
				rounded = f32x4.floor(f32x4.add(v, half));
			}
			const fitted = i32x4.trunc_sat_f32x4_s(f32x4.min(f32x4.max(rounded, bottom), top));
			const narrow = i16x8.narrow_i32x4_s(fitted, fitted);
			v128.store32_lane(base + <usize>(a * n + i), i8x16.narrow_i16x8_s(narrow, narrow), 0);
		}

		if (!compactSums) continue;
		// The strategy sum, scaled per hand as the regrets are.
		const sumScale4 = f32x4.mul(scalesOf(v128.load32_zero(sumShifts + <usize>i)), kept);
		const reach4 = v128.load(reachMe + o);
		let largestSum = zero;
		for (let a = 0; a < actions; a++) {
			const at = strategy + <usize>a * rowStride + o;
			// DCFR adds the strategy unweighted by own reach (issue #8); CFR+ keeps the weight.
			let added = f32x4.mul(weight, v128.load(at));
			if (clamp) added = f32x4.mul(f32x4.mul(weight, reach4), v128.load(at));
			const sum = f32x4.add(f32x4.mul(unsignedBytes(sumBase + <usize>(a * n + i)), sumScale4), added);
			v128.store(at, sum);
			largestSum = f32x4.max(largestSum, sum);
		}
		const sumExponent = exponentsOf(largestSum, 255);
		v128.store32_lane(sumShifts + <usize>i, bytesOf(sumExponent), 0);
		const sumInverse = inversesOf(sumExponent);
		for (let a = 0; a < actions; a++) {
			h = nextStates(h);
			const v = f32x4.mul(v128.load(strategy + <usize>a * rowStride + o), sumInverse);
			const rounded = i32x4.trunc_sat_f32x4_u(f32x4.min(f32x4.floor(f32x4.add(v, uniformsOf(h))), byteTop));
			const narrow = i16x8.narrow_i32x4_u(rounded, rounded);
			v128.store32_lane(sumBase + <usize>(a * n + i), i8x16.narrow_i16x8_u(narrow, narrow), 0);
		}
	}
	for (let i = n4; i < n; i++) {
		const o = <usize>i << 2;
		const out = <f64>load<f32>(value + o);
		const scale = shiftScale(<i32>load<u8>(shifts + <usize>i));
		let largest: f64 = 0;
		for (let a = 0; a < actions; a++) {
			const accumulated = <f64>load<i8>(base + <usize>(a * n + i)) * scale;
			let updated = accumulated * (accumulated > 0 ? positive : negative) + <f64>load<f32>(actionValues + <usize>a * rowStride + o) - out;
			if (clamp && updated < 0) updated = 0;
			const magnitude = updated < 0 ? -updated : updated;
			if (magnitude > largest) largest = magnitude;
		}
		const exponent = scaleExponent(largest, steps);
		store<u8>(shifts + <usize>i, <u8>exponent);
		const inverse: f64 = exponent === 0 ? 0 : shiftInverse(exponent);
		// One hash per hand, stepped on for each action.
		let h: u32 = stochastic || compactSums ? streamSeed(hashBase + <u32>i, iteration, salt) : 0;
		for (let a = 0; a < actions; a++) {
			const q = base + <usize>(a * n + i);
			const accumulated = <f64>load<i8>(q) * scale;
			let updated = accumulated * (accumulated > 0 ? positive : negative) + <f64>load<f32>(actionValues + <usize>a * rowStride + o) - out;
			if (clamp && updated < 0) updated = 0;
			const v = updated * inverse;
			let rounded: f64;
			if (stochastic) {
				h = nextState(h);
				rounded = Math.floor(v + <f64>h / 4294967296.0);
			} else {
				rounded = Math.round(v);
			}
			store<i8>(q, <i8><i32>(rounded > steps ? steps : rounded < -steps ? -steps : rounded));
		}

		if (!compactSums) continue;
		// The strategy sum, scaled per hand as the regrets are.
		const sumScale = shiftScale(<i32>load<u8>(sumShifts + <usize>i));
		const reach = <f64>load<f32>(reachMe + o);
		let largestSum: f64 = 0;
		for (let a = 0; a < actions; a++) {
			const played = <f64>load<f32>(strategy + <usize>a * rowStride + o);
			// DCFR adds the strategy unweighted by own reach (issue #8); CFR+ keeps the weight.
			const added = clamp ? w * reach * played : w * played;
			const sum = <f64>load<u8>(sumBase + <usize>(a * n + i)) * sumScale * keep + added;
			if (sum > largestSum) largestSum = sum;
		}
		const sumExponent = scaleExponent(largestSum, 255);
		store<u8>(sumShifts + <usize>i, <u8>sumExponent);
		const sumInverse: f64 = sumExponent === 0 ? 0 : shiftInverse(sumExponent);
		for (let a = 0; a < actions; a++) {
			const s = sumBase + <usize>(a * n + i);
			const played = <f64>load<f32>(strategy + <usize>a * rowStride + o);
			const added = clamp ? w * reach * played : w * played;
			const sum = <f64>load<u8>(s) * sumScale * keep + added;
			h = nextState(h);
			const rounded = Math.floor(sum * sumInverse + <f64>h / 4294967296.0);
			store<u8>(s, <u8><i32>(rounded < 255 ? rounded : 255));
		}
	}
}

/** Four signed bytes as floats. */
@inline function signedBytes(at: usize): v128 {
	return f32x4.convert_i32x4_s(i32x4.extend_low_i16x8_s(i16x8.extend_low_i8x16_s(v128.load32_zero(at))));
}

/** Four unsigned bytes as floats. */
@inline function unsignedBytes(at: usize): v128 {
	return f32x4.convert_i32x4_u(i32x4.extend_low_i16x8_u(i16x8.extend_low_i8x16_u(v128.load32_zero(at))));
}

/**
 * `shiftScale` of four hands' shifts, the bytes in the low lane, as float32:
 * `2^(shift - 160)` has the float32 exponent field `shift - 33`. Below
 * 2^-126 a scale is taken as 0; it stands for regrets under 10^-35.
 */
@inline function scalesOf(shifts: v128): v128 {
	const field = i32x4.sub(i32x4.extend_low_i16x8_u(i16x8.extend_low_i8x16_u(shifts)), i32x4.splat(33));
	return v128.and(i32x4.shl(field, 23), i32x4.gt_s(field, i32x4.splat(0)));
}

/**
 * `scaleExponent` of four hands' largest values, from float32's exponent
 * field (biased by 127, where the shift's bias is 160); 0 where a hand has none.
 */
@inline function exponentsOf(largest: v128, top: f32): v128 {
	const bits = f32x4.div(largest, f32x4.splat(top));
	let exponent = i32x4.add(v128.and(i32x4.shr_u(bits, 23), i32x4.splat(0xff)), i32x4.splat(33));
	// Not a power of two: one more. `ne` is -1 where true.
	exponent = i32x4.sub(exponent, i32x4.ne(v128.and(bits, i32x4.splat(0x7fffff)), i32x4.splat(0)));
	exponent = i32x4.min_s(i32x4.max_s(exponent, i32x4.splat(0)), i32x4.splat(255));
	return v128.and(exponent, f32x4.gt(largest, f32x4.splat(0)));
}

/** `shiftInverse` of four shifts, as float32, capped at 2^127; 0 for a shift of 0. */
@inline function inversesOf(exponent: v128): v128 {
	const field = i32x4.min_s(i32x4.max_s(i32x4.sub(i32x4.splat(287), exponent), i32x4.splat(0)), i32x4.splat(254));
	return v128.and(i32x4.shl(field, 23), i32x4.gt_s(exponent, i32x4.splat(0)));
}

/** Four 32-bit lanes of values 0 to 255 as bytes, in the low lane. */
@inline function bytesOf(values: v128): v128 {
	const narrow = i16x8.narrow_i32x4_u(values, values);
	return i8x16.narrow_i16x8_u(narrow, narrow);
}

/** `streamSeed` for four slots from `slot`. */
@inline function seedsOf(slot: u32, t: i32, salt: u32): v128 {
	const slots = i32x4.add(i32x4.splat(<i32>slot), i32x4(0, 1, 2, 3));
	const mixed = v128.xor(v128.xor(slots, i32x4.splat(t * <i32>0x9e3779b1)), i32x4.splat(<i32>(salt * 0x7feb352d) ^ 0x5bd1e995));
	return v128.or(i32x4.mul(mixed, i32x4.splat(<i32>0x85ebca6b)), i32x4.splat(1));
}

/** `nextState` of four streams. */
@inline function nextStates(h: v128): v128 {
	h = v128.xor(h, i32x4.shr_u(h, 15));
	h = i32x4.mul(h, i32x4.splat(0x2c1b3c6d));
	return v128.xor(h, i32x4.shr_u(h, 12));
}

/** Four streams' states as floats in [0, 1), to 24 bits. */
@inline function uniformsOf(h: v128): v128 {
	return f32x4.mul(f32x4.convert_i32x4_u(i32x4.shr_u(h, 8)), f32x4.splat(<f32>1 / <f32>16777216));
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
