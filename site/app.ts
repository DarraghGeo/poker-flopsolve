/**
 * The benchmark page: ranges, board and spot in, a timed solve out.
 *
 * Purpose: let anyone measure the solver on their own machine without
 * installing anything. The form lives in `Settings` (site/lib/settings.ts),
 * mirrored in the link's hash so a benchmark can be shared; the solving
 * happens in site/worker.ts, a fresh worker per run.
 *
 * The hand grid paints on pointer events: one stroke per drag, the cells in
 * between interpolated so a fast drag skips nothing, each cell restyled as
 * it is crossed and the range text rebuilt once a frame.
 */

import { COMBO_CARDS, formatCard, formatCards, parseCards } from '../src/cards.ts';
import { parseRange } from '../src/range.ts';
import type { Check } from './lib/bench.ts';
import { estimateIterationsTo, formatBytes, formatMs, milestones, progressToward } from './lib/bench.ts';
import {
	cellCombos,
	cellKind,
	cellLabel,
	CELLS,
	cellsFromCombos,
	comboCount,
	GRID_RANKS,
	paintCell,
	rangeOfCombos,
	TOTAL_COMBOS,
} from './lib/hands.ts';
import { RANGE_PRESETS } from './lib/ranges.ts';
import type { Settings, SizeKey } from './lib/settings.ts';
import { LITE_LIMITS } from './lib/lite.ts';
import type { Mode } from './lib/settings.ts';
import { autoMemory, configOf, ITERATION_CAP, MEMORY_CAPS, readSettings, SIZE_PRESETS, TARGETS, writeSettings } from './lib/settings.ts';
import type { Inbound, Outbound, Phase, Report, Setup, SpotSummary } from './protocol.ts';

// ---------------------------------------------------------------- helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const esc = (text: string): string =>
	text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SUITS = 'shdc';
const SUIT_GLYPHS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const cardHtml = (card: number): string => {
	const [rank, suit] = formatCard(card);
	return `<b class="${suit}">${rank}</b><em class="${suit}">${SUIT_GLYPHS[suit]}</em>`;
};

const weightsOf = (range: string): Float64Array => {
	try {
		return parseRange(range);
	} catch {
		return new Float64Array(TOTAL_COMBOS);
	}
};

const parses = (range: string): boolean => {
	try {
		parseRange(range);
		return true;
	} catch {
		return false;
	}
};

const number = (n: number, digits = 0): string =>
	n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

let toastTimer = 0;
function toast(message: string): void {
	let el = document.querySelector<HTMLElement>('.toast');
	if (!el) {
		el = document.createElement('div');
		el.className = 'toast';
		document.body.append(el);
	}
	el.textContent = message;
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => el!.classList.remove('show'), 1800);
}

async function copy(text: string, done: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement('textarea');
		area.value = text;
		document.body.append(area);
		area.select();
		document.execCommand('copy');
		area.remove();
	}
	toast(done);
}

// ---------------------------------------------------------------- state

let settings: Settings = readSettings(location.hash);
let board: number[] = parseCards(settings.board);
let player: 0 | 1 = 0;
let brush = 1;
/** Each player's range per combination, exact, and per grid cell (the mean) for display. */
const weights: [Float64Array, Float64Array] = [weightsOf(settings.oop), weightsOf(settings.ip)];
const grids: [Float64Array, Float64Array] = [cellsFromCombos(weights[0], COMBO_CARDS), cellsFromCombos(weights[1], COMBO_CARDS)];
const cores = Math.max(1, navigator.hardwareConcurrency || 1);
const isolated = window.crossOriginIsolated === true;
const agent = navigator.userAgent;
const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
/** iPads report a Mac; a touch screen gives them away. */
const mobile = /Mobi|Android|iPhone|iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
const autoMb = autoMemory({ deviceMemory, mobile });
const mb = (n: number): string => formatBytes(n * 2 ** 20);
// A shared link may ask for more memory than a phone can give.
if (mobile && settings.memory > autoMb) settings = { ...settings, memory: 0 };
// A shared link may ask for more threads than this machine has.
if (settings.threads > cores) settings = { ...settings, threads: 0 };

const rangeOf = (p: 0 | 1): string => (p === 0 ? settings.oop : settings.ip);

function update(changes: Partial<Settings>): void {
	settings = { ...settings, ...changes };
	if (board.length >= 3) history.replaceState(null, '', `#${writeSettings(settings)}`);
	scheduleEstimate();
}

// ---------------------------------------------------------------- ranges

const gridEl = $('grid');
const cellEls: HTMLElement[] = [];
const rangeInput = $<HTMLInputElement>('range-text');

for (let cell = 0; cell < CELLS; cell++) {
	const el = document.createElement('div');
	el.className = `cell ${cellKind(cell)}`;
	el.textContent = cellLabel(cell);
	el.setAttribute('role', 'gridcell');
	el.title = `${cellLabel(cell)} · ${cellCombos(cell)} combos`;
	gridEl.append(el);
	cellEls.push(el);
}

function renderCell(cell: number): void {
	const w = grids[player][cell];
	const el = cellEls[cell];
	el.style.setProperty('--w', String(w));
	el.classList.toggle('on', w > 0.55);
	el.classList.toggle('part', w > 0 && w <= 0.55);
}

function paintGrid(): void {
	for (let cell = 0; cell < CELLS; cell++) renderCell(cell);
}

function renderCounts(): void {
	for (const p of [0, 1] as const) {
		const combos = comboCount(grids[p]);
		$(`count-${p}`).textContent = `${number(combos)} · ${((combos / TOTAL_COMBOS) * 100).toFixed(1)}%`;
	}
}

