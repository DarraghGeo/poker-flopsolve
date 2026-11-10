/**
 * Messages between the benchmark page and its solver worker, and the report
 * a solve produces.
 */

import type { SpotConfig } from '../src/index.ts';
import type { Check } from './lib/bench.ts';

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
}

/** How the solve was set up. */
export interface Setup {
	readonly threads: number;
	readonly engine: 'wasm' | 'js';
	readonly precision: 'f64' | 'f32' | 'i16';
	readonly storageBytes: number;
	readonly spot: SpotSummary;
}

/** Everything one benchmark measured. */
export interface Report {
	readonly config: SpotConfig;
	readonly target: number;
	readonly stoppedBy: 'target' | 'iterations' | 'stopped';
	readonly iterations: number;
	readonly exploitability: number | null;
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
	/** The first decision's strategy: overall, and per grid cell (null where no hand is held). */
	readonly root: {
		readonly player: 0 | 1;
		readonly actions: readonly string[];
		readonly frequencies: readonly number[];
		readonly cells: readonly (readonly number[] | null)[];
	};
}

export type Phase = 'threads' | 'build' | 'alloc' | 'solve' | 'finish';

export type Inbound =
	| { type: 'estimate'; id: number; config: SpotConfig }
	| { type: 'solve'; config: SpotConfig; target: number; threads: number; cap: number }
	| { type: 'stop' };

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
	| { type: 'estimate'; id: number; ok: true; spot: SpotSummary }
	| EstimateRefused
	| { type: 'phase'; phase: Phase; setup?: Setup }
	| { type: 'progress'; iterations: number; solveMs: number; measureMs: number; wallMs: number }
	| { type: 'check'; check: Check }
	| { type: 'done'; report: Report }
	| { type: 'error'; message: string };
