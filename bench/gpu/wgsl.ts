/**
 * The WebGPU kernels, in WGSL.
 *
 * Purpose: the river showdown and regret matching from assembly/engine.ts as
 * compute shaders, on the tables in bench/gpu/layout.ts. Bench-only.
 *
 * Showdown: one workgroup per job. It scans the opponent's reach into
 * `prefix`, scans each card's short run of positions into `runs` (one thread
 * per card), and then gives each of my hands two binary searches for its
 * value, as `showdownByPrefix` in layout.ts does in JavaScript. All of it is
 * f32: WGSL has no f64. The engine sums in f64, so the two differ by rounding,
 * and the bench reports by how much.
 *
 * Every loop that holds a barrier has a constant trip count. The only early
 * return depends on the workgroup id alone, so barriers stay uniform.
 */

/** Threads per showdown workgroup; each scans `MAX_LIST / WG` entries. */
export const SHOWDOWN_WG = 128;
/** Workgroups per row of the dispatch grid; jobs past it go to the next row. */
export const GRID_ROW = 32768;

export const SHOWDOWN_WGSL = /* wgsl */ `
struct Job {
	myFrom: u32, myCount: u32, oppFrom: u32, oppCount: u32,
	oppList: u32, reachAt: u32, outAt: u32, scale: f32,
}

@group(0) @binding(0) var<storage, read> strength: array<i32>;
@group(0) @binding(1) var<storage, read> cards: array<u32>;
@group(0) @binding(2) var<storage, read> members: array<f32>;
@group(0) @binding(3) var<storage, read> cardStart: array<u32>;
@group(0) @binding(4) var<storage, read> cardPos: array<u32>;
@group(0) @binding(5) var<storage, read> jobs: array<Job>;
@group(0) @binding(6) var<storage, read> reach: array<f32>;
@group(0) @binding(7) var<storage, read_write> values: array<f32>;

const WG: u32 = ${SHOWDOWN_WG}u;
const MAX_LIST: u32 = 512u;
const CHUNK: u32 = MAX_LIST / WG;
const BUCKETS: u32 = 52u;

var<workgroup> prefix: array<f32, 513>;
var<workgroup> level: array<i32, 512>;
var<workgroup> runs: array<f32, 1024>;
var<workgroup> pos: array<u32, 1024>;
var<workgroup> starts: array<u32, 53>;
var<workgroup> partial: array<f32, ${SHOWDOWN_WG}>;

// Entries of the opponent's list weaker than v (strict), or no stronger.
fn countBelow(n: u32, v: i32, strict: bool) -> u32 {
	var lo = 0u;
	var hi = n;
	loop {
		if (lo >= hi) { break; }
		let mid = (lo + hi) >> 1u;
		let s = level[mid];
		if ((strict && s < v) || (!strict && s <= v)) { lo = mid + 1u; } else { hi = mid; }
	}
	return lo;
}

// Reach on card c among the first x entries of the opponent's list.
fn cardSum(c: u32, x: u32) -> f32 {
	let first = starts[c];
	var lo = first;
	var hi = starts[c + 1u];
	loop {
		if (lo >= hi) { break; }
		let mid = (lo + hi) >> 1u;
		if (pos[mid] < x) { lo = mid + 1u; } else { hi = mid; }
	}
	if (lo == first) { return 0.0; }
	return runs[lo - 1u];
}

@compute @workgroup_size(${SHOWDOWN_WG})
fn showdown(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) tid: u32) {
	let index = wid.x + wid.y * ${GRID_ROW}u;
	if (index >= arrayLength(&jobs)) { return; }
	let job = jobs[index];
	let n = job.oppCount;
	let list = job.oppList & 0x7fffffffu;
	let base = list * (BUCKETS + 1u);
	let runFrom = cardStart[base];
	let runLength = cardStart[base + BUCKETS] - runFrom;

	// The opponent's strengths, and their reach scanned: a chunk per thread,
	// then the chunk totals across threads.
	for (var j = tid; j < n; j += WG) { level[j] = strength[job.oppFrom + j]; }
	var chunk: array<f32, ${512 / SHOWDOWN_WG}>;
	var sum = 0.0;
	for (var k = 0u; k < CHUNK; k++) {
		let j = tid * CHUNK + k;
		if (j < n) { sum += reach[job.reachAt + j] * members[job.oppFrom + j]; }
		chunk[k] = sum;
	}
	partial[tid] = sum;
	workgroupBarrier();
	for (var offset = 1u; offset < WG; offset <<= 1u) {
		var add = 0.0;
		if (tid >= offset) { add = partial[tid - offset]; }
		workgroupBarrier();
		partial[tid] += add;
		workgroupBarrier();
	}
	var before = 0.0;
	if (tid > 0u) { before = partial[tid - 1u]; }
	for (var k = 0u; k < CHUNK; k++) { prefix[tid * CHUNK + k + 1u] = before + chunk[k]; }
	if (tid == 0u) { prefix[0] = 0.0; }

	// Each card's run of positions, scanned by one thread.
	for (var k = tid; k < runLength; k += WG) { pos[k] = cardPos[runFrom + k]; }
	if (tid <= BUCKETS) { starts[tid] = cardStart[base + tid] - runFrom; }
	workgroupBarrier();
	if (tid < BUCKETS) {
		var run = 0.0;
		for (var k = starts[tid]; k < starts[tid + 1u]; k++) {
			run += reach[job.reachAt + pos[k]];
			runs[k] = run;
		}
	}
	workgroupBarrier();

	for (var i = tid; i < job.myCount; i += WG) {
		let mine = strength[job.myFrom + i];
		let lo = countBelow(n, mine, true);
		let hi = countBelow(n, mine, false);
		let both = cards[job.myFrom + i];
		let a = both & 0xffu;
		let b = both >> 8u;
		let win = prefix[lo] - cardSum(a, lo) - cardSum(b, lo);
		let lose = prefix[n] - prefix[hi] - (cardSum(a, n) - cardSum(a, hi)) - (cardSum(b, n) - cardSum(b, hi));
		values[job.outAt + i] = job.scale * (win - lose);
	}
}
`;

/** Threads per regret-matching workgroup; one workgroup per block. */
export const MATCH_WG = 64;

export const MATCH_WGSL = /* wgsl */ `
struct Block { offset: u32, actions: u32, count: u32, unused: u32 }

@group(0) @binding(0) var<storage, read> regret: array<f32>;
@group(0) @binding(1) var<storage, read> blocks: array<Block>;
@group(0) @binding(2) var<storage, read_write> strategy: array<f32>;

@compute @workgroup_size(${MATCH_WG})
fn matchRegret(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) tid: u32) {
	let index = wid.x + wid.y * ${GRID_ROW}u;
	if (index >= arrayLength(&blocks)) { return; }
	let block = blocks[index];
	let even = 1.0 / f32(block.actions);
	for (var i = tid; i < block.count; i += ${MATCH_WG}u) {
		var total = 0.0;
		for (var a = 0u; a < block.actions; a++) { total += max(regret[block.offset + a * block.count + i], 0.0); }
		for (var a = 0u; a < block.actions; a++) {
			let at = block.offset + a * block.count + i;
			if (total > 0.0) { strategy[at] = max(regret[at], 0.0) / total; } else { strategy[at] = even; }
		}
	}
}
`;