function renderTabs(): void {
	for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
		tab.setAttribute('aria-selected', String(Number(tab.dataset.player) === player));
	}
	rangeInput.value = rangeOf(player);
	rangeInput.classList.remove('invalid');
	paintGrid();
}

$('tabs').addEventListener('click', (event) => {
	const tab = (event.target as HTMLElement).closest<HTMLElement>('.tab');
	if (!tab) return;
	flushTyping();
	player = Number(tab.dataset.player) as 0 | 1;
	renderTabs();
});

const brushEl = $('brush');
for (const weight of [1, 0.75, 0.5, 0.25]) {
	const button = document.createElement('button');
	button.setAttribute('role', 'radio');
	button.dataset.weight = String(weight);
	button.innerHTML = `<i style="--w:${weight * 100}%"></i>${weight * 100}%`;
	brushEl.append(button);
}
function renderBrush(): void {
	for (const button of brushEl.querySelectorAll<HTMLElement>('button')) {
		button.setAttribute('aria-checked', String(Number(button.dataset.weight) === brush));
	}
}
brushEl.addEventListener('click', (event) => {
	const button = (event.target as HTMLElement).closest<HTMLElement>('button');
	if (!button) return;
	brush = Number(button.dataset.weight);
	renderBrush();
});

const presetsEl = $('presets');
for (const preset of RANGE_PRESETS) {
	const button = document.createElement('button');
	button.textContent = preset.name;
	button.addEventListener('click', () => setRange(preset.range));
	presetsEl.append(button);
}

function setRange(range: string): void {
	weights[player] = weightsOf(range);
	grids[player] = cellsFromCombos(weights[player], COMBO_CARDS);
	update(player === 0 ? { oop: range } : { ip: range });
	rangeInput.value = range;
	rangeInput.classList.remove('invalid');
	paintGrid();
	renderCounts();
}

$('clear-range').addEventListener('click', () => setRange(''));

let typing = 0;
let pendingTyping: (() => void) | null = null;
rangeInput.addEventListener('input', () => {
	// Bound to the player and text of this keystroke, so a tab switch before it lands cannot misfile it.
	const target = player;
	const text = rangeInput.value.trim();
	clearTimeout(typing);
	pendingTyping = () => {
		pendingTyping = null;
		if (!parses(text)) {
			if (target === player) rangeInput.classList.add('invalid');
			return;
		}
		weights[target] = parseRange(text);
		grids[target] = cellsFromCombos(weights[target], COMBO_CARDS);
		update(target === 0 ? { oop: text } : { ip: text });
		if (target === player) {
			rangeInput.classList.remove('invalid');
			paintGrid();
		}
		renderCounts();
	};
	typing = window.setTimeout(pendingTyping, 220);
});
/** Land a typed range now, before anything reads the ranges. */
function flushTyping(): void {
	if (!pendingTyping) return;
	clearTimeout(typing);
	pendingTyping();
}

// Painting: one value per stroke, cells found by geometry, cells between pointer samples filled in.
let painting = false;
let paintValue = 1;
let lastCell = -1;
let lastPoint = { x: 0, y: 0 };
let gridRect = gridEl.getBoundingClientRect();
let commitFrame = 0;

function cellAt(x: number, y: number): number {
	const col = Math.floor(((x - gridRect.left) / gridRect.width) * 13);
	const row = Math.floor(((y - gridRect.top) / gridRect.height) * 13);
	if (col < 0 || col > 12 || row < 0 || row > 12) return -1;
	return row * 13 + col;
}

function commitPaint(): void {
	commitFrame = 0;
	const range = rangeOfCombos(weights[player], COMBO_CARDS);
	rangeInput.value = range;
	rangeInput.classList.remove('invalid');
	update(player === 0 ? { oop: range } : { ip: range });
	renderCounts();
}

function apply(cell: number): void {
	if (cell < 0 || cell === lastCell) return;
	lastCell = cell;
	if (grids[player][cell] === paintValue) return;
	grids[player][cell] = paintValue;
	paintCell(weights[player], COMBO_CARDS, cell, paintValue);
	renderCell(cell);
	if (!commitFrame) commitFrame = requestAnimationFrame(commitPaint);
}

gridEl.addEventListener('pointerdown', (event) => {
	if (event.button !== 0) return;
	flushTyping();
	gridRect = gridEl.getBoundingClientRect();
	const cell = cellAt(event.clientX, event.clientY);
	if (cell < 0) return;
	event.preventDefault();
	gridEl.setPointerCapture(event.pointerId);
	painting = true;
	gridEl.classList.add('painting');
	paintValue = grids[player][cell] === brush ? 0 : brush;
	lastCell = -1;
	lastPoint = { x: event.clientX, y: event.clientY };
	apply(cell);
});

gridEl.addEventListener('pointermove', (event) => {
	if (!painting) return;
	const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
	for (const e of events.length > 0 ? events : [event]) {
		const dx = e.clientX - lastPoint.x;
		const dy = e.clientY - lastPoint.y;
		const step = gridRect.width / 13 / 3;
		const samples = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
		for (let i = 1; i <= samples; i++) apply(cellAt(lastPoint.x + (dx * i) / samples, lastPoint.y + (dy * i) / samples));
		lastPoint = { x: e.clientX, y: e.clientY };
	}
});

const endPaint = (): void => {
	if (!painting) return;
	painting = false;
	gridEl.classList.remove('painting');
	if (commitFrame) {
		cancelAnimationFrame(commitFrame);
		commitPaint();
	}
};
gridEl.addEventListener('pointerup', endPaint);
gridEl.addEventListener('pointercancel', endPaint);
gridEl.addEventListener('lostpointercapture', endPaint);

