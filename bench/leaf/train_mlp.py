"""Per-hand MLP leaf model for the turn-leaf experiment (issue #22).

    python3 bench/leaf/train_mlp.py <train.f32,...> [test.f32,...]

Rows come from featurize.ts: 36 features, then EV / pot, weight w * m, spot
id. Every fifth spot is held out, and any test files are scored too. Reports the same errors
as fit.ts, in % of pot, with DeepStack's zero-sum correction applied.
"""
import sys, time
import numpy as np

F = 36
def load(arg):
    return np.concatenate([np.fromfile(f, dtype=np.float32).reshape(-1, F + 3) for f in arg.split(',') if f])

data = load(sys.argv[1])
# Every fifth spot is held out; test files, if given, are scored as well.
hold = (data[:, F + 2].astype(np.int64) % 5) == 0
train, tests = data[~hold], {'held-out': data[hold]}
if len(sys.argv) > 2:
    tests.update({f: load(f) for f in sys.argv[2].split(',')})

def spot_weights(d):
    # Each spot (and each player in it) counts equally.
    ids = d[:, F + 2].astype(np.int64) * 2 + d[:, F - 3].astype(np.int64)
    _, inv = np.unique(ids, return_inverse=True)
    tot = np.bincount(inv, weights=d[:, F + 1])
    return d[:, F + 1] / tot[inv]

X, y, w = train[:, :F], train[:, F], spot_weights(train)
mu, sd = X.mean(0), X.std(0) + 1e-6
rng = np.random.default_rng(0)
import os
H = int(os.environ.get('H', 64))
sizes = [F, H, H, 1]
P = []
for a, b in zip(sizes[:-1], sizes[1:]):
    P += [rng.normal(0, np.sqrt(2 / a), (a, b)).astype(np.float32), np.zeros(b, np.float32)]

def forward(x, P, keep=False):
    acts = [x]
    h = x
    for i in range(0, len(P), 2):
        h = h @ P[i] + P[i + 1]
        if i < len(P) - 2:
            h = np.maximum(h, 0)
        acts.append(h)
    return (h[:, 0], acts) if keep else h[:, 0]

m = [np.zeros_like(p) for p in P]; v = [np.zeros_like(p) for p in P]
Xn = ((X - mu) / sd).astype(np.float32)
wn = (w / w.mean()).astype(np.float32)
epochs, batch, lr, t = int(os.environ.get('EPOCHS', 40)), 2048, 1e-3, 0
start = time.time()
for ep in range(epochs):
    order = rng.permutation(len(Xn))
    for k in range(0, len(order), batch):
        idx = order[k:k + batch]
        out, acts = forward(Xn[idx], P, True)
        g = (2 * wn[idx] * (out - y[idx]) / len(idx))[:, None].astype(np.float32)
        grads = [None] * len(P)
        for i in range(len(P) - 2, -1, -2):
            grads[i] = acts[i // 2].T @ g
            grads[i + 1] = g.sum(0)
            if i > 0:
                g = (g @ P[i].T) * (acts[i // 2] > 0)
        t += 1
        for j in range(len(P)):
            m[j] = 0.9 * m[j] + 0.1 * grads[j]
            v[j] = 0.999 * v[j] + 0.001 * grads[j] ** 2
            P[j] -= lr * (m[j] / (1 - 0.9 ** t)) / (np.sqrt(v[j] / (1 - 0.999 ** t)) + 1e-8)
    if ep == epochs // 2: lr *= 0.3
    if ep == (3 * epochs) // 4: lr *= 0.3
train_s = time.time() - start
params = sum(p.size for p in P)
print(f'MLP {sizes}: {params} parameters ({params / 1024:.1f} KB int8), trained {epochs} epochs on {len(X)} rows in {train_s:.0f} s')

def report(name, d):
    pred = forward(((d[:, :F] - mu) / sd).astype(np.float32), P)
    ids = d[:, F + 2].astype(np.int64)
    player = d[:, F - 3].astype(np.int64)
    rw = d[:, F + 1]
    res = {0: [], 1: []}
    for s in np.unique(ids):
        sel = ids == s
        q = {}
        if not all(np.any(sel & (player == p)) for p in (0, 1)):
            continue
        for p in (0, 1):
            k = sel & (player == p)
            q[p] = (np.sum(rw[k] * pred[k]) / np.sum(rw[k]), np.sum(rw[k] * d[k, F]) / np.sum(rw[k]))
        shift = (q[0][0] + q[1][0]) / 2
        for p in (0, 1):
            k = sel & (player == p)
            err = np.abs(pred[k] - shift - d[k, F])
            res[p].append((100 * np.sum(rw[k] * err) / np.sum(rw[k]), 100 * np.max(err), 100 * abs(q[p][0] - shift - q[p][1])))
    for p in (0, 1):
        a = np.array(res[p])
        print(f'  {name:>40} {"OOP" if p == 0 else "IP "}: mae {a[:, 0].mean():5.2f}  p90 {np.percentile(a[:, 0], 90):5.2f}  max {a[:, 1].mean():6.2f}  range {a[:, 2].mean():5.2f}  (% of pot, {len(a)} spots)')

report('train', train[train[:, F + 2] < 200000])
for name, d in tests.items():
    report(name.split('/')[-1], d)
    if name.endswith('.f32'):
        # Predictions in row order, for aggregate.py to join with the rows.
        np.save(name[:-4] + f'.pred{H}.npy', forward(((d[:, :F] - mu) / sd).astype(np.float32), P))
np.savez('/tmp/claude-0/-home-user-poker-flopsolve/ad79a97b-598e-57c2-8394-3dedc3f57b58/scratchpad/mlp.npz', *P, mu=mu, sd=sd)
