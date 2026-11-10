/**
 * The Lite browser benchmark's page and server (issue #133).
 *
 * Purpose: serve a page, cross-origin isolated so browser threads can run,
 * that times `solveLite` in whatever browser opens it (see
 * `bench/lite/user-bench.ts` for what one case measures). The page runs
 * each case in a fresh Web Worker, so one case's memory and threads are
 * gone before the next starts, shows a summary table and the full JSON
 * report to copy, and posts the report back here, where it is saved under
 * `scratch/bench-lite/` and summarised in the terminal.
 *
 * Page settings come from the form, or from the URL's query: `spots`
 * (rainbow, two-tone, monotone), `custom` (a SpotConfig as JSON), `threads`
 * (`1,2,4,max`), `variant` (default, keep or both), `mode` (settle, or a
 * number for that many fixed iterations), `resolve` (1 or 0) and `autorun=1`.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { SpotConfig } from '../../src/index.ts';
import { bundleForBrowser, ISOLATION_HEADERS } from '../../scripts/browser-harness.ts';
import { full, type Board } from '../blueprint-share/spots.ts';
import type { BenchReport } from './user-bench-summary.ts';
import { formatSummary, summarise } from './user-bench-summary.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The largest report accepted, in characters. */
const MAX_REPORT = 32 * 2 ** 20;

/** Issue #47's betting on the three bench flops: what `solveLite` was measured on. */
export function benchSpots(): Record<string, SpotConfig> {
	const out: Record<string, SpotConfig> = {};
	for (const name of ['rainbow', 'two-tone', 'monotone'] as Board[]) {
		// The blueprint is a few hundred MiB; the full tree's 64 GiB cap only matters to `defineSpot` of the full tree, which nothing here does.
		out[name] = { ...full(name), maxBytes: 3.5 * 2 ** 30 };
	}
	return out;
}

/** Page defaults, as the query or the command line gives them. */
export interface PageDefaults {
	readonly spots?: string;
	readonly custom?: string;
	readonly threads?: string;
	readonly variant?: string;
	readonly mode?: string;
	readonly resolve?: string;
}

/** A running bench server. */
export interface BenchServer {
	readonly url: string;
	/** Resolves with each report a page posts back, in turn. */
	nextReport(): Promise<BenchReport>;
	close(): Promise<void>;
}

/**
 * Bundle the page and serve it.
 * @param options `port` (0 for any), `host`, and `save` false to keep reports out of `scratch/`
 */