// ---------------------------------------------------------------- board

const slotsEl = $('slots');
const deckEl = $('deck');
const deckButtons = new Map<number, HTMLButtonElement>();

for (const suit of SUITS) {
	for (const rank of GRID_RANKS) {
		const card = parseCards(rank + suit)[0];
		const button = document.createElement('button');
		button.className = suit;
		button.innerHTML = `${rank}<span>${SUIT_GLYPHS[suit]}</span>`;
		button.setAttribute('aria-label', rank + suit);
		button.addEventListener('click', () => {
			if (board.length >= 5 || board.includes(card)) return;
			setBoard([...board, card]);
		});
		deckButtons.set(card, button);
		deckEl.append(button);
	}
}

function setBoard(cards: number[]): void {
	board = cards;
	if (board.length >= 3) update({ board: formatCards(board) });
	else scheduleEstimate();
	renderBoard();
}

function renderBoard(): void {
	const groups: [string, number[]][] = [
		['Flop', [0, 1, 2]],
		['Turn', [3]],
		['River', [4]],
	];
	slotsEl.innerHTML = groups
		.map(
			([name, indexes]) =>
				`<div class="slot-group"><span>${name}</span><div>${indexes
					.map((i) => {
						const card = board[i];
						if (card === undefined) return `<button class="slot${i === board.length ? ' next' : ''}" disabled aria-label="empty"></button>`;
						return `<button class="slot filled" data-index="${i}" aria-label="Remove ${formatCard(card)}">${cardHtml(card)}</button>`;
					})
					.join('')}</div></div>`,
		)
		.join('');
	for (const [card, button] of deckButtons) button.disabled = board.includes(card) || board.length >= 5;
}

slotsEl.addEventListener('click', (event) => {
	const slot = (event.target as HTMLElement).closest<HTMLElement>('.slot.filled');
	if (!slot) return;
	const index = Number(slot.dataset.index);
	setBoard(board.filter((_, i) => i !== index));
});

$('random-flop').addEventListener('click', () => {
	const deck = Array.from({ length: 52 }, (_, i) => i);
	const flop: number[] = [];
	while (flop.length < 3) flop.push(deck.splice(Math.floor(Math.random() * deck.length), 1)[0]);
	setBoard(flop.sort((a, b) => b - a));
});
$('clear-board').addEventListener('click', () => setBoard([]));

// ---------------------------------------------------------------- spot form

const potInput = $<HTMLInputElement>('pot');
const stackInput = $<HTMLInputElement>('stack');
const raiseInput = $<HTMLInputElement>('raise');
const allInInput = $<HTMLInputElement>('allin');

function segmented<T>(id: string, options: readonly { value: T; label: string; disabled?: boolean }[], current: () => T, set: (value: T) => void): () => void {
	const el = $(id);
	el.setAttribute('role', 'radiogroup');
	el.innerHTML = '';
	options.forEach((option, i) => {
		const button = document.createElement('button');
		button.setAttribute('role', 'radio');
		button.dataset.index = String(i);
		button.textContent = option.label;
		button.disabled = option.disabled === true;
		button.addEventListener('click', () => {
			set(option.value);
			render();
		});
		el.append(button);
	});
	const render = (): void => {
		el.querySelectorAll<HTMLElement>('button').forEach((button, i) => {
			button.setAttribute('aria-checked', String(options[i].value === current()));
		});
	};
	render();
	return render;
}

segmented<SizeKey>(
	'sizes',
	(Object.keys(SIZE_PRESETS) as SizeKey[]).map((key) => ({ value: key, label: SIZE_PRESETS[key].label })),
	() => settings.sizes,
	(sizes) => update({ sizes }),
);
const MODE_NOTES: Record<Mode, string> = {
	exact: 'Solves the whole game until it is within your target of perfect play.',
	lite: 'Faster on big flops: simplifies the turn and river and stops when the first decisions settle.',
};
const renderMode = (): void => {
	$('mode-note').textContent = MODE_NOTES[settings.mode];
	$('target-field').hidden = settings.mode === 'lite';
};
segmented<Mode>(
	'mode',
	[
		{ value: 'exact', label: 'Exact' },
		{ value: 'lite', label: 'Lite' },
	],
	() => settings.mode,
	(mode) => {
		update({ mode });
		renderMode();
	},
);
renderMode();
segmented<number>(
	'memory',
	MEMORY_CAPS.map((n) => ({ value: n, label: n === 0 ? `Auto (${mb(autoMb)})` : mb(n) })),
	() => settings.memory,
	(memory) => update({ memory }),
);
segmented<number>(
	'target',
	TARGETS.map((t) => ({ value: t, label: `${t}%` })),
	() => settings.target,
	(target) => update({ target }),
);
const threadOptions = [{ value: 0, label: `Max (${isolated ? cores : 1})` }];
for (const n of [1, 2, 4, 8, 16, 32]) if (n <= cores) threadOptions.push({ value: n, label: String(n) });
segmented<number>(
	'threads',
	threadOptions.map((o) => ({ ...o, disabled: !isolated && o.value > 1 })),
	() => settings.threads,
	(threads) => update({ threads }),
);
if (!isolated) {
	const note = $('threads-note');
	note.hidden = false;
	note.textContent = 'This page is not cross-origin isolated here, so the solver runs on one thread. Reloading usually fixes it.';
}

potInput.value = String(settings.pot);
stackInput.value = String(settings.stack);
raiseInput.checked = settings.raise;
allInInput.checked = settings.allIn;

