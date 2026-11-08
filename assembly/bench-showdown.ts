/**
 * The engine's river kernels, alone, for the WebGPU comparison (issue #39).
 *
 * Purpose: time `showdown`, `showdownPacked` and `matchRegret` from
 * assembly/engine.ts on their own, over a batch of jobs, as the CPU side
 * that a GPU kernel has to beat. Exporting them from the engine would change
 * the shipped binary, so the functions are copied here unchanged. Only
 * `setup`, `runShowdowns` and `runMatches` are new: they drive a batch from
 * inside WebAssembly, so the timing has no JavaScript call per job.
 *
 * Bench-only: scripts/build-wasm.ts does not build this file, and src/ never
 * loads it. bin/bench-gpu.ts compiles it when run.
 */

let cardA: usize = 0;
let cardB: usize = 0;
let strength: usize = 0;
let memberStart: usize = 0;
let memberA: usize = 0;
let memberB: usize = 0;
let cardSums: usize = 0;

@inline function i32At(base: usize, index: i32): i32 { return load<i32>(base + (<usize>index << 2)); }
@inline function f32At(base: usize, index: i32): f32 { return load<f32>(base + (<usize>index << 2)); }

/** Where the hand lists are, as in the engine's header; `sums` holds 52 + the longest list doubles. */
export function setup(a: usize, b: usize, s: usize, ms: usize, ma: usize, mb: usize, sums: usize): void {
	cardA = a;
	cardB = b;
	strength = s;
	memberStart = ms;
	memberA = ma;
	memberB = mb;
	cardSums = sums;
}

/**
 * A batch of showdowns. Each job is 8 words: my list's start and length, the
 * opponent's start and length, the opponent's list index with bit 31 set
 * when packed, where the job's reach starts and where its values go (both in
 * floats from `reach` and `out`), and the scale as an f32.
 */
export function runShowdowns(jobs: usize, count: i32, reach: usize, out: usize): void {
	for (let i = 0; i < count; i++) {
		const job = jobs + (<usize>i << 5);
		const myFrom = load<i32>(job);
		const myCount = load<i32>(job + 4);
		const oppFrom = load<i32>(job + 8);
		const oppCount = load<i32>(job + 12);
		const packed = (load<u32>(job + 16) >>> 31) !== 0;
		const reachOpp = reach + (<usize>load<u32>(job + 20) << 2);
		const values = out + (<usize>load<u32>(job + 24) << 2);
		const scale = <f64>load<f32>(job + 28);
		if (packed) showdownPacked(reachOpp, oppFrom, oppCount, myFrom, myCount, scale, values);
		else showdown(reachOpp, oppFrom, oppCount, myFrom, myCount, scale, values);
	}
}

/**
 * A batch of regret matchings. Each block is 4 words: its offset in
 * `regret` (in floats), actions, hands, and one unused. Each strategy lands
 * in `scratch`, as the engine's lands in a per-depth buffer.
 */
export function runMatches(blocks: usize, count: i32, regret: usize, scratch: usize): void {
	for (let i = 0; i < count; i++) {
		const block = blocks + (<usize>i << 4);
		matchRegret(regret + (<usize>load<u32>(block) << 2), load<i32>(block + 4), load<i32>(block + 8), scratch);
	}
}

// --- Copied from assembly/engine.ts, unchanged. ---

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
