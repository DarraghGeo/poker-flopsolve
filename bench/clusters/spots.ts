import type { SpotConfig } from '../../src/index.ts';
import { SPOTS as COMPARE } from '../compare/spots.ts';
const OOP = 'AA-22,AKs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,AKo-ATo,KQo-KJo';
const IP = 'TT-22,AQs-A2s,KQs-K9s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,AQo-ATo,KQo';
const PB_OOP = 'AA-22,AKs-ATs,KQs-KTs,QJs,AKo-AJo';
const PB_IP = 'KK-22,AQs-ATs,KJs+,QJs,AQo-AJo';
export const SPOTS: Record<string, SpotConfig> = {
  flop: COMPARE.flop,
  monotone: COMPARE.monotone,
  wide: { board: 'Qs 7h 2d', pot: 100, stack: 200, oop: OOP, ip: IP, betSizes: [[0.33, 0.75]], maxRaises: 1 },
  'flop-pb': { ...COMPARE.flop, oop: PB_OOP, ip: PB_IP },
  'monotone-pb': { ...COMPARE.monotone, oop: PB_OOP, ip: PB_IP },
};
