/** Types for the part of the vendored range compressor this package calls. */

/** One combination of a range: two cards, e.g. "AsKh", and its weight. */
export interface WeightedHand {
	readonly hand: string;
	readonly weight: number;
}

/** One range after compression. */
export interface CompressedRange {
	/** The surviving combinations, weights scaled so the largest is 1. */
	readonly hands: readonly WeightedHand[];
	readonly size: number;
	readonly originalSize: number;
	/** How far the compressed range is from the original in the matched features; 0 is identical. */
	readonly mismatch: number;
	/**
	 * With `standIns`: for every combination of the original range, the
	 * surviving combinations that play most like it, nearest first (itself,
	 * if it survived). Null otherwise.
	 */
	readonly standIns: Readonly<Record<string, readonly string[]>> | null;
}

declare const RangeCompress: {
	compressBoth(options: {
		readonly oop: readonly WeightedHand[];
		readonly ip: readonly WeightedHand[];
		/** Where the spot starts: three, four or five cards, e.g. "Td9d6h2c". */
		readonly board: string;
		readonly tolerance?: number;
		readonly sizeOop?: number;
		readonly sizeIp?: number;
		/** Also list this many stand-ins for every original combination. */
		readonly standIns?: number;
	}): { readonly oop: CompressedRange; readonly ip: CompressedRange };
	/** Whether the WebAssembly kernels loaded on this thread. */
	readonly wasm: boolean;
	/** Lets go of the WebAssembly memory a call grew; the next call sets it up again. */
	releaseMemory(): void;
};

export default RangeCompress;
