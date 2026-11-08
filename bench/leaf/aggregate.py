"""Leaf errors carried to the flop: does averaging over turn cards cancel them?

    python3 bench/leaf/aggregate.py <leaves.jsonl> <leaves.predH.npy>

For each turn leaf (a flop line ending in a turn deal) and each combo, the
value the flop sees is the average of its turn-card values weighted by the
opposing mass it meets on each card. This compares that average, predicted
and true, holding the reference flop strategy fixed, and reports the error in
% of the flop pot (100), weighted like the per-combo errors elsewhere.
Rainbow flops only: on them every turn card is stored, so no relabelling.
"""
import json, sys
from collections import defaultdict
import numpy as np

lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
pred = np.load(sys.argv[2])
at = 0
acc = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])  # (node, player, combo) -> sum m*true, sum m*pred, sum m, w
leaf_err = defaultdict(lambda: [0.0, 0.0])
for line in lines:
    node = line['label'].rsplit(' b', 1)[0]
    pot = line['pot']
    rows = line['rows']
    p = pred[at:at + len(rows)] * pot
    at += len(rows)
    # The same zero-sum shift the other reports apply.
    q = {}
    for pl in (0, 1):
        idx = [i for i, r in enumerate(rows) if r['player'] == pl]
        wm = np.array([rows[i]['w'] * rows[i]['m'] for i in idx])
        q[pl] = np.sum(wm * p[idx]) / np.sum(wm)
    shift = (q[0] + q[1]) / 2
    for i, r in enumerate(rows):
        a = acc[(node, r['player'], r['combo'])]
        a[0] += r['m'] * r['ev']; a[1] += r['m'] * (p[i] - shift); a[2] += r['m']; a[3] = r['w']
        e = leaf_err[(node, r['player'])]
        e[0] += r['w'] * r['m'] * abs(p[i] - shift - r['ev']); e[1] += r['w'] * r['m']
assert at == len(pred)
out = defaultdict(lambda: [0.0, 0.0, 0.0])
for (node, pl, combo), (t, q_, m, w) in acc.items():
    o = out[(node, pl)]
    o[0] += w * m * abs(q_ - t) / m; o[1] += w * m
    o[2] = max(o[2], abs(q_ - t) / m if w >= 0.01 else 0)
for (node, pl), (err, wm, mx) in sorted(out.items()):
    le = leaf_err[(node, pl)]
    print(f'{node:>40} {"OOP" if pl == 0 else "IP "}: per-card leaf mae {le[0] / le[1]:5.2f}  averaged over turn cards {err / wm:5.2f}  max {mx:5.2f}  (chips; flop pot 100)')
