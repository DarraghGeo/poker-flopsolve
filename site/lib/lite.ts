/**
 * Lite mode in plain words, for the benchmark page.
 *
 * Purpose: `solveLite`'s own notes are written for developers; the page
 * shows what Lite changed, and what that costs, to anyone.
 */

import { parseCards } from '../../src/cards.ts';
import type { PresetChanges, SpotConfig } from '../../src/index.ts';

/** What Lite gives up, the same for every spot. */
export const LITE_LIMITS: readonly string[] = [
	'The first decisions come out close to exact; later streets are only a rough guide until the walk-through re-solves them.',
	'It has no accuracy figure of its own. Where the Exact game fits beside it, the Accuracy box can solve Exact and measure Lite\'s play there.',
	'Its times are not comparable with Exact, which solves the whole game.',
];

const capital = (text: string): string => text[0].toUpperCase() + text.slice(1);

/** What Lite simplified in this spot, one sentence each. */
export function liteSummary(config: SpotConfig, changes: PresetChanges): string[] {
	const cards = parseCards(config.board).length;
	const stop = 'It stops when the first decisions stop changing, not at an accuracy target.';
	if (cards === 5) return ['River only: Lite changes almost nothing here, so Exact is the better test.', stop];

	const lines: string[] = [];
	if (changes.roundsSimplified.length > 0) {
		// Lite keeps the size nearest three quarters of the pot.
		const sizes = ((config.betSizes as readonly (readonly (number | string)[])[])[0] ?? []).filter((s): s is number => typeof s === 'number');
		const kept = sizes.reduce((best, s) => (Math.abs(s - 0.75) < Math.abs(best - 0.75) ? s : best), sizes[0] ?? 0.75);
		const streets = changes.roundsSimplified.map((street, i) => (i === 0 ? capital(street) : street)).join(' and ');
		lines.push(`${streets}: one bet size (${Math.round(kept * 100)}% pot), no raises.`);
		const deal = cards === 3 ? 'a turn or river' : 'a river';
		lines.push(`Deal ${deal} card in the walk-through and that street is re-solved at your bet sizes, raise sizes and raises.`);
	} else {
		lines.push('Your bet sizes are kept as they are.');
	}
	const later = cards === 3 ? 'turn and river' : 'river';
	lines.push(`Similar ${later} cards are solved together.`);
	lines.push(`Only a sample of the ${later} cards is dealt on each pass.`);
	lines.push(stop);
	return lines;
}
