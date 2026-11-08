/**
 * Out-of-core river storage (issue #55): the trunk (flop and turn decisions)
 * stays in memory and the river's accumulators live in a file, paged through
 * one buffer as a traversal walks them.
 *
 * Purpose: let a flop spot whose river storage does not fit in memory solve
 * anyway, exactly, at the cost of reading and writing that storage once per
 * traversal. Opt-in through `SolveOptions.outOfCore`; nothing here runs, or
 * is even reached, without it.
 *
 * A page is everything below one turn deal of one turn chance node: the
 * river decisions of every turn line under it, on every river card. A
 * traversal visits a page's subtree in one piece, and visits pages in the
 * order they sit in the file, so the file is read and written in sequence.
 *
 * Inside a page a river decision's block on a river board starts at
 * `offset[node] + actions * rowStart[slot]`, the same formula the in-memory
 * layout uses, so `traverse` is unchanged: only `ctx.regret` and
 * `ctx.strategySum` point at the page while the river is walked, and the
 * river nodes' offsets are rewritten for each page as it comes in. Pages are
 * packed exactly, so the file is the river's storage and nothing more.
 */

import type { ActiveLists, Context, Layout, Mode, RegretStore, SumStore } from './cfr.ts';
import type { SolveOptions, Spot } from './index.ts';
import type { Runouts } from './runouts.ts';
import type { Tree } from './tree.ts';
import { NodeKind } from './tree.ts';

/**
 * Where the river storage goes: positioned reads and writes on one file. A
 * `FileSystemSyncAccessHandle` from the Origin Private File System, opened in
 * a worker, is one as it stands; in Node, `nodePageFile` adapts a descriptor.
 */
export interface PageFile {
	read(buffer: Uint8Array, options: { at: number }): number;
	write(buffer: Uint8Array, options: { at: number }): number;
	truncate(size: number): void;
	flush(): void;
}

/** How a spot's storage splits between memory and the file. */
export interface PagePlan {
	/** The round whose decisions are paged: the river. */
	readonly round: number;
	/** Per node: its page group (turn chance node) for river decisions and river chance nodes, else -1. */
	readonly groupOf: Int32Array;
	/**
	 * River decisions by group, each group's out-of-position decisions first:
	 * group `g` is `nodes[nodeStart[g]]` to `nodes[nodeStart[g + 1]]`.
	 */
	readonly nodes: Int32Array;
	readonly nodeStart: Int32Array;
	/** Turn boards: pages per group. */
	readonly pagesPerGroup: number;
	/** Per turn board and player, `t * 2 + p`: that player's rows on every river board under it. */
	readonly rowsUnder: Int32Array;
	/** Per page `g * pagesPerGroup + t`: where it starts in the file, in bytes. */
	readonly pageAt: Float64Array;
	/** Per page: slots in it, and how many belong to out-of-position's decisions. */
	readonly pageSlots: Float64Array;
	readonly pageSplit: Float64Array;
	readonly maxPageSlots: number;
	/** Bytes per stored value. */
	readonly width: number;
	/** Size of the file, in bytes: exactly the river's storage. */
	readonly fileBytes: number;
}

/** `Mode` from cfr.ts, whose values this entry may not import. */
const TRAIN = 0;
const CURRENT = 3;

/**
 * Lay out a flop spot for paging: trunk decisions packed as usual, river
 * decisions relative to their page. A river decision's place in a page
 * depends on the turn card, since boards there leave different numbers of
 * hands live, so the pager writes the river nodes' offsets in `layout.offset`
 * each time it switches page; a river board's `rowStart` counts rows from
 * the first river card under its turn card. Block indices, and so 16-bit
 * scales, are the in-memory layout's, `base`; its offsets are not used.
 */
