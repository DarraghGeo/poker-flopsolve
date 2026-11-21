/*!
 * Vendored from https://github.com/DarraghGeo/poker-rangecompress (dist/range-compress.js) by
 * scripts/vendor-range-compress.ts: an ES module, single-threaded. Do not edit here.
 *
 * range-compress.js — shrink a poker range for a postflop solver while keeping how the range plays.
 *
 * What it does: given a player's range, the opponent's range and a flop, it keeps a subset of the combos
 * and re-weights them so that, on every turn and river the solver will deal, the range still has the same
 * distribution of hand strength. The result is an ordinary range (combos with weights 0..1).
 *
 * What it preserves: how often the range as a whole takes each action, and how its strong / medium / weak
 * parts act. What it does not preserve: what an individual combo does (see README).
 *
 * No dependencies. Works in browsers (global `RangeCompress`), web workers and Node (CommonJS).
 * Cards are 4*rank+suit with rank 0..12 = 2..A and suit 0..3 = c,d,h,s.
 *
 * Speed notes (v2): hands are never evaluated one by one. On each board the 91 rank classes are valued once
 * from rank-count bit masks (the suit-lane idea of poker-bitvaljs), flushes are patched in from a 13-bit
 * lane table, equities with exact card removal come from per-card prefix tables instead of sorting, and
 * the linear algebra works on suit orbits with a Cholesky inverse and triangular updates.
 */
