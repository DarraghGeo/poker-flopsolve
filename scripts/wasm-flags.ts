/**
 * The AssemblyScript compiler flags every module here is built with.
 *
 * Purpose: one list for scripts/build-wasm.ts and for the bench-only module
 * of bench/gpu/compile.ts, so a bench binary is built as the engine is.
 */
export const ASC_FLAGS = ['--enable', 'simd', '--enable', 'bulk-memory', '-O3', '--runtime', 'stub', '--importMemory', '--noAssert'] as const;