export async function startBenchServer(
	options: { port?: number; host?: string; save?: boolean; quiet?: boolean } = {},
): Promise<BenchServer> {
	const [entry, summary] = await Promise.all([
		bundleForBrowser(`export { environment, runCase } from './bench/lite/user-bench.ts';`),
		bundleForBrowser(`export { caseLabel, formatSummary, summarise } from './bench/lite/user-bench-summary.ts';`),
	]);
	const meta = { version: packageVersion(), commit: commit() };
	const files: Record<string, [string, string]> = {
		'/': ['text/html; charset=utf-8', page(benchSpots(), meta)],
		'/worker.js': ['text/javascript', WORKER],
		'/entry.js': ['text/javascript', entry],
		'/summary.js': ['text/javascript', summary],
	};
	const waiting: ((report: BenchReport) => void)[] = [];
	const queued: BenchReport[] = [];
	const server: Server = createServer((request, response) => {
		const path = (request.url ?? '/').split('?')[0];
		if (request.method === 'POST' && path === '/result') {
			// Only this page may post: a page from another origin sends its own Origin.
			const origin = request.headers.origin;
			if (origin !== undefined && origin !== `http://${request.headers.host}`) return void response.writeHead(403).end();
			let body = '';
			let refused = false;
			request.setEncoding('utf8');
			request.on('data', (chunk: string) => {
				body += chunk;
				if (body.length > MAX_REPORT && !refused) {
					refused = true;
					response.writeHead(413).end();
					request.destroy();
				}
			});
			request.on('end', () => {
				if (refused) return;
				let report: BenchReport;
				try {
					report = JSON.parse(body) as BenchReport;
				} catch {
					return void response.writeHead(400).end();
				}
				if (!Array.isArray(report?.cases) || !Array.isArray(report.errors)) return void response.writeHead(400).end();
				response.writeHead(204).end();
				if (options.save !== false) save(report, options.quiet === true);
				const next = waiting.shift();
				if (next) next(report);
				else queued.push(report);
			});
			return;
		}
		const file = files[path];
		if (!file) return void response.writeHead(404).end();
		response.writeHead(200, { 'content-type': file[0], 'cache-control': 'no-store', ...ISOLATION_HEADERS }).end(file[1]);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', (error: NodeJS.ErrnoException) =>
			reject(error.code === 'EADDRINUSE' ? new Error(`port ${options.port ?? 8788} is in use: another bench running? Pass --port`) : error));
		server.listen(options.port ?? 8788, options.host ?? '127.0.0.1', () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	// A wildcard address is opened as localhost, which browsers count as a secure context.
	const host = options.host === undefined || ['0.0.0.0', '::', '127.0.0.1'].includes(options.host) ? 'localhost' : options.host;
	return {
		url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`,
		nextReport() {
			const ready = queued.shift();
			return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
		},
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/** Save a report under `scratch/bench-lite/` and print its summary. */
function save(report: BenchReport, quiet: boolean): void {
	const dir = `${ROOT}scratch/bench-lite`;
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const path = `${dir}/${stamp}.json`;
	writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
	if (quiet) return;
	const env = report.environment;
	if (env) {
		console.log(`\n${env.userAgent}`);
		console.log(`${env.hardwareConcurrency} cores reported, cross-origin isolated: ${env.crossOriginIsolated}, SIMD: ${env.simd}` +
			(env.threadsUnavailable ? `, threads unavailable: ${env.threadsUnavailable}` : ''));
	} else {
		console.log('\nNo case reported its environment.');
	}
	console.log(formatSummary(summarise(report.cases)));
	for (const e of report.errors) console.log(`error in ${e.label}: ${e.error.split('\n')[0]}`);
	console.log(`\nSaved ${path}`);
}

function packageVersion(): string {
	try {
		return (JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { version: string }).version;
	} catch {
		return 'unknown';
	}
}

function commit(): string {
	try {
		return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return 'unknown';
	}
}

/** The worker: one case per message, progress as it goes. */
const WORKER = `import { environment, runCase } from './entry.js';
onmessage = async (event) => {
	try {
		const result = await runCase(event.data, (progress) => postMessage({ kind: 'progress', progress }));
		postMessage({ kind: 'done', result, environment: environment() });
	} catch (error) {
		postMessage({ kind: 'error', error: String((error && error.stack) || error), environment: environment() });
	}
};
`;

/** The page, with the bench spots and build details filled in. */
function page(spots: Record<string, SpotConfig>, meta: { version: string; commit: string }): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lite browser bench</title>
<style>
	:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --muted: #6b6b70; --line: #d8d8dc; --accent: #2a62d6; }
	@media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --bg: #17171a; --muted: #9a9aa2; --line: #36363c; --accent: #6d9bff; } }
	body { font: 15px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 980px; padding: 16px; }
	h1 { font-size: 20px; margin: 0 0 4px; }
	p { margin: 6px 0; color: var(--muted); }
	fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 12px 0; padding: 10px 12px; }
	legend { color: var(--muted); padding: 0 4px; }
	label { margin-right: 14px; white-space: nowrap; }
	input[type=text], select, textarea { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; }
	textarea { width: 100%; box-sizing: border-box; font: 12px ui-monospace, monospace; }
	button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: white; cursor: pointer; }
	button.secondary { background: transparent; color: var(--accent); }
	button:disabled { opacity: 0.5; cursor: default; }
	pre { font: 12px/1.4 ui-monospace, monospace; background: color-mix(in srgb, var(--line) 25%, transparent); border-radius: 8px; padding: 10px; overflow-x: auto; }
	#status { font-weight: 600; }
	.warn { color: #c0392b; }
</style>
<h1>Lite browser bench</h1>
<p>Times <code>solveLite</code> phase by phase in this browser: the preset (with the line pick under keepBudget), building the spot, allocating, the iterations, the settle checks and an optional turn re-solve. Each case runs in its own worker. Keep this tab in front and the machine plugged in, and close other heavy tabs.</p>
<p id="isolation"></p>
<fieldset><legend>Spots: issue #47's betting (0.33 / 0.75 / 1.5 pot, a 0.75 raise, all-in, three raises; pot 55, stack 975, the bench ranges)</legend>
	<label><input type="checkbox" name="spot" value="rainbow"> rainbow As Kh 7d</label>
	<label><input type="checkbox" name="spot" value="two-tone"> two-tone Ts 9s 4h</label>
	<label><input type="checkbox" name="spot" value="monotone"> monotone Ks 9s 4s</label>
	<p>Or your own spot, as a <code>SpotConfig</code> in JSON (used as well as any boxes ticked; leave empty for none):</p>
	<textarea id="custom" rows="4" placeholder='{"board":"As Kh 7d","pot":55,"stack":975,"oop":"...","ip":"...","betSizes":[[0.33,0.75,1.5]],"raiseSizes":[[0.75]],"maxRaises":3,"allowAllIn":true}'></textarea>
</fieldset>
<fieldset><legend>Runs</legend>
	<label>Threads <input type="text" id="threads" size="12"> <span id="cores"></span></label>
	<label>Variant <select id="variant"><option value="default">solveLite defaults</option><option value="keep">keepBudget 150 MiB, i16</option><option value="both">both</option></select></label>
	<label>Stop <select id="mode"><option value="settle">settle, as solveLite</option><option value="100">fixed 100 iterations</option><option value="200">fixed 200 iterations</option></select></label>
	<label><input type="checkbox" id="resolve"> time a turn re-solve</label>
</fieldset>
<button id="run">Run</button> <span id="status"></span>
<pre id="log"></pre>
<h2 style="font-size:16px">Summary</h2>
<pre id="summary">Not run yet.</pre>
<button id="copy" class="secondary" disabled>Copy JSON report</button>
<button id="download" class="secondary" disabled>Download JSON</button>
<details><summary>JSON report</summary><pre id="json"></pre></details>
<script type="module">
import { caseLabel, formatSummary, summarise } from './summary.js';
const SPOTS = ${JSON.stringify(spots)};
const META = ${JSON.stringify(meta)};
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 1;

$('cores').textContent = '(' + cores + ' cores reported; "max" is that)';
$('isolation').innerHTML = crossOriginIsolated
	? 'Cross-origin isolated: browser threads can run.'
	: '<span class="warn">Not cross-origin isolated: every run will be single-threaded. Open the page at the localhost address the terminal printed.</span>';
const spotsWanted = (query.get('spots') ?? (query.has('custom') ? '' : 'rainbow')).split(',').filter(Boolean);
const unknownSpots = spotsWanted.filter((name) => !(name in SPOTS));
for (const box of document.querySelectorAll('input[name=spot]')) box.checked = spotsWanted.includes(box.value);
$('custom').value = query.get('custom') ?? '';
$('threads').value = query.get('threads') ?? '1,2,4,max';
const variantWanted = query.get('variant') ?? 'default';
$('variant').value = variantWanted;
const mode = query.get('mode') ?? 'settle';
const modeOk = mode === 'settle' || (Number.isInteger(Number(mode)) && Number(mode) >= 1);
if (modeOk && mode !== 'settle' && ![...$('mode').options].some((o) => o.value === mode)) $('mode').add(new Option('fixed ' + mode + ' iterations', mode));
$('mode').value = modeOk ? mode : 'settle';
// Settings the form cannot show are refused at Run, not quietly replaced.
const queryProblems = [
	...unknownSpots.map((name) => 'unknown spot "' + name + '"; try ' + Object.keys(SPOTS).join(', ')),
	...($('variant').value === variantWanted ? [] : ['unknown variant "' + variantWanted + '"; try default, keep or both']),
	...(modeOk ? [] : ['mode must be settle or a whole number of iterations from 1; got "' + mode + '"']),
];
$('resolve').checked = (query.get('resolve') ?? '1') === '1';

const log = (line) => { $('log').textContent += line + '\\n'; };

function threadList() {
	const out = new Set();
	for (const token of $('threads').value.split(',').map((t) => t.trim()).filter(Boolean)) {
		const n = token === 'max' ? cores : Number(token);
		if (!Number.isInteger(n) || n < 1) throw new Error('threads: whole numbers or "max", comma-separated; got ' + token);
		out.add(n);
	}
	return [...out].sort((a, b) => a - b);
}

function cases() {
	if (queryProblems.length > 0) throw new Error(queryProblems.join('; '));
	const spots = [...document.querySelectorAll('input[name=spot]:checked')].map((box) => ({ name: box.value, config: SPOTS[box.value] }));
	const custom = $('custom').value.trim();
	if (custom) spots.push({ name: 'custom', config: JSON.parse(custom) });
	if (spots.length === 0) throw new Error('pick a spot');
	const variants = $('variant').value === 'both' ? ['default', 'keep'] : [$('variant').value];
	const m = $('mode').value;
	const mode = m === 'settle' ? { kind: 'settle' } : { kind: 'fixed', iterations: Number(m) };
	const out = [];
	for (const spot of spots) for (const variant of variants) for (const threads of threadList()) {
		out.push({ ...spot, variant, threads, mode, resolve: $('resolve').checked });
	}
	return out;
}

function runOne(c) {
	return new Promise((resolve) => {
		const worker = new Worker('./worker.js', { type: 'module' });
		const t0 = performance.now();
		worker.onmessage = (event) => {
			const message = event.data;
			if (message.kind === 'progress') {
				const p = message.progress;
				$('status').textContent = caseLabel(c) + ': ' + p.phase +
					(p.iterations ? ', ' + p.iterations + ' iterations' : '') + ', ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s';
				return;
			}
			worker.terminate();
			resolve(message);
		};
		worker.onerror = (event) => {
			worker.terminate();
			resolve({ kind: 'error', error: event.message || 'the worker failed to load', environment: null });
		};
		worker.postMessage(c);
	});
}

async function runAll() {
	$('run').disabled = true;
	$('copy').disabled = $('download').disabled = true;
	$('log').textContent = '';
	const report = { tool: 'poker-flopsolve lite browser bench', version: META.version, commit: META.commit, startedAt: new Date().toISOString(), environment: null, cases: [], errors: [] };
	let list;
	try { list = cases(); } catch (error) {
		$('status').textContent = String(error.message || error);
		$('run').disabled = false;
		// Posted all the same, so a headless run ends instead of waiting.
		report.errors.push({ label: 'settings', error: String(error.message || error) });
		fetch('./result', { method: 'POST', body: JSON.stringify(report) }).catch(() => {});
		return;
	}
	for (const c of list) {
		const label = caseLabel(c) + ' asked';
		const message = await runOne(c);
		report.environment = report.environment ?? message.environment;
		if (message.kind === 'done') {
			const r = message.result;
			report.cases.push(r);
			log(caseLabel(r) + ': ' + r.stoppedAt + ' at ' + r.iterations + ' it, ' + (r.ms.total / 1000).toFixed(1) + ' s (' +
				(r.ms.step / r.iterations).toFixed(0) + ' ms/it' + (r.kept.length ? ', ' + r.kept.length + ' lines kept' : '') + ')' +
				(r.resolve ? ', re-solve ' + (r.ms.resolve / 1000).toFixed(1) + ' s' : '') + (r.threads < c.threads ? '  [only ' + r.threads + ' thread(s) granted]' : ''));
		} else {
			report.errors.push({ label, error: message.error });
			log(label + ': ERROR ' + message.error.split('\\n')[0]);
		}
		$('summary').textContent = formatSummary(summarise(report.cases));
	}
	const json = JSON.stringify(report, null, 2);
	$('json').textContent = json;
	$('status').textContent = 'Done: copy the JSON report and paste it back.';
	$('run').disabled = false;
	$('copy').disabled = $('download').disabled = false;
	$('copy').onclick = async () => { try { await navigator.clipboard.writeText(json); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy failed: use Download'; } };
	$('download').onclick = () => {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
		a.download = 'lite-bench-' + report.startedAt.replace(/[:.]/g, '-') + '.json';
		a.click();
	};
	window.__report = report;
	fetch('./result', { method: 'POST', body: json }).catch(() => {});
}

$('run').onclick = runAll;
if (query.get('autorun') === '1') runAll();
</script>
</html>
`;
}
