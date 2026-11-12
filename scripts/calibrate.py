import sys, json
import numpy as np
from PIL import Image

path = sys.argv[1]
im = np.asarray(Image.open(path).convert("RGB")).astype(np.int32)
H, W, _ = im.shape
print("size", W, H)
g = im.sum(axis=2) / 3.0
chroma = im.max(axis=2) - im.min(axis=2)

# find data area: header rows are mostly pure black
rowmean = g.mean(axis=1)
top = 0
for y in range(0, 400):
    if rowmean[y] < 12:
        top = y
print("header ends ~", top)
y0, y1 = top + 8, H - 60
x0, x1 = 5, W - 5

sub = g[y0:y1]
# vertical lines: thin bright vs neighbours 3 px away
d = np.minimum(sub[:, 3:-3] - sub[:, :-6], sub[:, 3:-3] - sub[:, 6:])
col = np.clip(d, 0, None).mean(axis=0)
colx = np.arange(3, W - 3)
# horizontal
subh = g[y0:y1, :]
dh = np.minimum(subh[3:-3] - subh[:-6], subh[3:-3] - subh[6:])
row = np.clip(dh, 0, None).mean(axis=1)
rowy = np.arange(y0 + 3, y1 - 3)

def peaks(score, coords, n, mindist=150):
    s = score.copy()
    out = []
    for _ in range(n):
        i = int(np.argmax(s))
        out.append((int(coords[i]), float(s[i])))
        lo, hi = max(0, i - mindist), min(len(s), i + mindist)
        s[lo:hi] = 0
    return sorted(out)

pc = peaks(col, colx, 7)
pr = peaks(row, rowy, 7)
print("col peaks", pc)
print("row peaks", pr)
json.dump({"cols": pc, "rows": pr, "top": top}, open(path + ".peaks.json", "w"))