export function buildPagedLayout(
	tree: Tree,
	runouts: Runouts,
	active: ActiveLists,
	width: number,
	base: Layout,
): { layout: Layout; plan: PagePlan } {
	if (runouts.rounds !== 3) throw new Error('outOfCore pages the river below a flop, so it needs a flop spot');
	const river = 2;
	const turn = 1;
	const rowStart = Int32Array.from(base.rowStart);
	const offset = new Int32Array(tree.nodeCount).fill(-1);
	const count = (round: number, board: number, player: number): number =>
		active.count[(active.roundBase[round] + board) * 2 + player];

	// River rows counted from the first river card under each turn card.
	const pages = runouts.counts[turn];
	const rowsUnder = new Int32Array(pages * 2);
	for (let t = 0; t < pages; t++) {
		for (let b = runouts.childStart[river][t]; b < runouts.childStart[river][t + 1]; b++) {
			for (let p = 0; p < 2; p++) {
				rowStart[(active.roundBase[river] + b) * 2 + p] = rowsUnder[t * 2 + p];
				rowsUnder[t * 2 + p] += count(river, b, p);
			}
		}
	}

	// Trunk offsets, as the in-memory layout packs them.
	const rowsInRound = (round: number, player: number): number => {
		let total = 0;
		for (let b = 0; b < runouts.counts[round]; b++) total += count(round, b, player);
		return total;
	};
	const trunkRows = [0, 1].map((round) => [rowsInRound(round, 0), rowsInRound(round, 1)]);
	let trunk = 0;
	for (const node of tree.decisionNodes) {
		if (tree.round[node] === river) continue;
		offset[node] = trunk;
		trunk += tree.numEdges[node] * trunkRows[tree.round[node]][tree.player[node]];
	}

	// Page groups in the order a traversal meets them: depth first, edges in order.
	const groupOf = new Int32Array(tree.nodeCount).fill(-1);
	const groupNodes: number[][] = [];
	const stack: [number, number][] = [[0, -1]];
	while (stack.length > 0) {
		const [node, group] = stack.pop()!;
		let here = group;
		if (tree.kind[node] === NodeKind.Chance && tree.round[node] === 0) {
			here = groupNodes.length;
			groupNodes.push([]);
		} else if (tree.round[node] === river && tree.kind[node] === NodeKind.Decision) {
			groupOf[node] = here;
			groupNodes[here].push(node);
		} else if (tree.kind[node] === NodeKind.Chance && tree.round[node] === turn) {
			groupOf[node] = here;
		}
		const first = tree.firstEdge[node];
		for (let e = tree.numEdges[node] - 1; e >= 0; e--) stack.push([tree.edgeChild[first + e], here]);
	}

	// Out of position's decisions first in each group, so a traversal reads
	// and writes only the half it needs.
	const groups = groupNodes.length;
	const nodes: number[] = [];
	const nodeStart = new Int32Array(groups + 1);
	const actionsBy = new Float64Array(groups * 2);
	for (let g = 0; g < groups; g++) {
		for (const player of [0, 1]) {
			for (const node of groupNodes[g]) {
				if (tree.player[node] !== player) continue;
				nodes.push(node);
				actionsBy[g * 2 + player] += tree.numEdges[node];
			}
		}
		nodeStart[g + 1] = nodes.length;
	}
	const pageAt = new Float64Array(groups * pages);
	const pageSlots = new Float64Array(groups * pages);
	const pageSplit = new Float64Array(groups * pages);
	let file = 0;
	let maxPageSlots = 0;
	for (let g = 0; g < groups; g++) {
		for (let t = 0; t < pages; t++) {
			const k = g * pages + t;
			pageSplit[k] = actionsBy[g * 2] * rowsUnder[t * 2];
			pageSlots[k] = pageSplit[k] + actionsBy[g * 2 + 1] * rowsUnder[t * 2 + 1];
			pageAt[k] = file;
			file += pageSlots[k] * width * 2;
			maxPageSlots = Math.max(maxPageSlots, pageSlots[k]);
		}
	}

	const scales = width === 2 ? base.blocks * 8 * 2 : 0;
	const layout: Layout = {
		offset,
		rowStart,
		roundBase: base.roundBase,
		blockOffset: base.blockOffset,
		blocks: base.blocks,
		totalSlots: trunk,
		maxActions: base.maxActions,
		// Resident: the trunk, one page and the scales.
		bytes: (trunk + maxPageSlots) * width * 2 + scales,
	};
	const plan: PagePlan = {
		round: river, groupOf, nodes: Int32Array.from(nodes), nodeStart, pagesPerGroup: pages, rowsUnder,
		pageAt, pageSlots, pageSplit, maxPageSlots, width, fileBytes: file,
	};
	return { layout, plan };
}

