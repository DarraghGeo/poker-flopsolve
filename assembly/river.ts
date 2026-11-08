/**
 * The river kernels of `assembly/engine.ts`, batched over boards, for the
 * WebGPU experiment (#39) only.
 *
 * Purpose: the CPU side a GPU kernel has to beat. The engine's `showdown`,
 * `showdownPacked` and `matchRegret` are not exported, and exporting them
 * would change the binary every solve ships, so this module carries copies of
 * them, line for line — keep them in step with the engine — and loops them
 * over every river board the way a traversal reaches them one board at a time.
 * Nothing in the package imports it; `bin/bench-gpu.ts` and the tests do.
 *
 * Vectors are indexed by active-list entry, as `ActiveLists` in src/cfr.ts
 * lays them out, so a board's lists are contiguous slices of one array.
 */

let strength: usize = 0;
let cardA: usize = 0;
let cardB: usize = 0;
let memberStart: usize = 0;
let memberA: usize = 0;
let memberB: usize = 0;
let cardSums: usize = 0;

/**
 * Where the spot's lists are: strength (i32), cards (u8), member starts (i32)
 * and member cards (u8), all by entry as `ActiveLists`; and `scratch`, 52
 * doubles plus one per hand of the longest list, zeroed.
 */
export function init(strengths: usize, a: usize, b: usize, starts: usize, membersA: usize, membersB: usize, scratch: usize): void {
	strength = strengths;
	cardA = a;
	cardB = b;
	memberStart = starts;
	memberA = membersA;
	memberB = membersB;
	cardSums = scratch;
}

@inline function i32At(base: usize, index: i32): i32 { return load<i32>(base + (<usize>index << 2)); }
@inline function f32At(base: usize, index: i32): f32 { return load<f32>(base + (<usize>index << 2)); }

/**
 * Showdown values on every board of a batch, as the engine computes them one
 * board at a time.
 *
 * @param reach the opponent's reach, f32 by entry
 * @param out the traverser's values, f32 by entry; only its lists are written
 * @param boards five i32 per board: my list's start and count, the opponent's
 *   start and count, and 1 if the opponent's list is packed
 * @param count boards in the batch
 * @param scale chips times the round's runout weight over the chip scale
 */
export function showdownBoards(reach: usize, out: usize, boards: usize, count: i32, scale: f64): void {
	for (let b = 0; b < count; b++) {
		const at = boards + (<usize>b * 20);
		const myFrom = load<i32>(at);
		const myCount = load<i32>(at + 4);
		const oppFrom = load<i32>(at + 8);
		const oppCount = load<i32>(at + 12);
		const reachOpp = reach + (<usize>oppFrom << 2);
		const values = out + (<usize>myFrom << 2);
		if (load<i32>(at + 16)) showdownPacked(reachOpp, oppFrom, oppCount, myFrom, myCount, scale, values);
		else showdown(reachOpp, oppFrom, oppCount, myFrom, myCount, scale, values);
	}
}

/**
 * Regret matching over a batch of blocks, as the engine's `matchRegret`.
 *
 * @param regret f32 regrets
 * @param out f32 strategies, at the same offsets as the regrets
 * @param blocks three i32 per block: its offset in floats, actions, hands
 * @param count blocks in the batch
 * @param total scratch, one f32 per hand of the widest block
 */
export function matchRegretBlocks(regret: usize, out: usize, blocks: usize, count: i32, total: usize): void {
	for (let k = 0; k < count; k++) {
		const at = blocks + (<usize>k * 12);
		const base = <usize>load<i32>(at) << 2;
		matchRegret(regret + base, load<i32>(at + 4), load<i32>(at + 8), out + base, total);
	}
}

// ---- Copied from assembly/engine.ts; see the note at the top. ----

/** Current strategy: each hand's share of positive regret, uniform where none. */
function matchRegret(base: usize, actions: i32, n: i32, strategy: usize, total: usize): void {
	const rowStride = <usize>n << 2;
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

/** Showdown values: two sweeps over strength-sorted lists, as `showdownValuesHands`. */
function showdown(reachOpp: usize, oppFrom: i32, oppCount: i32, myFrom: i32, myCount: i32, scale: f64, out: usize): void {
	let running: f64 = 0;
	let j = 0;
	const wins = cardSums + 52 * 8;
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

/** Packed lists' card-removal sums; see the engine's `addMembers`. */
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