const positive = (input: HTMLInputElement, fallback: number): number => {
	const n = Number(input.value);
	const ok = Number.isFinite(n) && n > 0 && n <= 1e6;
	input.classList.toggle('invalid', !ok);
	return ok ? n : fallback;
};
potInput.addEventListener('input', () => update({ pot: positive(potInput, settings.pot) }));
stackInput.addEventListener('input', () => update({ stack: positive(stackInput, settings.stack) }));
raiseInput.addEventListener('change', () => update({ raise: raiseInput.checked }));
allInInput.addEventListener('change', () => update({ allIn: allInInput.checked }));

// ---------------------------------------------------------------- estimate

const estimateEl = $('estimate');
const runButton = $<HTMLButtonElement>('run');
const workerUrl = new URL('./worker.js', import.meta.url);
let estimator: Worker | null = null;
let estimateId = 0;
let estimateTimer = 0;
let fits = false;
let running = false;

const streets = (rounds: number): string => (rounds === 3 ? 'flop to river' : rounds === 2 ? 'turn and river' : 'river only');

function blocker(): string | null {
	if (board.length < 3) return 'Pick at least three board cards.';
	if (!settings.oop.trim() || comboCount(grids[0]) === 0) return 'The OOP range is empty.';
	if (!settings.ip.trim() || comboCount(grids[1]) === 0) return 'The IP range is empty.';
	return null;
}

function scheduleEstimate(): void {
	clearTimeout(estimateTimer);
	// Any reply in flight now describes other settings.
	estimateId++;
	fits = false;
	renderRunButton();
	const problem = blocker();
	if (problem) {
		estimateEl.className = 'estimate';
		estimateEl.textContent = problem;
		return;
	}
	estimateEl.classList.add('pending');
	estimateTimer = window.setTimeout(() => {
		estimator ??= startEstimator();
		const message: Inbound = { type: 'estimate', id: estimateId, config: configOf(settings, autoMb), mode: settings.mode };
		estimator.postMessage(message);
	}, 180);
}

