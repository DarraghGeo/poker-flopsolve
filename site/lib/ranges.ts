/**
 * Starting ranges for the benchmark page: 100bb six-max cash, approximate.
 *
 * Purpose: one-click ranges that look like real spots, so a benchmark
 * measures the kind of tree people solve. Not solver output; adjust freely.
 */

/** A named range. */
export interface RangePreset {
	readonly name: string;
	readonly range: string;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
	{ name: 'UTG open', range: '77+,A2s+,K9s+,QTs+,JTs,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo' },
	{ name: 'CO open', range: '22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,86s+,75s+,65s,54s,A8o+,KTo+,QTo+,JTo' },
	{
		name: 'BTN open',
		range: '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T8o+,98o',
	},
	{
		name: 'BB defend',
		range: '22-99,A2s-AJs,K2s-KJs,Q4s-QJs,J6s+,T6s+,96s+,85s+,75s+,64s+,53s+,43s,A8o-AJo,K9o-KJo,Q9o+,J9o+,T8o+,98o,87o',
	},
	{ name: '3-bet', range: '99+,AJs+,KQs,A5s-A4s,76s,65s,AQo+' },
	{ name: 'Tight', range: '88+,ATs+,KJs+,QJs,AJo+,KQo' },
	{ name: 'Any two', range: '22+,A2s+,K2s+,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,A2o+,K2o+,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o' },
];
