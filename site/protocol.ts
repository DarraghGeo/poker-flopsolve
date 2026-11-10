/**
 * Messages between the benchmark page and its solver worker, and the report
 * a solve produces.
 */

import type { SpotConfig } from '../src/index.ts';
import type { Check } from './lib/bench.ts';
import type { NodeView } from './lib/explore.ts';
import type { Mode } from './lib/settings.ts';

/** A spot's size, from the solver's estimate. */
export interface SpotSummary {
	readonly rounds: number;
	readonly runouts: number;
	readonly combos: readonly [number, number];
	readonly decisionNodes: number;
	/** Storage at 32 bits. */
	readonly bytes: number;
	/** Storage at 16 bits. */
	readonly compressedBytes: number;
	/** The tab's memory cap the spot is checked against. */
	readonly maxBytes: number;
	/** The precision a solve uses: 32 bits if the tree fits the cap, else 16. */
	readonly precision: 'f32' | 'i16';
	/** Storage at that precision. */
	readonly storageBytes: number;
}

/** How the solve was set up. */
export interface Setup {
	readonly threads: number;
	readonly engine: 'wasm' | 'js';
	readonly precision: 'f64' | 'f32' | 'i16';
	readonly storageBytes: number;
	readonly spot: SpotSummary;
}

/** Where a re-solved street was dealt: the decision and board, in the solve it came from. */
export interface Origin {
	readonly layer: number;
	readonly node: number;
	readonly board: number;
}

/**
 * A decision as the walk-through draws it. `layer` is the solve it is read
 * from: 0 the benchmark's, then each street Lite re-solved (issue #147);
 * node and board are that solve's, `round` and the steps' rounds the
 * original spot's.
 */
export interface WalkView extends NodeView {
	readonly layer: number;
	/**
	 * Set on the street a re-solve opened: where its card was dealt. Its
	 * `runouts` are then that solve's, to re-solve on another card.
	 */
	readonly dealtFrom: Origin | null;
}

/** How a re-solve went. */
export interface Resolved {
	/** The street re-solved, 0 at the spot's first. */
	readonly round: number;
	readonly iterations: number;
	readonly ms: number;
	readonly stoppedBy: 'target' | 'settled' | 'iterations' | 'stopped';
}

/** Everything one benchmark measured. */
export interface Report {
	readonly config: SpotConfig;
	readonly mode: Mode;
	/**
	 * Exact: the exploitability stopped at, % of the pot. Lite: the movement
	 * of the first decisions it settles under, % of the range.
	 */
	readonly target: number;
	/** Lite: what it simplified, in plain words; null for Exact. */
	readonly lite: readonly string[] | null;
	readonly stoppedBy: 'target' | 'settled' | 'iterations' | 'stopped';
	readonly iterations: number;
	/** Exact: the last exploitability, % of pot. Lite: the last movement, % of the range. */
	readonly exploitability: number | null;
	/** Readings of that measure as the solve went. */
	readonly checks: readonly Check[];
	readonly ms: {
		readonly threads: number;
		readonly build: number;
		readonly alloc: number;
		/** Iterations only. */
		readonly solve: number;
		/** Exploitability measures. */
		readonly measure: number;
		/** Reading the result. */
		readonly finish: number;
		readonly total: number;
	};
	readonly setup: Setup & { readonly threadsAsked: number };
	readonly environment: {
		readonly userAgent: string;
		readonly cores: number;
		readonly deviceMemory: number | null;
		readonly crossOriginIsolated: boolean;
		readonly threadsUnavailable: string | null;
		readonly simd: boolean;
	};
	/** Each player's share of the pot, %. */
	readonly ev: readonly [number, number];
	/** The first decision, as the walk-through draws it. */
	readonly root: WalkView;
}

export type Phase = 'threads' | 'build' | 'alloc' | 'solve' | 'finish';

export type Inbound =
	| { type: 'estimate'; id: number; config: SpotConfig; mode: Mode }
	| { type: 'solve'; config: SpotConfig; mode: Mode; target: number; threads: number; cap: number }
	/** Stop the solve, or a re-solve, where it is. */
	| { type: 'stop' }
	/** After `done`: a decision of a solve the worker holds to draw. */
	| { type: 'view'; id: number; layer: number; node: number; board: number }
	/**
	 * After `done`, in Lite: re-solve the street `node` opens on `board`, in
	 * solve `layer`, at the spot's own betting, dropping the solves after
	 * `layer`; then draw decision `then` of the new solve.
	 */
	| { type: 'resolve'; id: number; layer: number; node: number; board: number; then: number };

/** A spot the solver will not build, and why. */
export interface EstimateRefused {
	readonly type: 'estimate';
	readonly id: number;
	readonly ok: false;
	readonly tooLarge: boolean;
	readonly spot?: SpotSummary;
	readonly message: string;
	readonly suggestions: readonly string[];
}

export type Outbound =
	| { type: 'estimate'; id: number; ok: true; spot: SpotSummary; lite: string[] | null }
	| EstimateRefused
	/** `goal`: where the solve stops on its measure, sent as it starts. */
	| { type: 'phase'; phase: Phase; setup?: Setup; goal?: number }
	| { type: 'progress'; iterations: number; solveMs: number; measureMs: number; wallMs: number }
	| { type: 'check'; check: Check }
	| { type: 'done'; report: Report }
	| { type: 'error'; message: string }
	/** A re-solve's progress; `measure` is its last reading, % as the solve's own. */
	| { type: 'resolving'; id: number; iterations: number; measure: number | null; goal: number; settle: boolean }
	/** `resolved` when the view follows a re-solve. */
	| { type: 'view'; id: number; view: WalkView | null; message?: string; resolved?: Resolved };