function startEstimator(): Worker {
	const worker = new Worker(workerUrl, { type: 'module' });
	worker.onmessage = ({ data }: MessageEvent<Outbound>) => {
		if (data.type !== 'estimate' || data.id !== estimateId) return;
		estimateEl.className = 'estimate';
		if (data.ok) {
			fits = true;
			estimateEl.innerHTML =
				describeSpot(data.spot) + (data.lite ? `<ul class="plain">${data.lite.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : '');
		} else {
			estimateEl.classList.add('error');
			estimateEl.innerHTML =
				(data.tooLarge && data.spot
					? `<b>Too big for the ${mb(data.spot.maxBytes / 2 ** 20)} memory limit</b> (needs ${formatBytes(data.spot.compressedBytes)}). ` +
						`Try ${[
							settings.mode === 'exact' ? 'Lite' : '',
							data.spot.maxBytes < 2048 * 2 ** 20 ? 'a higher limit' : '',
							'fewer bet sizes or narrower ranges',
						]
							.filter(Boolean)
							.join(', ')}.`
					: `<b>${esc(data.message)}</b>`);
		}
		renderRunButton();
	};
	worker.onerror = () => {
		estimateEl.className = 'estimate error';
		estimateEl.textContent = 'The solver failed to load in this browser.';
	};
	return worker;
}

function describeSpot(spot: SpotSummary): string {
	const sixteen = spot.precision === 'i16';
	const storage = spot.storageBytes;
	return (
		`<b>${number(spot.combos[0])}</b> vs <b>${number(spot.combos[1])}</b> combos · ` +
		`${streets(spot.rounds)} · ` +
		`<b>${formatBytes(storage)}</b> of memory${sixteen ? ' (compressed to fit)' : ''}`
	);
}

function renderRunButton(): void {
	runButton.disabled = running || !fits || blocker() !== null;
	runButton.textContent = running ? 'Running…' : 'Run benchmark';
}

// ---------------------------------------------------------------- run

const STEPS: { phase: Phase; label: string }[] = [
	{ phase: 'threads', label: 'Threads' },
	{ phase: 'build', label: 'Build tree' },
	{ phase: 'alloc', label: 'Allocate' },
	{ phase: 'solve', label: 'Solve' },
	{ phase: 'finish', label: 'Result' },
];

const runPanel = $('run-panel');
const stepsEl = $('steps');
const progressEl = $('progress');
const progressFill = $('progress-fill');
const liveEl = $('live');
const chartEl = $('chart');
const resultsEl = $('results');
const stopButton = $<HTMLButtonElement>('stop');

let solver: Worker | null = null;
let checks: Check[] = [];
let setup: Setup | null = null;
let live = { iterations: 0, solveMs: 0, measureMs: 0, wallMs: 0 };
let liveFrame = 0;
let phaseStarted = 0;
let currentPhase: Phase | null = null;
const phaseMs = new Map<Phase, number>();
let runSettings: Settings = settings;

function renderSteps(): void {
	const at = currentPhase ? STEPS.findIndex((s) => s.phase === currentPhase) : -1;
	stepsEl.innerHTML = STEPS.map((step, i) => {
		const state = i < at || (currentPhase === null && phaseMs.has(step.phase)) ? 'done' : i === at ? 'active' : '';
		const ms = phaseMs.get(step.phase);
		return `<li class="step ${state}"><span class="dot"></span><span class="label">${step.label}<small>${ms !== undefined ? formatMs(ms) : i === at ? '…' : ''}</small></span></li>`;
	}).join('');
}

function enterPhase(phase: Phase): void {
	const t = performance.now();
	if (currentPhase) phaseMs.set(currentPhase, t - phaseStarted);
	currentPhase = phase;
	phaseStarted = t;
	renderSteps();
}

/** Where the run stops on its measure; the worker sends it once the solve starts (Lite's is the solver's own). */
let runGoal: number | null = null;
/** The furthest the progress bar has been this run: Lite's measure jumps about, the bar should not. */
let bestProgress = 0;
/** What the run's measure is called: exploitability for Exact, change in the first decisions for Lite. */
const measureName = (mode: Mode): string => (mode === 'lite' ? 'Change' : 'Exploitability');

function renderLive(): void {
	liveFrame = 0;
	const last = checks[checks.length - 1];
	const speed = live.solveMs > 0 ? (live.iterations / live.solveMs) * 1000 : 0;
	const goal = runGoal;
	let eta = '—';
	if (last && goal !== null) {
		// Lite's measure jumps about too much to extrapolate.
		const at = runSettings.mode === 'exact' ? estimateIterationsTo(checks, goal) : null;
		if (at !== null && live.iterations > 0) {
			const perIteration = (live.solveMs + live.measureMs) / live.iterations;
			eta = last.exploitability <= goal ? 'done' : `~${formatMs(Math.max(0, at - live.iterations) * perIteration)}`;
		}
		progressEl.classList.remove('waiting');
		bestProgress = Math.max(bestProgress, progressToward(checks[0].exploitability, last.exploitability, goal));
		progressFill.style.width = `${(bestProgress * 100).toFixed(1)}%`;
	}
	const metric = (label: string, value: string): string => `<div class="metric"><span>${label}</span><b>${value}</b></div>`;
	liveEl.innerHTML =
		metric('Iterations', number(live.iterations)) +
		metric('Elapsed', formatMs(live.wallMs)) +
		metric(measureName(runSettings.mode), last ? `${last.exploitability.toFixed(2)}%` : '—') +
		metric('Speed', speed > 0 ? `${speed >= 100 ? number(speed) : speed.toFixed(1)} it/s` : '—') +
		metric('Time left', eta);
}

function startRun(): void {
	flushTyping();
	if (running || !fits || blocker()) return;
	running = true;
	runSettings = settings;
	checks = [];
	setup = null;
	live = { iterations: 0, solveMs: 0, measureMs: 0, wallMs: 0 };
	phaseMs.clear();
	currentPhase = null;
	document.body.classList.add('running');
	renderRunButton();

	runPanel.hidden = false;
	resultsEl.hidden = true;
	stopButton.hidden = false;
	stopButton.disabled = false;
	$('run-title').textContent = 'Solving';
	$('run-sub').textContent =
		`${formatCards(board)} · ${SIZE_PRESETS[settings.sizes].label} · ` +
		(settings.mode === 'lite' ? 'Lite, until the first decisions settle' : `to ${settings.target}% of pot`);
	progressEl.className = 'progress waiting';
	progressFill.style.width = '0';
	renderLive();
	runGoal = settings.mode === 'exact' ? settings.target : null;
	bestProgress = 0;
	renderChart(chartEl, [], runGoal, runSettings.mode);
	enterPhase('threads');
	runPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

	solver = new Worker(workerUrl, { type: 'module' });
	solver.onmessage = ({ data }: MessageEvent<Outbound>) => onSolverMessage(data);
	solver.onerror = (event) => fail(event.message || 'The solver failed to load.');
	const message: Inbound = {
		type: 'solve',
		config: configOf(settings, autoMb),
		mode: settings.mode,
		target: settings.target,
		threads: isolated ? Math.min(settings.threads, cores) : 1,
		cap: ITERATION_CAP,
	};
	solver.postMessage(message);
}

function onSolverMessage(data: Outbound): void {
	switch (data.type) {
		case 'phase':
			if (data.setup) {
				setup = data.setup;
				runGoal = data.goal ?? runGoal;
				$('run-sub').textContent += ` · ${setup.threads} thread${setup.threads === 1 ? '' : 's'} · ${formatBytes(setup.storageBytes)}${setup.precision === 'i16' ? ' (compressed)' : ''}`;
			}
			enterPhase(data.phase);
			return;
		case 'progress':
			live = data;
			if (!liveFrame) liveFrame = requestAnimationFrame(renderLive);
			return;
		case 'check':
			checks.push(data.check);
			renderChart(chartEl, checks, runGoal, runSettings.mode);
			if (!liveFrame) liveFrame = requestAnimationFrame(renderLive);
			return;
		case 'done':
			finish(data.report);
			return;
		case 'error':
			fail(data.message);
			return;
		default:
	}
}

function endRun(): void {
	solver?.terminate();
	solver = null;
	running = false;
	document.body.classList.remove('running');
	stopButton.hidden = true;
	renderRunButton();
}

function finish(report: Report): void {
	endRun();
	phaseMs.set('threads', report.ms.threads);
	phaseMs.set('build', report.ms.build);
	phaseMs.set('alloc', report.ms.alloc);
	phaseMs.set('solve', report.ms.solve + report.ms.measure);
	phaseMs.set('finish', report.ms.finish);
	currentPhase = null;
	renderSteps();
	live = { iterations: report.iterations, solveMs: report.ms.solve, measureMs: report.ms.measure, wallMs: report.ms.total };
	renderLive();
	progressEl.className = 'progress complete';
	const reached = report.stoppedBy === 'target' || report.stoppedBy === 'settled';
	if (reached) progressFill.style.width = '100%';
	$('run-title').textContent = report.stoppedBy === 'target'
		? `Reached ${report.target}% in ${formatMs(report.ms.total)}`
		: report.stoppedBy === 'settled'
			? `Settled in ${formatMs(report.ms.total)}`
			: report.stoppedBy === 'stopped'
			? `Stopped after ${formatMs(report.ms.total)}`
			: `Hit the ${number(report.iterations)}-iteration cap`;
	renderResults(report);
}

function fail(message: string): void {
	endRun();
	currentPhase = null;
	renderSteps();
	progressEl.className = 'progress';
	$('run-title').textContent = 'The solve failed';
	resultsEl.hidden = false;
	resultsEl.innerHTML = `<div class="error-box"><b>Something went wrong.</b> ${esc(message)}</div>`;
}

runButton.addEventListener('click', startRun);
stopButton.addEventListener('click', () => {
	if (!solver) return;
	stopButton.disabled = true;
	const message: Inbound = { type: 'stop' };
	solver.postMessage(message);
});

// ---------------------------------------------------------------- chart

function niceTicks(min: number, max: number, count: number): number[] {
	const span = max - min;
	if (!(span > 0)) return [min];
	const raw = span / count;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
	const ticks: number[] = [];
	for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(Math.round(t / step) * step);
	return ticks;
}

function renderChart(el: HTMLElement, data: readonly Check[], goal: number | null, mode: Mode): void {
	// Until Lite's worker says where it settles, scale as if at 1% and draw no line.
	const target = goal ?? 1;
	const W = 760;
	const H = 220;
	const pad = { left: 44, right: 14, top: 12, bottom: 26 };
	const iw = W - pad.left - pad.right;
	const ih = H - pad.top - pad.bottom;
	// A measure of exactly 0 (a spot nobody can exploit) has no logarithm.
	const floor = target / 100;
	data = data.map((c) => ({ ...c, exploitability: Math.max(floor, c.exploitability) }));
	const seconds = data.map((c) => c.ms / 1000);
	const maxX = Math.max(seconds[seconds.length - 1] ?? 0, 0.001) * 1.04;
	const top = Math.max(target * 10, ...data.map((c) => c.exploitability));
	const bottom = Math.min(target / 1.6, ...data.map((c) => c.exploitability));
	const ly0 = Math.log10(bottom);
	const ly1 = Math.log10(top) + 0.05;
	const x = (s: number): number => pad.left + (s / maxX) * iw;
	const y = (e: number): number => pad.top + ih - ((Math.log10(e) - ly0) / (ly1 - ly0)) * ih;

	const yTicks: number[] = [];
	for (let d = Math.floor(ly0); d <= Math.ceil(ly1); d++) {
		for (const m of [1, 2, 5]) {
			const v = m * 10 ** d;
			if (Math.log10(v) >= ly0 && Math.log10(v) <= ly1) yTicks.push(v);
		}
	}
	const label = (v: number): string => (v >= 1 ? `${number(v)}%` : `${v}%`);
	const grid = yTicks
		.map((v) => `<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(v)}" y2="${y(v)}" stroke="#f1f1f4"/><text x="${pad.left - 8}" y="${y(v) + 3.5}" text-anchor="end">${label(v)}</text>`)
		.join('');
	const ticks = niceTicks(0, maxX, 6);
	const tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
	let decimals = 0;
	while (decimals < 3 && Math.abs(tickStep * 10 ** decimals - Math.round(tickStep * 10 ** decimals)) > 1e-6) decimals++;
	const xTicks = ticks
		.map((s) => `<text x="${x(s)}" y="${H - 6}" text-anchor="middle">${number(s, s === 0 ? 0 : decimals)}s</text>`)
		.join('');
	const targetLine = goal === null ? '' :
		`<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(target)}" y2="${y(target)}" stroke="#4f46e5" stroke-dasharray="4 4" stroke-opacity="0.55"/>` +
		`<text x="${W - pad.right}" y="${y(target) - 6}" text-anchor="end" style="fill:#4f46e5">${mode === 'lite' ? 'settled' : 'target'} ${target}%</text>`;

	let series = '';
	if (data.length > 0) {
		const points = data.map((c, i) => `${x(seconds[i]).toFixed(1)},${y(c.exploitability).toFixed(1)}`);
		const line = `M${points.join('L')}`;
		const area = `${line}L${x(seconds[seconds.length - 1]).toFixed(1)},${pad.top + ih}L${x(seconds[0]).toFixed(1)},${pad.top + ih}Z`;
		const last = data[data.length - 1];
		series =
			`<path d="${area}" fill="url(#fade)"/>` +
			`<path d="${line}" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
			`<circle cx="${x(seconds[seconds.length - 1])}" cy="${y(last.exploitability)}" r="4" fill="#fff" stroke="#4f46e5" stroke-width="2"/>`;
	} else {
		series = `<text x="${pad.left + iw / 2}" y="${pad.top + ih / 2}" text-anchor="middle">${mode === 'lite' ? 'The first decisions are read every 20 iterations' : 'Exploitability appears after the first iteration'}</text>`;
	}
	el.innerHTML =
		`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${measureName(mode)} over solving time">` +
		`<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f46e5" stop-opacity="0.16"/><stop offset="1" stop-color="#4f46e5" stop-opacity="0"/></linearGradient></defs>` +
		`${grid}${targetLine}${series}${xTicks}</svg>`;
}

// ---------------------------------------------------------------- results

const BET_COLOURS = ['#fbbf24', '#f97316', '#ef4444', '#be123c', '#9f1239'];

function actionColours(actions: readonly string[]): string[] {
	let bets = 0;
	return actions.map((action) => {
		if (action.startsWith('fold')) return '#60a5fa';
		if (action.startsWith('check') || action.startsWith('call')) return '#34d399';
		if (action.startsWith('allin')) return '#7f1d1d';
		return BET_COLOURS[Math.min(bets++, BET_COLOURS.length - 1)];
	});
}

function actionName(action: string, pot: number): string {
	const [kind, amount] = action.split(' ');
	const name = kind === 'allin' ? 'All-in' : kind[0].toUpperCase() + kind.slice(1);
	if (amount === undefined) return name;
	const chips = Number(amount);
	return `${name} ${number(chips, chips % 1 ? 1 : 0)}bb${kind === 'bet' && pot > 0 ? ` (${Math.round((chips / pot) * 100)}%)` : ''}`;
}

function browserName(agent: string): string {
	const match =
		/Edg\/(\d+)/.exec(agent) ? `Edge ${/Edg\/(\d+)/.exec(agent)![1]}`
		: /OPR\/(\d+)/.exec(agent) ? `Opera ${/OPR\/(\d+)/.exec(agent)![1]}`
		: /Firefox\/(\d+)/.exec(agent) ? `Firefox ${/Firefox\/(\d+)/.exec(agent)![1]}`
		: /Chrome\/(\d+)/.exec(agent) ? `Chrome ${/Chrome\/(\d+)/.exec(agent)![1]}`
		: /Version\/([\d.]+).*Safari/.exec(agent) ? `Safari ${/Version\/([\d.]+)/.exec(agent)![1]}`
		: 'Unknown browser';
	const os = /Mac OS X/.test(agent) && !/Mobile/.test(agent) ? 'macOS'
		: /iPhone|iPad/.test(agent) ? 'iOS'
		: /Android/.test(agent) ? 'Android'
		: /Windows/.test(agent) ? 'Windows'
		: /Linux/.test(agent) ? 'Linux'
		: '';
	return os ? `${match} · ${os}` : match;
}

function kv(rows: [string, string][]): string {
	return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderResults(report: Report): void {
	const r = report;
	const perSecond = r.ms.solve > 0 ? (r.iterations / r.ms.solve) * 1000 : 0;
	const perIteration = r.iterations > 0 ? r.ms.solve / r.iterations : 0;
	const lite = r.mode === 'lite';
	const reached = r.stoppedBy === 'target';
	const e = r.exploitability;

	const tile = (label: string, value: string, note: string, lead = false): string =>
		`<div class="tile${lead ? ' lead' : ''}"><span>${label}</span><b>${value}</b><small>${note}</small></div>`;
	const headline =
		`<div class="headline">` +
		tile(reached ? `Time to ${r.target}% of pot` : r.stoppedBy === 'settled' ? 'Time to settle' : 'Total time', formatMs(r.ms.total), 'wall clock, setup included', true) +
		tile('Iterations per second', perSecond >= 100 ? number(perSecond) : perSecond.toFixed(1), `${number(r.iterations)} iterations`) +
		tile('Time per iteration', formatMs(perIteration), `${r.setup.threads} thread${r.setup.threads === 1 ? '' : 's'} · ${r.setup.engine === 'wasm' ? 'WebAssembly' : 'JavaScript'}`) +
		(lite
			? tile('Accuracy', 'Not measured', 'Lite cannot measure it')
			: tile('Exploitability', e === null ? '—' : `${e.toFixed(2)}%`, `of the pot · target ${r.target}%`)) +
		`</div>`;

	const levels = [10, 5, 2, 1, 0.5, 0.3].filter((level) => level >= r.target);
	const convergence = lite
		? `<section class="card"><div class="card-head"><h2>Settling</h2><span class="muted">${number(r.checks.length)} readings</span></div>` +
			`<div class="chart" id="result-chart"></div>` +
			`<p class="muted" style="margin:12px 0 0;font-size:14px">How much the first decisions changed between readings. Lite stops once that stays under ${r.target}% twice in a row.</p></section>`
		:
		`<section class="card"><div class="card-head"><h2>Convergence</h2><span class="muted">${number(r.checks.length)} measures</span></div>` +
		`<div class="chart" id="result-chart"></div>` +
		`<table><thead><tr><th>Exploitability</th><th>Iterations</th><th>Solving time</th></tr></thead><tbody>` +
		milestones(r.checks, levels)
			.map((m) =>
				m.iterations === null
					? `<tr><td>${m.level}%</td><td class="dim">—</td><td class="dim">not reached</td></tr>`
					: `<tr><td>${m.level}%</td><td>${number(m.iterations)}</td><td>${formatMs(m.ms!)}</td></tr>`,
			)
			.join('') +
		`</tbody></table></section>`;

	const parts: [string, number, string][] = [
		['Start threads', r.ms.threads, '#c7d2fe'],
		['Build tree', r.ms.build, '#a5b4fc'],
		['Allocate', r.ms.alloc, '#818cf8'],
		['Iterations', r.ms.solve, '#4f46e5'],
		[lite ? 'Settle checks' : 'Exploitability checks', r.ms.measure, '#312e81'],
		['Read result', r.ms.finish, '#e5e7eb'],
	];
	const accounted = parts.reduce((sum, [, ms]) => sum + ms, 0) || 1;
	const time =
		`<section class="card"><div class="card-head"><h2>Where the time went</h2><span class="muted">${formatMs(r.ms.total)}</span></div>` +
		`<div class="stack">${parts.map(([name, ms, colour]) => `<i title="${name}" style="width:${(ms / accounted) * 100}%;background:${colour}"></i>`).join('')}</div>` +
		`<ul class="legend">${parts
			.map(([name, ms, colour]) => `<li><span class="swatch" style="background:${colour}"></span>${name}<b>${formatMs(ms)}</b><em>${((ms / accounted) * 100).toFixed(0)}%</em></li>`)
			.join('')}</ul></section>`;

	const spot = r.setup.spot;
	const cards = parseCards(r.config.board);
	const spotCard =
		`<section class="card"><div class="card-head"><h2>Spot</h2></div>` +
		kv([
			['Board', cards.map((c) => `<span class="${formatCard(c)[1]}">${formatCard(c)[0]}${SUIT_GLYPHS[formatCard(c)[1]]}</span>`).join(' ')],
			['Streets', streets(spot.rounds)],
			['Pot · stack', `${r.config.pot}bb · ${r.config.stack}bb`],
			['Betting', `${SIZE_PRESETS[runSettings.sizes].label}${runSettings.raise ? ', one raise' : ''}${runSettings.allIn ? ', all-in' : ''}`],
			['Combos', `${number(spot.combos[0])} OOP · ${number(spot.combos[1])} IP`],
			['Decision nodes', number(spot.decisionNodes)],
			['Runouts stored', number(spot.runouts)],
			['Solver', lite ? 'Lite (simplified)' : 'Exact'],
			['Memory', `${formatBytes(r.setup.storageBytes)}${r.setup.precision === 'i16' ? ', compressed' : ''} of ${formatBytes(r.setup.spot.maxBytes)} allowed`],
		]) +
		`</section>`;

	const env = r.environment;
	const machine =
		`<section class="card"><div class="card-head"><h2>Machine</h2></div>` +
		kv([
			['Browser', esc(browserName(env.userAgent))],
			['Logical cores', String(env.cores)],
			['Threads used', `${r.setup.threads}${r.setup.threadsAsked > 0 ? ` of ${r.setup.threadsAsked} asked` : ''}`],
			['Engine', r.setup.engine === 'wasm' ? 'WebAssembly' : 'JavaScript'],
			['SIMD', env.simd ? 'Yes' : 'No'],
			['Cross-origin isolated', env.crossOriginIsolated ? 'Yes' : `No${env.threadsUnavailable ? ` <span class="muted">(${esc(env.threadsUnavailable)})</span>` : ''}`],
			['Device memory', env.deviceMemory ? `${env.deviceMemory} GB or more` : 'Not reported'],
		]) +
		`</section>`;

	const root = r.root;
	const colours = actionColours(root.actions);
	const who = root.player === 0 ? 'OOP' : 'IP';
	const mini = root.cells
		.map((mix, cell) => {
			if (!mix) return `<div class="empty">${cellLabel(cell)}</div>`;
			let at = 0;
			const stops = mix
				.map((p, a) => {
					const from = at;
					at += p * 100;
					return `${colours[a]} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
				})
				.join(',');
			return `<div style="background:linear-gradient(90deg,${stops})" title="${cellLabel(cell)}: ${mix.map((p, a) => `${actionName(root.actions[a], r.config.pot)} ${(p * 100).toFixed(0)}%`).join(', ')}">${cellLabel(cell)}</div>`;
		})
		.join('');
	const solution =
		`<section class="card"><div class="card-head"><h2>Solution</h2><span class="muted">${who} first to act</span></div>` +
		`<div class="ev">${(['OOP', 'IP'] as const)
			.map((name, p) => `<div class="ev-row"><span>${name}</span><div class="ev-bar"><i style="width:${r.ev[p].toFixed(1)}%"></i></div><b>${r.ev[p].toFixed(1)}%</b></div>`)
			.join('')}</div>` +
		`<div class="stack">${root.frequencies.map((p, a) => `<i style="width:${p * 100}%;background:${colours[a]}"></i>`).join('')}</div>` +
		`<ul class="legend">${root.actions
			.map((action, a) => `<li><span class="swatch" style="background:${colours[a]}"></span>${esc(actionName(action, r.config.pot))}<b>${(root.frequencies[a] * 100).toFixed(1)}%</b></li>`)
			.join('')}</ul>` +
		`<div class="mini-grid">${mini}</div>` +
		`</section>`;

	const liteCard = lite
		? `<section class="card"><div class="card-head"><h2>What Lite simplified</h2></div>` +
			`<ul class="list">${(r.lite ?? []).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` +
			`<p class="subhead">Limitations</p>` +
			`<ul class="list warn">${LITE_LIMITS.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></section>`
		: '';

	resultsEl.innerHTML =
		headline +
		`<div class="result-grid">${liteCard}${convergence}${time}${spotCard}${machine}${solution}` +
		`<section class="card"><div class="card-head"><h2>Share</h2></div>` +
		`<p class="muted" style="margin:0 0 14px;font-size:14px">The report holds every number above, the settings and the full trace.</p>` +
		`<div class="actions"><button class="secondary" id="copy-report">Copy report (JSON)</button><button class="secondary" id="copy-link">Copy link to this spot</button><button class="secondary" id="run-again">Run again</button></div>` +
		`</section></div>`;
	resultsEl.hidden = false;
	renderChart($('result-chart'), r.checks, r.target, r.mode);
	$('copy-report').addEventListener('click', () => void copy(JSON.stringify(report, null, 2), 'Report copied'));
	$('copy-link').addEventListener('click', () => void copy(`${location.origin}${location.pathname}#${writeSettings(runSettings)}`, 'Link copied'));
	$('run-again').addEventListener('click', startRun);
}

// ---------------------------------------------------------------- start

// A link pasted into an open tab changes only the hash; load it as a fresh page.
window.addEventListener('hashchange', () => location.reload());

renderBrush();
renderTabs();
renderCounts();
renderBoard();
scheduleEstimate();