/** I/O a pager has done. */
export interface PagerStats {
	bytesRead: number;
	bytesWritten: number;
	pageLoads: number;
	/** Milliseconds inside file reads and writes. */
	ioMs: number;
}

/** Ranges of a page: regrets, then sums, each out of position's then in position's. */
const REGRET = 0;
const SUM = 2;

/**
 * Pages the river through one buffer. `enter` at a river chance node swaps
 * the context's accumulators to the page holding that node's subtree,
 * loading it if another is resident; `exit` swaps the trunk back. A page
 * stays resident until a different one is wanted, and only the ranges a
 * traversal changed are written back.
 */
export class Pager {
	readonly plan: PagePlan;
	readonly stats: PagerStats = { bytesRead: 0, bytesWritten: 0, pageLoads: 0, ioMs: 0 };
	private readonly file: PageFile;
	private readonly regretPage: RegretStore;
	private readonly sumPage: SumStore;
	private readonly regretBytes: Uint8Array;
	private readonly sumBytes: Uint8Array;
	private trunkRegret: RegretStore | null = null;
	private trunkSum: SumStore | null = null;
	/** Whether the context points at the page, between `enter` and `exit`. */
	active = false;
	private group = -1;
	private page = -1;
	private readonly loaded = new Uint8Array(4);
	private readonly dirty = new Uint8Array(4);
	private readonly now: () => number;

	constructor(plan: PagePlan, file: PageFile, regretPage: RegretStore, sumPage: SumStore) {
		this.plan = plan;
		this.file = file;
		this.regretPage = regretPage;
		this.sumPage = sumPage;
		this.regretBytes = new Uint8Array(regretPage.buffer, regretPage.byteOffset, regretPage.byteLength);
		this.sumBytes = new Uint8Array(sumPage.buffer, sumPage.byteOffset, sumPage.byteLength);
		this.now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
		// A fresh file reads as zeros: no regret, no strategy yet.
		file.truncate(0);
		file.truncate(plan.fileBytes);
	}

	/** Point `ctx` at the page below river chance node `node` on turn board `board`. */
	enter(ctx: Context, node: number, board: number, mode: Mode, traverser: 0 | 1): void {
		this.enterGroup(ctx, this.plan.groupOf[node], board, mode, traverser);
	}

	private enterGroup(ctx: Context, group: number, board: number, mode: Mode, traverser: 0 | 1): void {
		if (group !== this.group || board !== this.page) {
			this.evict();
			this.group = group;
			this.page = board;
			this.stats.pageLoads++;
			this.place(ctx, group, board);
		}
		const training = mode === TRAIN && ctx.applyUpdates;
		// Regret matching reads both players' regrets; the average reads sums,
		// and falls back on regrets where a hand's sums are all zero.
		this.need(REGRET);
		this.need(REGRET + 1);
		if (training) {
			this.need(SUM + traverser);
			this.dirty[REGRET + traverser] = 1;
			this.dirty[SUM + traverser] = 1;
		} else if (mode !== CURRENT) {
			this.need(SUM);
			this.need(SUM + 1);
		}
		const target = ctx as { regret: RegretStore; strategySum: SumStore };
		this.trunkRegret = target.regret;
		this.trunkSum = target.strategySum;
		target.regret = this.regretPage;
		target.strategySum = this.sumPage;
		this.active = true;
	}

	/** Point `ctx` back at the trunk. */
	exit(ctx: Context): void {
		const target = ctx as { regret: RegretStore; strategySum: SumStore };
		target.regret = this.trunkRegret!;
		target.strategySum = this.trunkSum!;
		this.active = false;
	}

	/** Whether a read starting at `node` must find its page first: a river node, no page entered. */
	wants(ctx: Context, node: number): boolean {
		return !this.active && ctx.tree.round[node] === this.plan.round;
	}

