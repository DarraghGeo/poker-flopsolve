/** The target spot T shared by the tree-size issues (#20, #47–#56). */
import type { SpotConfig } from '../../src/index.ts';

export const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
export const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';

export const targetSpot = (board: string): SpotConfig => ({
	board,
	pot: 55,
	stack: 975,
	oop: OOP,
	ip: IP,
	betSizes: [[0.33, 0.75, 1.5]],
	raiseSizes: [[0.75]],
	allowAllIn: true,
	maxRaises: 3,
});
