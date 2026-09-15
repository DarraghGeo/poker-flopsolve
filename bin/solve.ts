/**
 * Command-line solver.
 *
 * Purpose: run a spot end to end without writing code.
 *
 *   npm run solve -- --board "AsKh7d" --pot 60 --stack 120 \
 *     --oop "AA,KK,AQs" --ip "TT,99,AJs" --bet 0.66 --iters 500
 */

import { defineSpot, formatCombo, solve } from '../src/index.ts';
import type { BetSize } from '../src/index.ts';

interface Args {
	readonly [key: string]: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		args[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
	}
	return args;
}

/** A bet size is a pot fraction, `4c` for absolute chips, or `allin`. */
function parseSizes(text: string): BetSize[] {
	return text.split(',').map((token) => {
		const t = token.trim();
		if (t === 'allin') return 'allin';
		if (/^[\d.]+c$/i.test(t)) return { chips: Number(t.slice(0, -1)) };
		return Number(t);
	});
}

const args = parseArgs(process.argv.slice(2));

if (!args.board || args.help) {
	console.log(`
  Postflop Texas Hold'em solver

    --board   3, 4 or 5 cards, e.g. "AsKh7d" or "As Kh 7d 2c"
    --pot     dead money in the middle, in chips
    --stack   effective stack behind, per player
    --oop     out-of-position range, e.g. "AA,KK,AQs+,76s:0.5"
    --ip      in-position range
    --bet     bet sizes, comma separated: pot fractions, "4c", or "allin"
    --raises  maximum aggressive actions per round (default 1)
    --iters   CFR+ iteration cap (default 500)
    --target  stop at this accuracy, as a % of pot, e.g. 0.5
    --workers worker threads, or 1 for single-threaded (default: auto)
    --allin   also offer a shove at every decision
    --max-combos  refuse a range wider than this
    --node    show the strategy at this node index (default: every node)
`);
	process.exit(args.board ? 0 : 1);
}

const spot = defineSpot({
	board: args.board,
	pot: Number(args.pot ?? 100),
	stack: Number(args.stack ?? 100),
	oop: args.oop ?? 'random',
	ip: args.ip ?? 'random',
	betSizes: [parseSizes(args.bet ?? '0.66')],
	maxRaises: Number(args.raises ?? 1),
	allowAllIn: args.allin === 'true',
	maxCombos: args['max-combos'] ? Number(args['max-combos']) : undefined,
});

const { estimate } = spot;
const mb = (estimate.bytes / 1048576).toFixed(1);
console.log(
	`\n  board ${args.board}   pot ${args.pot ?? 100}   stack ${args.stack ?? 100}\n` +
		`  ${estimate.rounds} betting round(s), ${estimate.runouts.toLocaleString()} runout(s)\n` +
		`  ranges: ${estimate.combos[0]} vs ${estimate.combos[1]} combos\n` +
		`  ${estimate.decisionNodes} decision nodes, ${estimate.totalSlots.toLocaleString()} slots, ${mb} MB\n`,
);

const iterations = Number(args.iters ?? 500);
const workers = args.workers === undefined ? 'auto' : Number(args.workers);
const target = args.target === undefined ? 0 : Number(args.target);
const started = Date.now();
const solution = solve(spot, {
	iterations,
	workers,
	targetPercent: target,
	// With a target the solver schedules its own checks by predicting when the
	// target will be met, which is cheaper than any cadence we could pick here.
	exploitEvery: target > 0 ? undefined : Math.max(1, Math.round(iterations / 5)),
	onProgress: ({ iteration, exploitability }) => {
		// Carriage returns only make sense on a terminal; piped, they turn the
		// progress line into one long smear.
		const percent = ((100 * exploitability) / Number(args.pot ?? 100)).toFixed(3);
		const goal = target > 0 ? ` (target ${target}%)` : '';
		const line = `  solving  ${iteration}/${iterations}  exploitability ${percent}% of pot${goal}`;
		if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
	},
});
if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(72) + '\r');

// A target that was not met leaves a looser answer than was asked for; saying
// so is the whole value of tracking it.
const outcome =
	target > 0 && solution.stoppedAt === 'iterations'
		? `  stopped at the ${iterations}-iteration cap WITHOUT reaching ${target}% of pot;` +
			' raise --iters to go further\n'
		: '';

console.log(
	`  solved in ${((Date.now() - started) / 1000).toFixed(1)}s` +
		` (${solution.iterations} iterations, ` +
		`${solution.workers === 1 ? 'single-threaded' : `${solution.workers} workers`})\n` +
		outcome +
		`  EV out of position ${solution.ev(0).toFixed(3)} chips   ` +
		`exploitability ${solution.exploitabilityPercent().toFixed(3)}% of pot\n`,
);

const wanted = args.node !== undefined ? [Number(args.node)] : Array.from(spot.tree.decisionNodes);
for (const node of wanted) {
	const view = solution.strategyAt(node, 0);
	console.log(`  [${node}] P${view.player}  "${solution.path(node)}"   ${view.actions.join('  |  ')}`);
	// Widest first: the hands actually driving the strategy.
	const rows = [];
	for (let i = 0; i < view.combos.length; i++) {
		rows.push({
			label: formatCombo(view.combos[i]),
			probs: Array.from(view.probs.subarray(i * view.actions.length, (i + 1) * view.actions.length)),
		});
	}
	for (const row of rows.slice(0, 12)) {
		console.log(`       ${row.label.padEnd(7)} ${row.probs.map((p) => p.toFixed(3)).join('   ')}`);
	}
	if (rows.length > 12) console.log(`       … ${rows.length - 12} more`);
	console.log();
}