function factory() {

	const RANKS = '23456789TJQKA', SUITS = 'cdhs';
	const cardFromStr = (s) => RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]);
	const cardToStr = (c) => RANKS[c >> 2] + SUITS[c & 3];
	const handToStr = (a, b) => (a > b ? cardToStr(a) + cardToStr(b) : cardToStr(b) + cardToStr(a));
	const hid = (h) => h.a * 52 + h.b;
	const cls = (h) => { const r1 = h.a >> 2, r2 = h.b >> 2, hi = Math.max(r1, r2), lo = Math.min(r1, r2); return (h.a & 3) === (h.b & 3) ? hi * 13 + lo : lo * 13 + hi; };

	/** Parses "[w]AhKh, ...[/w], AsKs, ..." (weights in percent) into [{a,b,w}] with a<b, w in 0..1. */
	function parseRange(text) {
		const out = new Map();
		const re = /\[(\d+(?:\.\d+)?)\]([^\[]*)\[\/\1\]|([^\[\],\s]+)/g;
		let m;
		const add = (tok, w) => {
			tok = tok.trim();
			if (!tok) return;
			if (tok.length !== 4) throw new Error('unsupported token ' + tok);
			let a = cardFromStr(tok.slice(0, 2)), b = cardFromStr(tok.slice(2, 4));
			if (a > b) { const t = a; a = b; b = t; }
			out.set(a * 52 + b, { a, b, w });
		};
		while ((m = re.exec(text))) {
			if (m[2] !== undefined) { const w = parseFloat(m[1]) / 100; const parts = m[2].split(','); for (let i = 0; i < parts.length; i++) add(parts[i], w); }
			else add(m[3], 1);
		}
		return [...out.values()].filter((h) => h.w > 0).sort((x, y) => x.a - y.a || x.b - y.b);
	}

	function rangeToString(hands) {
		const groups = new Map();
		for (const h of hands) {
			const k = (Math.round(h.w * 10000) / 100).toFixed(2);
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(handToStr(h.a, h.b));
		}
		const parts = [];
		for (const [k, v] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
			if (k === '100.00') parts.push(v.join(', '));
			else parts.unshift('[' + k + ']' + v.join(', ') + '[/' + k + ']');
		}
		return parts.join(', ');
	}

	// ------------------------------------------------------------------ WebAssembly kernels (optional)
	// The feature matrix, the matrix inverse and the elimination updates also exist as WebAssembly (SIMD) and are
	// used when available; the JavaScript versions below are the reference and the fallback, and give identical
	// results. Source: assembly/kernels.ts, embedded here by js/build-wasm.js.
	const KERNELS_B64 = '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RAAAAAAAAAAAITxBACEVA0AgFCAVSgRAIBIgFWotAAAiAUH/AUcEQCAGIBVqIAEgMGotAAAiAToAACAFIAFBAmpBAnRqIgEgASgCAEEBajYCACAJIBVqLQAAIQIgAyATIBVqLQAAQQN0aiIBIAErAwAgCCAVQQN0aisDACI9oDkDACADIAJBA3RqIgEgASsDACA9oDkDACA8ID2gITwLIBVBAWohFQwBCwtBAiEJA0AgCSAiQQFqTARAIAUgCUECdGoiASABKAIAIAUgCUEBa0ECdGooAgBqNgIAIAlBAWohCQwBCwtBACEIA0AgCCAUSARAIAggEmotAABB/wFHBEAgBCAFIAYgCGotAABBAWpBAnRqIgIoAgAiAUECdGogCDYCACACIAFBAWo2AgALIAhBAWohCAwBCwsgFigCRCA8OQMAIAdBAWohBwwBCwsgNSA7QQJ0IgFqKAIAISEgASA0aigCACEgIDMgO0EDdCIBaisDACE+IAEgMmorAwAhQkEAIQgDQCAIQQJIBEAgACAIQRpqQQJ0aigCACICKAIEBEAgAigCCCEfIAIoAgwhHiACKAIYIR0gAigCMCEcIAIoAjQhGyACKAI4IRogAigCPCEZIAJBQGsoAgAhGCACKAIkIRcgAigCKCEWIABBGyAIa0ECdGooAgAiASgCCCEVIAEoAgwhFCABKAIUIRMgASgCJCEnIAEoAighEiABKAIsISYgASgCRCsDACFBIAIoAgAiASA7bCElIAEgIWwhJCABICBsISNBACEBA0AgAUE0SARAIDkgAUEDdGpEAAAAAAAAAAA5AwAgAUEBaiEBDAELC0QAAAAAAAAAACE8QQAhAgNAIAIgIkgEQCAnIAJBAnQiBGooAgAhASAnIAJBAWpBAnQiA2ooAgAhB0QAAAAAAAAAACFDIAQgF2ooAgAiCSADIBdqKAIAIgZIBEAgASEEA0AgBCAHSARAIBMgEiAEQQJ0aigCACIDQQN0aisDACE9IAMgFGotAAAhBSA4IAMgFWotAABBA3RqIgMgAysDACA9oDkDACA4IAVBA3RqIgMgAysDACA9oDkDACBDID2gIUMgBEEBaiEEDAELCwNAIAYgCUoEQCAcICUgFiAJQQJ0aigCACIFakECdGogQSAmIAUgH2otAABBA3QiBGorAwChICYgBSAeai0AAEEDdCID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';
	let WK = null, arena = false, wasmOn = true, wasmP = null; const FULL = { full: true };
	function wasm() {
		if (WK !== null) return WK; WK = false;
		if (!KERNELS_B64 || typeof WebAssembly === 'undefined') return WK;
		let bin, mem, imports;
		const setup = (inst) => {
			// lookup tables for the equity kernel sit just below the arena
			new Uint8Array(mem.buffer, 16384, 8192).set(POPC); new Int8Array(mem.buffer, 16384 + 8192, 8192).set(STRT); new Int32Array(mem.buffer, 16384 + 16384, 8192).set(FLUSHV);
			return { mem, ex: inst.exports, top: 65536, limit: 0, buf: null, tab: 16384 };
		};
		try {
			bin = typeof atob === 'function' ? Uint8Array.from(atob(KERNELS_B64), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(KERNELS_B64, 'base64'));
			mem = new WebAssembly.Memory({ initial: 64 }); imports = { env: { memory: mem, abort() {} } };
			WK = setup(new WebAssembly.Instance(new WebAssembly.Module(bin), imports));
		} catch (e) {
			// browsers refuse to compile a module this size synchronously on the main thread: do it in the background
			// and use the JavaScript path until it is ready
			WK = false;
			try { if (bin && mem) wasmP = WebAssembly.instantiate(bin, imports).then((r) => { WK = setup(r.instance); return true; }, () => false); } catch (e2) { wasmP = null; }
		}
		return WK;
	}
	/** Lets go of the WebAssembly memory (tens of megabytes after a large call). The next call sets it up again,
	 *  which takes about a millisecond. For memory-tight callers; workers keep their own. */
	function releaseMemory() { if (!arena) { WK = null; wasmP = null; } }
	/** Resolves to true once the WebAssembly kernels are usable on this thread (false if they are not supported). */
	function ready() { const w = wasm(); return w ? Promise.resolve(true) : wasmP || Promise.resolve(false); }
	/** Runs fn with the big arrays placed in WebAssembly memory (so the kernels can work on them in place). The
	 *  memory is reused by the next call, so nothing made inside may be kept except plain results. */
	function withArena(bytes, fn) {
		const w = wasmOn && !arena ? wasm() : false; if (!w) return fn();
		try {
			const need = 65536 + bytes, have = w.mem.buffer.byteLength; if (need > have) w.mem.grow(Math.ceil((need - have) / 65536));
			w.top = 65536; w.buf = w.mem.buffer; w.limit = w.buf.byteLength; arena = true;
			return fn();
		} catch (e) { if (e !== FULL) throw e; arena = false; return fn(); } finally { arena = false; }
	}
	/** A typed array: in WebAssembly memory while an arena is open, an ordinary one otherwise. */
	function mk(Type, n, zero) {
		if (!arena) return new Type(n);
		const p = (WK.top + 15) & ~15, bytes = n * Type.BYTES_PER_ELEMENT; if (p + bytes > WK.limit) throw FULL;
		WK.top = p + bytes; const a = new Type(WK.buf, p, n); if (zero) a.fill(0); return a;
	}
	const inW = (a) => arena && a.buffer === WK.buf;

	// ------------------------------------------------------------------ hand values
	// A value is category * 2^20 + up to five rank nibbles; higher is better.
	const POPC = new Uint8Array(8192), STRT = new Int8Array(8192).fill(-1), FLUSHV = new Int32Array(8192);
	const top5 = (m) => { let v = 0; for (let sh = 16; sh >= 0; sh -= 4) { const r = 31 - Math.clz32(m); v |= r << sh; m &= ~(1 << r); } return v; };
	for (let m = 1; m < 8192; m++) {
		POPC[m] = POPC[m >> 1] + (m & 1);
		for (let hi = 12; hi >= 4; hi--) if (((m >> (hi - 4)) & 31) === 31) { STRT[m] = hi; break; }
		if (STRT[m] < 0 && (m & 0x100f) === 0x100f) STRT[m] = 3;
	}
	for (let m = 1; m < 8192; m++) if (POPC[m] >= 5) FLUSHV[m] = STRT[m] >= 0 ? (8 << 20) | (STRT[m] << 16) : (5 << 20) | top5(m);

	/** Value of the best non-flush hand, from masks of the ranks held at least 1, 2, 3 and 4 times. */
	function rankEval(m1, m2, m3, m4) {
		if (m4) { const q = 31 - Math.clz32(m4); return (7 << 20) | (q << 16) | ((31 - Math.clz32(m1 & ~(1 << q))) << 12); }
		const pairs = m2 & ~m3;
		if (m3) {
			const t = 31 - Math.clz32(m3); const rest = m3 & ~(1 << t);
			if (rest) return (6 << 20) | (t << 16) | ((31 - Math.clz32(rest)) << 12);
			if (pairs) return (6 << 20) | (t << 16) | ((31 - Math.clz32(pairs)) << 12);
			const st = STRT[m1]; if (st >= 0) return (4 << 20) | (st << 16);
			let r = m1 & ~(1 << t); const k1 = 31 - Math.clz32(r); r &= ~(1 << k1);
			return (3 << 20) | (t << 16) | (k1 << 12) | ((31 - Math.clz32(r)) << 8);
		}
		const st = STRT[m1]; if (st >= 0) return (4 << 20) | (st << 16);
		if (pairs) {
			const p1 = 31 - Math.clz32(pairs); const rest = pairs & ~(1 << p1);
			if (rest) { const p2 = 31 - Math.clz32(rest); return (2 << 20) | (p1 << 16) | (p2 << 12) | ((31 - Math.clz32(m1 & ~(1 << p1) & ~(1 << p2))) << 8); }
			let r = m1 & ~(1 << p1); const k1 = 31 - Math.clz32(r); r &= ~(1 << k1); const k2 = 31 - Math.clz32(r); r &= ~(1 << k2);
			return (1 << 20) | (p1 << 16) | (k1 << 12) | (k2 << 8) | ((31 - Math.clz32(r)) << 4);
		}
		return top5(m1);
	}

	/** Reference evaluator for seven cards (slow path, used for checks only). */
	function eval7(c0, c1, c2, c3, c4, c5, c6) {
		const cs = [c0, c1, c2, c3, c4, c5, c6]; const lane = [0, 0, 0, 0]; let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
		for (const c of cs) { const bit = 1 << (c >> 2); lane[c & 3] |= bit; if (m3 & bit) m4 |= bit; else if (m2 & bit) m3 |= bit; else if (m1 & bit) m2 |= bit; else m1 |= bit; }
		let v = rankEval(m1, m2, m3, m4);
		for (let s = 0; s < 4; s++) if (POPC[lane[s]] >= 5 && FLUSHV[lane[s]] > v) v = FLUSHV[lane[s]];
		return v;
	}

	// ------------------------------------------------------------------ boards
	/** Boards the solver will deal, with multiplicities. blankMask = suits dealt as one representative per rank. */
	function deckStates(flop, blankMask = 0) {
		const fm = new Set(flop); const blank = (s) => (blankMask >> s) & 1;
		const fc = [0, 0, 0, 0]; flop.forEach((c) => fc[c & 3]++);
		const pri = [0, 1, 2, 3].filter(blank).sort((x, y) => fc[x] - fc[y] || x - y);
		const proxy = (card, dead) => { if (!blank(card & 3)) return card; for (const s of pri) { const c = (card & ~3) | s; if (!dead.has(c)) return c; } throw new Error('no proxy'); };
		const tw = new Map();
		for (let x = 0; x < 52; x++) if (!fm.has(x)) { const t = proxy(x, fm); tw.set(t, (tw.get(t) || 0) + 1); }
		const rivers = [], rIdx = new Map(), turns = [];
		for (const [t, wt] of tw) {
			const dead = new Set(flop); dead.add(t); const rw = new Map();
			for (let y = 0; y < 52; y++) if (!dead.has(y)) { const u = proxy(y, dead); rw.set(u, (rw.get(u) || 0) + 1); }
			const rivs = [];
			for (const [u, wu] of rw) {
				const key = Math.min(t, u) * 52 + Math.max(t, u);
				if (!rIdx.has(key)) { rIdx.set(key, rivers.length); rivers.push([Math.min(t, u), Math.max(t, u), 0]); }
				const i = rIdx.get(key); rivers[i][2] += wt * wu; rivs.push([i, wu]);
			}
			turns.push({ card: t, w: wt, rivs });
		}
		return { rivers, turns, blankMask };
	}

	// ------------------------------------------------------------------ equities for both players in one pass
	const DCAP = 91 + 64;

	function side(h, other, R, T, want) {
		const n = h.length; const o = new Map(); for (const x of other) o.set(hid(x), x.w);
		const s = { hands: h, n, want, ca: mk(Uint8Array, n), cb: mk(Uint8Array, n), cl: mk(Uint8Array, n), w: mk(Float64Array, n), same: mk(Float64Array, n), id: mk(Uint8Array, n), dd: mk(Uint8Array, n),
			start: mk(Int32Array, DCAP + 3), ord: mk(Int32Array, n), totC: mk(Float64Array, 52), tot: 0,
			E: want ? mk(Float32Array, R * n).fill(NaN) : null, fS: mk(Float64Array, n, true), fW: mk(Float64Array, n, true), tS: want ? mk(Float64Array, T * n, true) : null, tW: want ? mk(Float64Array, T * n, true) : null };
		for (let i = 0; i < n; i++) {
			const a = h[i].a, b = h[i].b; s.ca[i] = a; s.cb[i] = b; s.w[i] = h[i].w; s.same[i] = o.get(hid(h[i])) || 0;
			const r1 = a >> 2, r2 = b >> 2, hi = r1 > r2 ? r1 : r2, lo = r1 > r2 ? r2 : r1; s.cl[i] = (hi * (hi + 1)) / 2 + lo;
		}
		return s;
	}

	/** River equity of every hand of each range against the other range, on every board, with exact card removal.
	 *  Returns for each side: E (board-major, NaN where the hand is dead), flop equity, turn equities. */
	function equitiesBoth(hA, hB, flop, states, wantA = true, wantB = true, perms = null, only = null) {
		const R = states.rivers.length, T = states.turns.length;
		const S = [side(hA, hB, R, T, wantA), side(hB, hA, R, T, wantB)];
		// Mirrored boards (suit permutations that fix the flop, when both ranges are symmetric): the equities on a
		// mirrored board are those of the original with the hands relabelled, so only one board of each set is worked out.
		const mir = [];
		if (perms && perms.length > 1) {
			const ridx = new Map(states.rivers.map((r, k) => [r[0] * 52 + r[1], k]));
			for (const p of perms) {
				if (p[0] === 0 && p[1] === 1 && p[2] === 2 && p[3] === 3) continue;
				const bmap = mk(Int32Array, R); for (let k = 0; k < R; k++) { let a = (states.rivers[k][0] & ~3) | p[states.rivers[k][0] & 3], b = (states.rivers[k][1] & ~3) | p[states.rivers[k][1] & 3]; if (a > b) { const t = a; a = b; b = t; } bmap[k] = ridx.get(a * 52 + b); }
				const hmap = S.map((s) => { const idx = new Map(s.hands.map((h, i) => [hid(h), i])); const out = mk(Int32Array, s.n); s.hands.forEach((h, i) => { let a = (h.a & ~3) | p[h.a & 3], b = (h.b & ~3) | p[h.b & 3]; if (a > b) { const t = a; a = b; b = t; } out[i] = idx.get(a * 52 + b); }); return out; });
				mir.push({ bmap, hmap });
			}
		}
		// boards already dealt with; when `only` is given (one slice of the boards), every other board starts as done
		const done = mk(Uint8Array, R, true); if (only) for (let k = 0; k < R; k++) done[k] = only[k] ? 0 : 1;
		// rank classes that occur in either range
		const present = mk(Uint8Array, 91, true); for (const s of S) for (let i = 0; i < s.n; i++) present[s.cl[i]] = 1;
		// which turn cards each river board belongs to
		const t1 = mk(Int32Array, R).fill(-1), t2 = mk(Int32Array, R).fill(-1), u1 = mk(Float64Array, R, true), u2 = mk(Float64Array, R, true);
		states.turns.forEach((t, ti) => { for (const [k, wu] of t.rivs) { if (t1[k] < 0) { t1[k] = ti; u1[k] = wu; } else { t2[k] = ti; u2[k] = wu; } } });
		const fl = [0, 0, 0, 0]; let f1 = 0, f2 = 0, f3 = 0, f4 = 0;
		for (const c of flop) { const bit = 1 << (c >> 2); fl[c & 3] |= bit; if (f3 & bit) f4 |= bit; else if (f2 & bit) f3 |= bit; else if (f1 & bit) f2 |= bit; else f1 |= bit; }
		const cv = mk(Int32Array, 91), keys = mk(Float64Array, DCAP), denseOf = mk(Uint8Array, DCAP);
		const fStamp = mk(Int32Array, 8192).fill(-1), fSlot = mk(Uint8Array, 8192), lane = new Int32Array(4), ltC = mk(Float64Array, 52, true), eqC = mk(Float64Array, 52, true);
		if (arena && WK.ex.equityPass) {
			// hand the whole pass to WebAssembly: a block of fields for the pass and one per side (see assembly/kernels.ts)
			const rT = mk(Uint8Array, R), rR = mk(Uint8Array, R), rW = mk(Float64Array, R); for (let k = 0; k < R; k++) { rT[k] = states.rivers[k][0]; rR[k] = states.rivers[k][1]; rW[k] = states.rivers[k][2]; }
			const sb = S.map((s) => { const tot = mk(Float64Array, 1), b = mk(Int32Array, 18); const o = (a) => (a ? a.byteOffset : 0);
				b.set([s.n, s.want ? 1 : 0, o(s.ca), o(s.cb), o(s.cl), o(s.w), o(s.same), o(s.id), o(s.dd), o(s.start), o(s.ord), o(s.totC), o(s.E), o(s.fS), o(s.fW), o(s.tS), o(s.tW), o(tot)]); return b; });
			const mb = mk(Int32Array, Math.max(1, mir.length * 3)); mir.forEach((x, q) => { mb[q * 3] = x.bmap.byteOffset; mb[q * 3 + 1] = x.hmap[0].byteOffset; mb[q * 3 + 2] = x.hmap[1].byteOffset; });
			const pb = mk(Int32Array, 32);
			pb.set([R, mir.length, rT.byteOffset, rR.byteOffset, rW.byteOffset, t1.byteOffset, t2.byteOffset, u1.byteOffset, u2.byteOffset, done.byteOffset, present.byteOffset, cv.byteOffset, keys.byteOffset, denseOf.byteOffset, fStamp.byteOffset, fSlot.byteOffset, ltC.byteOffset, eqC.byteOffset,
				fl[0], fl[1], fl[2], fl[3], f1, f2, f3, f4, sb[0].byteOffset, sb[1].byteOffset, mb.byteOffset, WK.tab, WK.tab + 8192, WK.tab + 16384]);
			WK.ex.equityPass(pb.byteOffset);
		} else for (let k = 0; k < R; k++) {
			if (done[k]) continue;
			const t = states.rivers[k][0], r = states.rivers[k][1], wgt = states.rivers[k][2];
			// rank masks and suit lanes of the board
			let m1 = f1, m2 = f2, m3 = f3, m4 = f4; lane[0] = fl[0]; lane[1] = fl[1]; lane[2] = fl[2]; lane[3] = fl[3];
			let bit = 1 << (t >> 2); lane[t & 3] |= bit; if (m3 & bit) m4 |= bit; else if (m2 & bit) m3 |= bit; else if (m1 & bit) m2 |= bit; else m1 |= bit;
			bit = 1 << (r >> 2); lane[r & 3] |= bit; if (m3 & bit) m4 |= bit; else if (m2 & bit) m3 |= bit; else if (m1 & bit) m2 |= bit; else m1 |= bit;
			// value of each rank class on this board (suits ignored)
			let c = 0, nk = 0;
			for (let hi = 0; hi < 13; hi++) {
				const bh = 1 << hi; let a1 = m1, a2 = m2, a3 = m3, a4 = m4;
				if (a3 & bh) a4 |= bh; else if (a2 & bh) a3 |= bh; else if (a1 & bh) a2 |= bh; else a1 |= bh;
				for (let lo = 0; lo <= hi; lo++) {
					const bl = 1 << lo; let b1 = a1, b2 = a2, b3 = a3, b4 = a4;
					if (b3 & bl) b4 |= bl; else if (b2 & bl) b3 |= bl; else if (b1 & bl) b2 |= bl; else b1 |= bl;
					if (!present[c]) { c++; continue; }
					const v = rankEval(b1, b2, b3, b4); cv[c] = v; keys[nk++] = v * 256 + c; c++;
				}
			}
			// flush suit, if the board holds three or more of one suit
			let F = -1, need = 9, fLane = 0;
			for (let s = 0; s < 4; s++) if (POPC[lane[s]] >= 3) { F = s; fLane = lane[s]; need = 5 - POPC[lane[s]]; }
			let slot = 91;
			for (let p = 0; p < 2; p++) {
				const s = S[p], n = s.n, ca = s.ca, cb = s.cb, cl = s.cl, id = s.id;
				if (F < 0) { for (let i = 0; i < n; i++) { const a = ca[i], b = cb[i]; id[i] = a === t || a === r || b === t || b === r ? 255 : cl[i]; } }
				else {
					for (let i = 0; i < n; i++) {
						const a = ca[i], b = cb[i];
						if (a === t || a === r || b === t || b === r) { id[i] = 255; continue; }
						let cnt = 0, mk = fLane; if ((a & 3) === F) { cnt++; mk |= 1 << (a >> 2); } if ((b & 3) === F) { cnt++; mk |= 1 << (b >> 2); }
						if (cnt >= need) {
							const fv = FLUSHV[mk];
							if (fv > cv[cl[i]]) { if (fStamp[mk] !== k) { fStamp[mk] = k; fSlot[mk] = slot; keys[nk++] = fv * 256 + slot; slot++; } id[i] = fSlot[mk]; continue; }
						}
						id[i] = cl[i];
					}
				}
			}
			// dense rank of every distinct value on this board
			const ks = nk === DCAP ? keys : keys.subarray(0, nk); ks.sort();
			let D = -1, prev = -1;
			for (let q = 0; q < nk; q++) { const key = ks[q]; const v = (key / 256) >>> 0; if (v !== prev) { D++; prev = v; } denseOf[key - v * 256] = D; }
			D++;
			// order each side's live hands by dense rank (counting sort), and total each side's weight per card
			for (let p = 0; p < 2; p++) {
				const s = S[p], n = s.n, ca = s.ca, cb = s.cb, id = s.id, dd = s.dd, w = s.w, totC = s.totC, start = s.start, ord = s.ord;
				start.fill(0, 0, D + 2); totC.fill(0); let tot = 0;
				for (let i = 0; i < n; i++) { const x = id[i]; if (x === 255) continue; const d = denseOf[x]; dd[i] = d; start[d + 2]++; const wi = w[i]; totC[ca[i]] += wi; totC[cb[i]] += wi; tot += wi; }
				for (let d = 2; d <= D + 1; d++) start[d] += start[d - 1];
				for (let i = 0; i < n; i++) { if (id[i] === 255) continue; ord[start[dd[i] + 1]++] = i; }   // now start[d]..start[d+1] is group d
				s.tot = tot;
			}
			// equity of each hand against the other side: walk both sides in rank order, keeping per-card running weights
			const ta = t1[k], tb = t2[k], wa = u1[k], wb = u2[k];
			for (let p = 0; p < 2; p++) {
				const s = S[p]; if (!s.want) continue; const v = S[1 - p];
				const n = s.n, ca = s.ca, cb = s.cb, same = s.same, E = s.E, fS = s.fS, fW = s.fW, tS = s.tS, tW = s.tW, hs = s.start, ho = s.ord;
				const va = v.ca, vb = v.cb, vw = v.w, vs = v.start, vo = v.ord, totC = v.totC, tot = v.tot; const base = k * n, oa = ta * n, ob = tb * n;
				ltC.fill(0); let ltT = 0;
				for (let d = 0; d < D; d++) {
					const v0 = vs[d], v1 = vs[d + 1], h0 = hs[d], h1 = hs[d + 1]; let eqT = 0;
					if (h0 < h1) {
						for (let q = v0; q < v1; q++) { const j = vo[q], wj = vw[j]; eqC[va[j]] += wj; eqC[vb[j]] += wj; eqT += wj; }
						for (let q = h0; q < h1; q++) {
							const i = ho[q], a = ca[i], b = cb[i], sw = same[i];
							const all = tot - totC[a] - totC[b] + sw;
							const e = all > 1e-12 ? (ltT - ltC[a] - ltC[b] + 0.5 * (eqT - eqC[a] - eqC[b] + sw)) / all : 0.5;
							E[base + i] = e; fS[i] += wgt * e; fW[i] += wgt;
							if (ta >= 0) { tS[oa + i] += wa * e; tW[oa + i] += wa; }
							if (tb >= 0) { tS[ob + i] += wb * e; tW[ob + i] += wb; }
						}
						for (let q = v0; q < v1; q++) { const j = vo[q], wj = vw[j]; const a = va[j], b = vb[j]; ltC[a] += wj; ltC[b] += wj; eqC[a] = 0; eqC[b] = 0; }
						ltT += eqT;
					} else { for (let q = v0; q < v1; q++) { const j = vo[q], wj = vw[j]; ltC[va[j]] += wj; ltC[vb[j]] += wj; ltT += wj; } }
				}
			}
			// fill in the mirrored boards
			for (let q = 0; q < mir.length; q++) {
				const k2 = mir[q].bmap[k]; if (k2 === k || done[k2]) continue; done[k2] = 1;
				const w2 = states.rivers[k2][2], ta2 = t1[k2], tb2 = t2[k2], wa2 = u1[k2], wb2 = u2[k2];
				for (let p = 0; p < 2; p++) {
					const s = S[p]; if (!s.want) continue; const n = s.n, id = s.id, E = s.E, hm = mir[q].hmap[p], fS = s.fS, fW = s.fW, tS = s.tS, tW = s.tW; const b1 = k * n, b2 = k2 * n, oa = ta2 * n, ob = tb2 * n;
					for (let i = 0; i < n; i++) {
						if (id[i] === 255) continue; const e = E[b1 + i], j = hm[i]; E[b2 + j] = e; fS[j] += w2 * e; fW[j] += w2;
						if (ta2 >= 0) { tS[oa + j] += wa2 * e; tW[oa + j] += wa2; }
						if (tb2 >= 0) { tS[ob + j] += wb2 * e; tW[ob + j] += wb2; }
					}
				}
			}
		}
		return S.map((s) => {
			if (!s.want) return null; const n = s.n;
			const ef = mk(Float32Array, n), et = mk(Float32Array, T * n);
			for (let i = 0; i < n; i++) ef[i] = s.fW[i] ? s.fS[i] / s.fW[i] : 0.5;
			for (let q = 0; q < T * n; q++) et[q] = s.tW[q] ? s.tS[q] / s.tW[q] : NaN;
			return { E: s.E, ef, et, fS: s.fS, fW: s.fW, tS: s.tS, tW: s.tW };
		});
	}

	// ------------------------------------------------------------------ suit symmetry
	const ALL_PERMS = (() => { const out = []; const rec = (a, rest) => { if (!rest.length) return out.push(a); rest.forEach((x, i) => rec(a.concat(x), rest.filter((_, j) => j !== i))); }; rec([], [0, 1, 2, 3]); return out; })();
	function flopPerms(flop) {
		const key = (cs) => cs.slice().sort((x, y) => x - y).join(','); const k0 = key(flop);
		return ALL_PERMS.filter((p) => key(flop.map((c) => (c & ~3) | p[c & 3])) === k0);
	}
	/** Suit permutations that leave the flop unchanged, and the orbits of the range under them. */
	function orbits(hero, flop, symmetric) {
		const perms = symmetric ? flopPerms(flop) : [[0, 1, 2, 3]];
		const idx = new Map(hero.map((h, i) => [hid(h), i])); const orb = new Int32Array(hero.length).fill(-1); const list = [];
		hero.forEach((h, i) => {
			if (orb[i] >= 0) return; const o = list.length, mem = [];
			for (const p of perms) { let a = (h.a & ~3) | p[h.a & 3], b = (h.b & ~3) | p[h.b & 3]; if (a > b) { const t = a; a = b; b = t; } const j = idx.get(a * 52 + b); if (j !== undefined && orb[j] < 0) { orb[j] = o; mem.push(j); } }
			list.push(mem);
		});
		return { orb, list, perms };
	}
	/** True when a range is unchanged by every suit permutation that fixes the flop. */
	function isSymmetric(hands, perms) {
		const idx = new Map(hands.map((h) => [hid(h), h.w]));
		for (const p of perms) for (const h of hands) { let a = (h.a & ~3) | p[h.a & 3], b = (h.b & ~3) | p[h.b & 3]; if (a > b) { const t = a; a = b; b = t; } const w = idx.get(a * 52 + b); if (w === undefined || Math.abs(w - h.w) > 1e-9) return false; }
		return true;
	}

	// ------------------------------------------------------------------ preparation
	/** Everything the matcher needs about both ranges on one flop. Each range is described against the other. */
	function prepareBoth(hA, hB, flop, states, wantA = true, wantB = true, only = null) {
		states = states || deckStates(flop, 0);
		const perms = states.blankMask ? [[0, 1, 2, 3]] : flopPerms(flop);
		const sym = perms.length > 1 && isSymmetric(hA, perms) && isSymmetric(hB, perms);
		const eq = equitiesBoth(hA, hB, flop, states, wantA, wantB, sym ? perms : null, only);
		const one = (h, e) => e && { hero: h, flop, states, n: h.length, R: states.rivers.length, E: e.E, ef: e.ef, et: e.et, boardSym: sym, perms, sums: e };
		return [one(hA, eq[0]), one(hB, eq[1])];
	}
	let lastPair = null;
	/** One range against the other (kept for the experiment scripts; the pair is computed once and reused). */
	function prepare(hero, villain, flop, states) {
		states = states || deckStates(flop, 0);
		if (lastPair && lastPair.states === states && lastPair.a === villain && lastPair.b === hero) return lastPair.res[1];
		const res = prepareBoth(hero, villain, flop, states); lastPair = { a: hero, b: villain, states, res }; return res[0];
	}

	/** Weighted RMS distance between two hands' river-equity vectors (only needed for stand-ins). */
	function distances(P) {
		if (P.D) return P.D; const { n, R, E, states } = P; const D = new Float32Array(n * n), S2 = new Float64Array(n * n), C2 = new Float64Array(n * n);
		const live = new Int32Array(n), ev = new Float64Array(n);
		for (let k = 0; k < R; k++) {
			const w = states.rivers[k][2], base = k * n; let c = 0;
			for (let i = 0; i < n; i++) { const e = E[base + i]; if (e === e) { live[c] = i; ev[c] = e; c++; } }
			for (let p = 0; p < c; p++) { const row = live[p] * n, ep = ev[p]; for (let q = p + 1; q < c; q++) { const d = ep - ev[q]; S2[row + live[q]] += w * d * d; C2[row + live[q]] += w; } }
		}
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const c = C2[i * n + j]; D[i * n + j] = D[j * n + i] = c ? Math.sqrt(S2[i * n + j] / c) : 1; }
		return (P.D = D);
	}

	// ------------------------------------------------------------------ feature Gram matrix (orbit level)
	// The features are "mass of the range in each equity bin on each board" (hat-shaped bins), summed over suit
	// orbits. The Gram matrix of those features is all the elimination needs.

	/** Orbits, and a function that visits every board state as (equity array, offset, weight). */
	function walker(P, opts = {}) {
		const B = opts.bins || 16, sw = opts.streetWeights || [1, 1, 1]; const symmetric = opts.symmetric !== false && !P.states.blankMask;
		const rsOpt = opts.riverSample || 1; const key = B + '|' + sw.join(',') + '|' + symmetric + '|' + rsOpt; if (P.walkKey === key) return P.walk;
		const { hero, flop, n, R, states } = P; const ob = orbits(hero, flop, symmetric);
		const list = [['ef', 0, sw[0]]];
		const tw = states.turns.reduce((s, t) => s + t.w, 0); states.turns.forEach((t, ti) => list.push(['et', ti * n, (sw[1] * t.w) / tw]));
		// river boards (optionally every rs-th one, weights rescaled); mirrored boards contribute the same thing at
		// orbit level, so one of each mirrored set is used and scaled
		const rws = [], rks = []; const mirrored = symmetric && P.boardSym && ob.perms.length > 1;
		const done = new Uint8Array(R), ridx = mirrored ? new Map(states.rivers.map((r, k) => [r[0] * 52 + r[1], k])) : null, repQ = new Int32Array(R);
		for (let k = 0; k < R; k++) {
			if (done[k]) continue; let wsum = states.rivers[k][2]; repQ[k] = rks.length;
			if (mirrored) { wsum = 0; for (const p of ob.perms) { let a = (states.rivers[k][0] & ~3) | p[states.rivers[k][0] & 3], b = (states.rivers[k][1] & ~3) | p[states.rivers[k][1] & 3]; if (a > b) { const t = a; a = b; b = t; } const j = ridx.get(a * 52 + b); if (!done[j]) { done[j] = 1; repQ[j] = rks.length; wsum += states.rivers[j][2]; } } }
			rks.push(k); rws.push(wsum);
		}
		// 'auto' keeps at least about 300 distinct river boards
		const rs = rsOpt === 'auto' ? Math.max(1, Math.min(3, Math.floor(rks.length / 300))) : rsOpt;
		let rw = 0; const use = []; for (let q = 0; q < rks.length; q++) if (q % rs === 0) { use.push(q); rw += rws[q]; }
		// entries are [which array ('ef', 'et' or 'E'), offset, weight]; river entries also carry their set's number
		const rivers = use.map((q) => ['E', rks[q] * n, (sw[2] * rws[q]) / rw, q]);
		P.walkKey = key; P.gramKey = null; P.walk = { key, B, ob, m: ob.list.length, fixed: list, rivers, sets: rks.length, repQ };
		return P.walk;
	}

	/** Puts one state's hands into bins. `order` lists the hands to use and `keyOf` their target index; hands with
	 *  the same key that arrive together in a bin are merged. */
	function fillBins(arr, off, order, cnt, keyOf, B, n, binK, binV, binN) {
		const Bm1 = B - 1, Bm2 = B - 2; binN.fill(0);
		for (let q = 0; q < cnt; q++) {
			const i = order[q]; const e = arr[off + i]; if (e !== e) continue; const o = keyOf[i];
			const x = (e < 0 ? 0 : e > 1 ? 1 : e) * Bm1; let b0 = x | 0; if (b0 > Bm2) b0 = Bm2; const f = x - b0;
			if (f < 1) { const base = b0 * n, c = binN[b0]; if (c && binK[base + c - 1] === o) binV[base + c - 1] += 1 - f; else { binK[base + c] = o; binV[base + c] = 1 - f; binN[b0] = c + 1; } }
			if (f > 0) { const b1 = b0 + 1, base = b1 * n, c = binN[b1]; if (c && binK[base + c - 1] === o) binV[base + c - 1] += f; else { binK[base + c] = o; binV[base + c] = f; binN[b1] = c + 1; } }
		}
	}
	/** Adds v v' * lam for the entries [from, to) of one bin into U (pairs once, above the diagonal) and diag. */
	function addPairs(U, diag, stride, binK, binV, from, to, lam) {
		for (let p = from; p < to; p++) {
			const op = binK[p], v = binV[p], vp = v * lam, row = op * stride; diag[op] += vp * v; let q = p + 1;
			for (const e = to - 3; q < e; q += 4) { U[row + binK[q]] += vp * binV[q]; U[row + binK[q + 1]] += vp * binV[q + 1]; U[row + binK[q + 2]] += vp * binV[q + 2]; U[row + binK[q + 3]] += vp * binV[q + 3]; }
			for (; q < to; q++) U[row + binK[q]] += vp * binV[q];
		}
	}
	const symmetrize = (U, diag, m) => { for (let a = 0; a < m; a++) { U[a * m + a] = diag[a] + 2 * U[a * m + a]; for (let b = a + 1; b < m; b++) { const v = U[a * m + b] + U[b * m + a]; U[a * m + b] = v; U[b * m + a] = v; } } return U; };

	/** Adds the given states to U (pairs once, above the diagonal) and diag; makes them if not supplied. */
	function accumulate(P, W, entries, U, diag) {
		const { n } = P, { B, ob, m } = W, orb = ob.orb;
		const order = mk(Int32Array, n); { let c = 0; for (const mem of ob.list) for (const i of mem) order[c++] = i; }
		U = U || mk(Float64Array, m * m, true); diag = diag || mk(Float64Array, m, true);
		const binK = mk(Int32Array, B * n), binV = mk(Float64Array, B * n), binN = mk(Int32Array, B);
		const src = (e) => P[e[0]];
		if (entries.length && inW(U) && entries.every((e) => inW(src(e)))) {
			const key = mk(Int32Array, n); key.set(orb); const ex = WK.ex;
			for (const e of entries) ex.addState(src(e).byteOffset + e[1] * 4, order.byteOffset, n, key.byteOffset, B, n, binK.byteOffset, binV.byteOffset, binN.byteOffset, U.byteOffset, diag.byteOffset, m, e[2]);
		} else for (const e of entries) { fillBins(src(e), e[1], order, n, orb, B, n, binK, binV, binN); for (let b = 0; b < B; b++) addPairs(U, diag, m, binK, binV, b * n, b * n + binN[b], e[2]); }
		return { U, diag };
	}

	/** The whole Gram matrix. */
	function gram(P, opts = {}) {
		const W = walker(P, opts); if (P.gramKey === W.key) return P.gramRes;
		const a = accumulate(P, W, W.fixed.concat(W.rivers));
		P.gramKey = W.key; P.gramRes = { Go: symmetrize(a.U, a.diag, W.m), ob: W.ob, m: W.m }; return P.gramRes;
	}

	/** Inverse of a symmetric positive definite matrix; only the lower triangle of the result is filled. */
	function invertSPD(A, m) {   // reads only the lower triangle of A
		const L = new Float64Array(m * m);
		for (let i = 0; i < m; i++) {
			const ri = i * m;
			for (let j = 0; j <= i; j++) {
				const rj = j * m; let s0 = A[ri + j], s1 = 0, s2 = 0, s3 = 0, k = 0;
				for (const e = j - 3; k < e; k += 4) { s0 -= L[ri + k] * L[rj + k]; s1 -= L[ri + k + 1] * L[rj + k + 1]; s2 -= L[ri + k + 2] * L[rj + k + 2]; s3 -= L[ri + k + 3] * L[rj + k + 3]; }
				for (; k < j; k++) s0 -= L[ri + k] * L[rj + k];
				const s = s0 + s1 + s2 + s3;
				L[ri + j] = i === j ? Math.sqrt(s > 0 ? s : 1e-300) : s / L[rj + j];
			}
		}
		// X = inverse of L (lower triangular), built row by row
		const X = new Float64Array(m * m);
		for (let i = 0; i < m; i++) {
			const ri = i * m, d = 1 / L[ri + i];
			for (let k = 0; k < i; k++) {
				const f = L[ri + k]; if (!f) continue; const rk = k * m; let j = 0;
				for (const e = k - 2; j < e; j += 4) { X[ri + j] -= f * X[rk + j]; X[ri + j + 1] -= f * X[rk + j + 1]; X[ri + j + 2] -= f * X[rk + j + 2]; X[ri + j + 3] -= f * X[rk + j + 3]; }
				for (; j <= k; j++) X[ri + j] -= f * X[rk + j];
			}
			for (let j = 0; j < i; j++) X[ri + j] *= d; X[ri + i] = d;
		}
		// P = X' X, lower triangle
		const Pm = L.fill(0);
		for (let k = 0; k < m; k++) {
			const rk = k * m;
			for (let a = 0; a <= k; a++) {
				const xa = X[rk + a]; if (!xa) continue; const ra = a * m; let b = 0;
				for (const e = a - 2; b < e; b += 4) { Pm[ra + b] += xa * X[rk + b]; Pm[ra + b + 1] += xa * X[rk + b + 1]; Pm[ra + b + 2] += xa * X[rk + b + 2]; Pm[ra + b + 3] += xa * X[rk + b + 3]; }
				for (; b <= a; b++) Pm[ra + b] += xa * X[rk + b];
			}
		}
		return Pm;
	}

	// ------------------------------------------------------------------ elimination
	/** Elimination state over the variables `idx` of the matrix M (dim x dim): the inverse of their ridged Gram
	 *  block, kept compact, and their current weights. Position q holds variable act[q]. Starts from `w0`, or from
	 *  the least-squares fit to `bvec` when w0 is null. */
	function obsState(M, dim, idx, eps, w0, bvec) {
		const k = idx.length, A = mk(Float64Array, k * k);
		for (let q = 0; q < k; q++) { const o = idx[q] * dim, r = q * k; for (let p = 0; p <= q; p++) A[r + p] = M[o + idx[p]]; A[r + q] += eps; }
		let Pm; if (arena) { Pm = mk(Float64Array, k * k); const X = mk(Float64Array, k * k); WK.ex.invertSPD(A.byteOffset, Pm.byteOffset, X.byteOffset, k); } else Pm = invertSPD(A, k);
		const wp = mk(Float64Array, k);
		if (w0) for (let q = 0; q < k; q++) wp[q] = w0[idx[q]];
		else for (let q = 0; q < k; q++) { let s = 0; const r = q * k; for (let p = 0; p <= q; p++) s += Pm[r + p] * bvec[idx[p]]; for (let p = q + 1; p < k; p++) s += Pm[p * k + q] * bvec[idx[p]]; wp[q] = s; }
		const act = mk(Int32Array, k); act.set(idx);
		return { Pm, k, na: k, act, wp, col: mk(Float64Array, k), sal: 0, w: arena, salp: arena ? mk(Float64Array, 1) : null };
	}
	/** Cheapest removal: returns its position, or -1. `st.sal` is the increase in squared error it causes. */
	function obsPick(st, skip) {
		const { Pm, k, na, wp, act } = st;
		if (st.w && !skip) { const q = WK.ex.obsPick(Pm.byteOffset, k, na, wp.byteOffset, st.salp.byteOffset); st.sal = st.salp[0]; return q; }
		let bq = -1, bs = Infinity, sal = 0;
		for (let q = 0; q < na; q++) {
			if (skip && skip(act[q])) continue;
			const wj = wp[q], cost = (wj * wj) / Pm[q * k + q], s = wj < 0 ? -1e30 + wj : cost;
			if (s < bs) { bs = s; bq = q; sal = cost; }
		}
		st.sal = sal; return bq;
	}
	/** Removes position bq, re-fitting the others exactly (rank-one update of the inverse). Returns the variable removed. */
	function obsRemove(st, bq) {
		const { Pm, k, wp, act, col } = st; let na = st.na;
		if (st.w) { const id = WK.ex.obsRemove(Pm.byteOffset, k, na, wp.byteOffset, act.byteOffset, col.byteOffset, bq); st.na = na - 1; return id; }
		const bj = act[bq];
		const rb = bq * k; for (let q = 0; q <= bq; q++) col[q] = Pm[rb + q]; for (let q = bq + 1; q < na; q++) col[q] = Pm[q * k + bq];
		const pj = col[bq], f = wp[bq] / pj, inv = 1 / pj, last = na - 1;
		if (bq !== last) {
			const rl = last * k; for (let q = 0; q < bq; q++) Pm[rb + q] = Pm[rl + q]; for (let q = bq + 1; q < last; q++) Pm[q * k + bq] = Pm[rl + q]; Pm[rb + bq] = Pm[rl + last];
			col[bq] = col[last]; wp[bq] = wp[last]; act[bq] = act[last];
		}
		na = last;
		for (let q = 0; q < na; q++) {
			const ci = col[q]; wp[q] -= f * ci; const s = ci * inv; if (!s) continue; const row = q * k; let p = 0;
			for (const e = q - 2; p < e; p += 4) { Pm[row + p] -= s * col[p]; Pm[row + p + 1] -= s * col[p + 1]; Pm[row + p + 2] -= s * col[p + 2]; Pm[row + p + 3] -= s * col[p + 3]; }
			for (; p <= q; p++) Pm[row + p] -= s * col[p];
		}
		st.na = na; return bj;
	}

	/** Backward elimination: drop the combos (whole suit orbits) the range can best do without, re-fitting the
	 *  weights of the rest each time. Returns snapshots at the requested sizes, or at the tolerance.
	 *
	 *  Unless `exact` is set, large ranges are first thinned block by block (orbits grouped by flop equity, each
	 *  block eliminating on its own), and only the survivors go through the exact elimination. This reaches the
	 *  same mismatch for a given size, and neither builds nor inverts the full matrix. */
	function eliminate(P, opts = {}) {
		const T = opts.timing, now = T ? () => Number(process.hrtime.bigint()) / 1e6 : null; let t0 = T ? now() : 0; const lap = (k) => { if (T) { const t = now(); T[k] = (T[k] || 0) + t - t0; t0 = t; } };
		const { hero } = P; const W = walker(P, opts), ob = W.ob, m = W.m;
		const osize = new Int32Array(m); ob.list.forEach((mem, o) => { osize[o] = mem.length; });
		const w0 = new Float64Array(m); ob.list.forEach((mem, o) => { let s = 0; for (const i of mem) s += hero[i].w; w0[o] = s / mem.length; });
		const targets = (opts.sizes || []).slice().sort((a, b) => b - a); const tol = opts.tolerance;
		let hands = hero.length, cum = 0; const path = [], curve = [];
		// the Gram matrix, G w0 and w0' G w0
		let Go = gram(P, opts).Go; const ocls = ob.list.map((mem) => cls(hero[mem[0]]));
		if (opts.classMu) { Go = Float64Array.from(Go); for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (ocls[i] === ocls[j]) Go[i * m + j] += opts.classMu * osize[i] * osize[j]; }
		let clsCount = null, skip = null;
		if (opts.keepClasses) { clsCount = new Map(); ocls.forEach((c) => clsCount.set(c, (clsCount.get(c) || 0) + 1)); skip = (o) => clsCount.get(ocls[o]) <= 1; }
		let tr = 0; for (let i = 0; i < m; i++) tr += Go[i * m + i]; const eps = ((opts.ridge || 1e-6) * tr) / m;
		const bl = new Float64Array(m); for (let i = 0; i < m; i++) { let s = 0; const o = i * m; for (let j = 0; j < m; j++) s += Go[o + j] * w0[j]; bl[i] = s; }
		let c0 = 0; for (let i = 0; i < m; i++) c0 += w0[i] * bl[i];
		const M = Go, dim = m; let st = null; lap('gram');

		// ---- stage 1: block-wise thinning
		const blockwise = !opts.exact && !opts.classMu && !opts.keepClasses && !opts.fullCurve && m >= (opts.blockMin || 180) && (targets.length === 1 || (tol !== undefined && !targets.length));
		if (blockwise) {
			const feq = new Float64Array(m); ob.list.forEach((mem, o) => { let s = 0; for (const i of mem) s += P.ef[i]; feq[o] = s / mem.length; });
			const order = Array.from({ length: m }, (_, o) => o).sort((x, y) => feq[x] - feq[y]); const G = Math.max(2, Math.round(m / (opts.blockSize || 110)));
			const seqs = [];
			for (let q = 0; q < G; q++) {
				const mark = arena ? WK.top : 0;
				const b = obsState(Go, m, order.slice(Math.floor((q * m) / G), Math.floor(((q + 1) * m) / G)), eps, w0, null), seq = [];
				while (b.na > 1) { const bq = obsPick(b); if (bq < 0) break; const sal = b.sal; seq.push([obsRemove(b, bq), sal]); }
				seqs.push(seq); if (arena) WK.top = mark;
			}
			lap('blockElim');
			// take removals from the blocks in order of cost, each block's own order respected
			const head = new Int32Array(G), gone = new Uint8Array(m); let h1 = hands, c1 = 0;
			const stopHands = targets.length ? Math.ceil(targets[0] * (opts.blockKeep || 1.25)) : 0, stopCost = tol !== undefined ? (tol * (opts.blockTol || 0.6)) ** 2 * c0 : Infinity;
			for (;;) {
				let bg = -1, bs = Infinity; for (let q = 0; q < G; q++) if (head[q] < seqs[q].length && seqs[q][head[q]][1] < bs) { bs = seqs[q][head[q]][1]; bg = q; }
				if (bg < 0) break; const o = seqs[bg][head[bg]][0];
				if (targets.length ? h1 - osize[o] < stopHands : c1 + bs > stopCost) break;
				gone[o] = 1; h1 -= osize[o]; c1 += bs; head[bg]++;
			}
			const keep = []; for (let o = 0; o < m; o++) if (!gone[o]) keep.push(o);
			if (keep.length < m) {
				st = obsState(Go, m, keep, eps, null, bl); let e1 = c0; for (let q = 0; q < st.k; q++) e1 -= st.wp[q] * bl[keep[q]];
				if (tol !== undefined && Math.sqrt(Math.max(0, e1) / c0) > tol) st = null; else { cum = Math.max(0, e1); hands = h1; }
			}
			lap('stage2init');
		}
		// ---- the whole range at once
		if (!st) { const all = new Int32Array(m); for (let i = 0; i < m; i++) all[i] = i; st = obsState(Go, m, all, eps, w0, null); hands = hero.length; cum = 0; }
		const snapshot = () => {
			// non-negative re-fit on the surviving orbits (coordinate descent), then the error of that fit
			const na = st.na, sup = st.act, ww = new Float64Array(m);
			const gs = mk(Float64Array, na * na), bs = mk(Float64Array, na), x = mk(Float64Array, na);
			for (let q = 0; q < na; q++) { const o = sup[q] * dim, r = q * na; bs[q] = bl[sup[q]]; x[q] = st.wp[q] > 0 ? st.wp[q] : 0; for (let p = 0; p < na; p++) gs[r + p] = M[o + sup[p]]; }
			if (arena) WK.ex.nnls(gs.byteOffset, bs.byteOffset, x.byteOffset, na, opts.sweeps || 60);
			else for (let s = 0, S = opts.sweeps || 60; s < S; s++) {
				let moved = 0;
				for (let q = 0; q < na; q++) { const r = q * na, gq = gs[r + q]; let v = bs[q] + gq * x[q]; for (let p = 0; p < na; p++) v -= gs[r + p] * x[p]; v = v > 0 ? v / gq : 0; const d = v - x[q]; if (d > moved) moved = d; else if (-d > moved) moved = -d; x[q] = v; }
				if (moved < 1e-12) break;
			}
			let e = 0, hc = 0;
			for (let q = 0; q < na; q++) { const o = sup[q]; ww[o] = x[q]; if (!x[q]) continue; hc += osize[o]; const r = q * na; let v = 0; for (let p = 0; p < na; p++) v += gs[r + p] * x[p]; e += x[q] * (v - 2 * bs[q]); }
			return { hands: hc, err: Math.sqrt(Math.max(0, e + c0) / c0), w: ww };
		};
		lap('fullInit'); let ti = 0;
		while (st.na > 1) {
			while (ti < targets.length && hands <= targets[ti]) { path.push(Object.assign({ target: targets[ti] }, snapshot())); ti++; }
			if (ti >= targets.length && tol === undefined && !opts.fullCurve) break;
			const bq = obsPick(st, skip); if (bq < 0) break; const sal = st.sal;
			if (tol !== undefined && Math.sqrt((cum + sal) / c0) > tol) break;
			const o = obsRemove(st, bq); if (clsCount) clsCount.set(ocls[o], clsCount.get(ocls[o]) - 1);
			hands -= osize[o]; cum += sal;
			if (opts.fullCurve) curve.push([hands, Math.sqrt(cum / c0)]);
		}
		lap('stage2elim');
		while (ti < targets.length) { path.push(Object.assign({ target: targets[ti] }, snapshot())); ti++; }
		if (tol !== undefined) path.push(Object.assign({ target: tol }, snapshot()));
		lap('refit');
		return { path, ob, curve };
	}

	/** Turns a snapshot into a normal range (weights scaled so the largest is 1). With `top`, also lists for every
	 *  original combo the surviving combos that stand in for it (nearest first). */
	function materialize(P, snap, ob, opts = {}) {
		const { hero, n } = P; const hands = [], reps = [];
		hero.forEach((h, i) => { const x = snap.w[ob.orb[i]]; if (x > 0) { hands.push({ a: h.a, b: h.b, w: x }); reps.push(i); } });
		let mx = 0; for (const h of hands) if (h.w > mx) mx = h.w; for (const h of hands) h.w /= mx;
		if (!opts.top) return { hands, prefs: null, err: snap.err, scale: 1 / mx };
		const D = distances(P);
		const key = (i, r) => D[i * n + r] + (opts.sameClass && cls(hero[i]) !== cls(hero[r]) ? 10 : 0);
		const prefs = hero.map((h, i) => { const top = reps.slice().sort((x, y) => key(i, x) - key(i, y)).slice(0, opts.top); return [hid(h), top.map((r) => hid(hero[r])), top.map((r) => +key(i, r).toFixed(5))]; });
		if (opts.transport) {
			// Mass-conserving stand-ins: every original combo spreads over surviving combos so that each surviving
			// combo receives exactly the weight it carries in the compressed range (entropic optimal transport).
			const m = reps.length, eps = opts.transport; const a = hero.map((h) => h.w), b = hands.map((h) => h.w);
			const sa = a.reduce((x, y) => x + y, 0), sb = b.reduce((x, y) => x + y, 0);
			const K = new Float64Array(n * m); for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) K[i * m + j] = Math.exp(-D[i * n + reps[j]] / eps);
			const u = new Float64Array(n).fill(1), v = new Float64Array(m).fill(1);
			for (let it = 0; it < (opts.transportIters || 300); it++) {
				for (let i = 0; i < n; i++) { let t = 0; const o = i * m; for (let j = 0; j < m; j++) t += K[o + j] * v[j]; u[i] = a[i] / sa / (t || 1e-300); }
				for (let j = 0; j < m; j++) { let t = 0; for (let i = 0; i < n; i++) t += K[i * m + j] * u[i]; v[j] = b[j] / sb / (t || 1e-300); }
			}
			hero.forEach((h, i) => {
				const row = []; let tot = 0; for (let j = 0; j < m; j++) { const x = u[i] * K[i * m + j] * v[j]; if (x > 0) row.push([j, x]); tot += x; }
				row.sort((x, y) => y[1] - x[1]); const top = row.slice(0, opts.top);
				prefs[i] = [hid(h), top.map((x) => hid(hero[reps[x[0]]])), top.map((x) => +D[i * n + reps[x[0]]].toFixed(5)), top.map((x) => +(x[1] / tot).toFixed(5))];
			});
		}
		return { hands, prefs, err: snap.err, scale: 1 / mx };
	}

	// ------------------------------------------------------------------ public API
	const asHands = (r) => (typeof r === 'string' ? parseRange(r) : r.map((h) => { if (!h.hand) return h; let a = cardFromStr(h.hand.slice(0, 2)), b = cardFromStr(h.hand.slice(2, 4)); if (a > b) { const t = a; a = b; b = t; } return { a, b, w: h.weight }; }));
	const asFlop = (f) => (typeof f === 'string' ? f.match(/../g).map(cardFromStr) : f);
	const asMask = (b) => (!b ? 0 : typeof b === 'number' ? b : b.reduce((m, s) => m | (1 << (typeof s === 'string' ? SUITS.indexOf(s) : s)), 0));
	const liveHands = (hands, flop) => hands.filter((h) => h.w > 0 && !flop.includes(h.a) && !flop.includes(h.b));

	/** Suits that can be dealt as one representative card per rank on this flop: every suit that cannot
	 *  make a flush by the river without two more cards of it (i.e. all suits with fewer than two flop cards). */
	function blankSuitsFor(flop) {
		flop = asFlop(flop); const fc = [0, 0, 0, 0]; flop.forEach((c) => fc[c & 3]++);
		return [0, 1, 2, 3].filter((s) => fc[s] < 2).map((s) => SUITS[s]);
	}

	/** Rough expected error of range-level action frequencies (percentage points, averaged over decisions)
	 *  for a given mismatch, from the calibration runs. Indicative only. */
	const expectedFrequencyError = (mismatch) => 0.6 + 60 * mismatch;

	// upper bound on the WebAssembly memory one call needs: the equities, then one range's matrices at a time
	const arenaBytes = (nA, nB, st) => { const n = Math.max(nA, nB); return (4 * (st.rivers.length + st.turns.length + 2) + 16 * st.turns.length + 96) * (nA + nB) + 56 * n * n + 16 * 16 * n + 12 * st.rivers.length * 8 + (4 << 20); };
	const elimOpts = (o, n, sym) => {
		const opts = { symmetric: o.symmetric !== false && sym, bins: o.bins, streetWeights: o.streetWeights, exact: o.exact, riverSample: o.riverSample || 'auto' };
		if (o.size) opts.sizes = [Math.min(o.size, n)]; else opts.tolerance = o.tolerance === undefined ? 0.01 : o.tolerance;
		if (o.curve) opts.fullCurve = true;
		return opts;
	};
	/** The work for one range: returns plain data (so it can cross a worker boundary). */
	function solveOne(P, o) {
		// suit orbits are only used when both ranges are suit-symmetric on this flop (or the flop has no symmetry)
		const el = eliminate(P, elimOpts(o, P.n, P.boardSym || P.perms.length === 1)); const m = materialize(P, el.path[0], el.ob, { top: o.standIns || 0 });
		return { hands: m.hands, prefs: m.prefs, err: m.err, scale: m.scale, n: P.n, curve: o.curve ? el.curve : undefined };
	}
	function present(r, states) {
		let standIns = null;
		if (r.prefs) { standIns = {}; r.prefs.forEach(([id, list]) => { standIns[handToStr((id / 52) | 0, id % 52)] = list.map((x) => handToStr((x / 52) | 0, x % 52)); }); }
		const hands = r.hands;
		return {
			range: rangeToString(hands), get pio() { return hands.map((h) => handToStr(h.a, h.b) + ':' + h.w.toFixed(4)).join(','); },
			hands: hands.map((h) => ({ hand: handToStr(h.a, h.b), weight: h.w })), size: hands.length, originalSize: r.n,
			mismatch: r.err, expectedFrequencyError: expectedFrequencyError(r.err), standIns, curve: r.curve, weightScale: r.scale,
			deck: states.blankMask ? { blankSuits: [0, 1, 2, 3].filter((s) => (states.blankMask >> s) & 1).map((s) => SUITS[s]), turnCards: states.turns.length, riverBoards: states.rivers.length } : null,
		};
	}

	/**
	 * Compress one player's range.
	 * @param {object} o
	 * @param {string|Array} o.range      range to compress: "[50.00]AhKd, ...[/50.00], AsKs, ..." or [{hand:'AhKd', weight:0.5}]
	 * @param {string|Array} o.opponent   the opponent's (uncompressed) range, same formats
	 * @param {string|number[]} o.flop    e.g. "Td9d6h"
	 * @param {number} [o.size]           number of combos to keep
	 * @param {number} [o.tolerance]      instead of size: keep the fewest combos whose mismatch stays below this (default 0.01)
	 * @param {string[]|number} [o.blankSuits]  only for a solver that deals these suits as one card per rank (see README)
	 * @param {boolean} [o.symmetric=true]  keep the flop's suit symmetry so the solver's isomorphism still applies
	 * @param {boolean} [o.exact]          run the elimination on the whole range at once (slower, same quality)
	 * @param {number} [o.riverSample]     match on every n-th river board (default: automatic, at most every third;
	 *                                     1 uses all of them). Turn and flop are always matched in full.
	 * @param {number} [o.standIns]       also return, for every original combo, this many nearest surviving combos (slower)
	 * @returns {{range:string, pio:string, hands:Array, size:number, originalSize:number, mismatch:number, expectedFrequencyError:number, standIns:Object}}
	 */
	function compress(o) {
		const flop = asFlop(o.flop); const hero = liveHands(asHands(o.range), flop), villain = liveHands(asHands(o.opponent), flop);
		const states = deckStates(flop, asMask(o.blankSuits));
		return present(withArena(arenaBytes(hero.length, 0, states), () => solveOne(prepareBoth(hero, villain, flop, states, true, false)[0], o)), states);
	}

	/** Compress both players' ranges for one flop in one pass. Each is matched against the other's full range.
	 *  Takes `oop` and `ip` instead of `range` and `opponent`; `sizeOop` / `sizeIp` override `size`. */
	function compressBoth(o) {
		const flop = asFlop(o.flop); const a = liveHands(asHands(o.oop), flop), b = liveHands(asHands(o.ip), flop);
		const states = deckStates(flop, asMask(o.blankSuits));
		const r = withArena(arenaBytes(a.length, b.length, states), () => {
			const P = prepareBoth(a, b, flop, states); const mark = arena ? WK.top : 0;
			const x = solveOne(P[0], Object.assign({}, o, { size: o.sizeOop || o.size })); if (arena) WK.top = mark;
			return [x, solveOne(P[1], Object.assign({}, o, { size: o.sizeIp || o.size }))];
		});
		return { oop: present(r[0], states), ip: present(r[1], states) };
	}

	return {
		compress, compressBoth, blankSuitsFor, expectedFrequencyError, parseRange, rangeToString, cardFromStr, cardToStr, handToStr,
		/** true if the WebAssembly kernels loaded; setWasm(false) forces the JavaScript path */
		get wasm() { return !!wasm(); }, setWasm(on) { wasmOn = !!on; }, ready, releaseMemory,
	};
}

export default factory();
