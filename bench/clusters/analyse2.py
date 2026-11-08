import json, collections
S='bench/clusters/out/'
# browser/node factors measured (ms/iter)
B={'flop':(410.7,316.4,195.5,200.4,798.8),'monotone':(124.2,119.9,178.7,157.8,289.6),'wide':(3507.9,1353.6,793.7,692.7,3842.6),
   'flop-pb':(236.8,191.9,287.4,114.5,613.2),'monotone-pb':(107.0,70.8,99.0,105.6,187.6)}
rows=[json.loads(l) for l in open(S+'sweep.jsonl')]
by=collections.OrderedDict()
for r in rows:
    if r.get('kind')=='speed': continue
    by.setdefault((r['spot'],r['config']),[]).append(r)
def btime(r, ported):
    bx,nx,bc,nc,bj=B[r['spot']]
    if r['engine']!='js': return r['solveSec']*bx/nx
    f=bc/nc
    if ported: f*= (B['flop'][0]/B['flop'][4])  # wasm/js in the browser, flop spot
    return r['setup']+r['solveSec']*f
for budget in (15,):
  for ported in (False,True):
    print(f"\n### browser {budget}s, clusters {'ported to wasm (est.)' if ported else 'JS as built'}")
    spot=None
    for (s,c),rs in by.items():
        if s!=spot: spot=s; print(f"-- {s}")
        if ported and rs[0]['engine']!='js': continue
        ok=[r for r in rs if btime(r,ported)<=budget]
        if not ok: print(f"   {c:9} — (first checkpoint {btime(rs[0],ported):.1f}s)"); continue
        r=ok[-1]
        print(f"   {c:9} it {r['iterations']:3}  true {r['trueExpl']:6.2f}%  MAE {r['mae'][0]:.2f}/{r['mae'][1]:.2f}  max {r['max'][0]:.1f}/{r['max'][1]:.1f}  range {r['range'][0]:.2f}/{r['range'][1]:.2f}  runouts {r['runouts']}")