	/**
	 * Run `body` with `ctx` on the page holding river decision `node` on river
	 * board `board`, unless it is there already; for reads that start inside
	 * the river rather than above it.
	 */
	at<T>(ctx: Context, runouts: Runouts, node: number, board: number, mode: Mode, traverser: 0 | 1, body: () => T): T {
		if (!this.wants(ctx, node)) return body();
		const above = this.plan.groupOf[node];
		this.enterGroup(ctx, above, runouts.parent[this.plan.round][board], mode, traverser);
		try {
			return body();
		} finally {
			this.exit(ctx);
		}
	}

	/** Write back whatever the resident page has that the file does not. */
	flush(): void {
		this.evict();
		this.file.flush();
	}

	/** Where each of a group's river decisions starts on the page for turn board `board`. */
	private place(ctx: Context, group: number, board: number): void {
		const { nodes, nodeStart, rowsUnder } = this.plan;
		const offset = ctx.layout.offset;
		let slots = 0;
		for (let i = nodeStart[group]; i < nodeStart[group + 1]; i++) {
			const node = nodes[i];
			offset[node] = slots;
			slots += ctx.tree.numEdges[node] * rowsUnder[board * 2 + ctx.tree.player[node]];
		}
	}

	private range(which: number): [Uint8Array, number, number] {
		const plan = this.plan;
		const k = this.group * plan.pagesPerGroup + this.page;
		const slots = plan.pageSlots[k];
		const split = plan.pageSplit[k];
		const w = plan.width;
		const player = which & 1;
		const from = player === 0 ? 0 : split * w;
		const to = player === 0 ? split * w : slots * w;
		const sums = which >= SUM;
		const at = plan.pageAt[k] + (sums ? slots * w : 0) + from;
		return [(sums ? this.sumBytes : this.regretBytes).subarray(from, to), at, to - from];
	}

	private need(which: number): void {
		if (this.loaded[which]) return;
		this.loaded[which] = 1;
		const [view, at, length] = this.range(which);
		if (length === 0) return;
		const started = this.now();
		const got = this.file.read(view, { at });
		this.stats.ioMs += this.now() - started;
		if (got !== length) throw new Error(`outOfCore: read ${got} of ${length} bytes at ${at}`);
		this.stats.bytesRead += length;
	}

	private evict(): void {
		if (this.group < 0) return;
		for (let which = 0; which < 4; which++) {
			if (this.dirty[which]) {
				const [view, at, length] = this.range(which);
				if (length > 0) {
					const started = this.now();
					const put = this.file.write(view, { at });
					this.stats.ioMs += this.now() - started;
					if (put !== length) throw new Error(`outOfCore: wrote ${put} of ${length} bytes at ${at}`);
					this.stats.bytesWritten += length;
				}
			}
			this.loaded[which] = 0;
			this.dirty[which] = 0;
		}
		this.group = -1;
		this.page = -1;
	}
}

/** Refuse what `outOfCore` cannot page; see `OutOfCore`. */
function check(spot: Spot, options: SolveOptions): void {
	const refuse = (what: string) => {
		throw new Error(`outOfCore cannot be used with ${what}`);
	};
	if (spot.runouts.rounds !== 3) refuse('a turn or river spot: it pages the river below a flop');
	if (options.analysisOnly) refuse('analysisOnly');
	if (options.warmStart) refuse('warmStart');
	if (options.approximations?.coarseStart) refuse('approximations.coarseStart');
	if (options.approximations?.chanceSampling) refuse('approximations.chanceSampling');
	// Measuring a bucketed spot in the real game copies its storage out.
	if (spot.runouts.approximate) refuse('runoutBuckets that fold cards which are not mirror images');
}

/** The paging machinery, handed to `createRun` through `SolveOptions.outOfCore`. */
export interface Paging {
	readonly check: typeof check;
	readonly buildPagedLayout: typeof buildPagedLayout;
	readonly Pager: typeof Pager;
}

export const PAGING: Paging = { check, buildPagedLayout, Pager };
