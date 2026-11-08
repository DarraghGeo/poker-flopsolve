import json, sys, collections
rows=[json.loads(l) for l in open(sys.argv[1])]
budgets=[float(x) for x in (sys.argv[2] if len(sys.argv)>2 else '5,10,15').split(',')]
by=collections.OrderedDict()
for r in rows:
    if r.get('kind')=='speed': continue
    by.setdefault((r['spot'],r['config']),[]).append(r)
def at(rs,t):
    # last checkpoint within budget t (a time-capped solve stops there)
    ok=[r for r in rs if r['wasmSec']<=t]
    return ok[-1] if ok else None
spot=None
for (s,c),rs in by.items():
    if s!=spot:
        spot=s; print(f"\n## {s}  (cols per budget: true expl % | MAE oop/ip % pot | max oop/ip | range-EV err oop/ip)")
    floor=rs[-1]
    cells=[]
    for t in budgets:
        r=at(rs,t)
        cells.append('—' if r is None else f"{r['trueExpl']:.2f} | {r['mae'][0]:.2f}/{r['mae'][1]:.2f} | {r['max'][0]:.1f}/{r['max'][1]:.1f} | {r['range'][0]:.2f}/{r['range'][1]:.2f} ({r['iterations']}it)")
    print(f"{c:8} runouts {rs[0]['runouts']:5} turns {rs[0]['turns']:3} | " + ' || '.join(cells) + f" || floor {floor['trueExpl']:.2f} mae {floor['mae'][0]:.2f}/{floor['mae'][1]:.2f}")
