"""Builds lib/server/digit-templates.json — the ten digit shapes used to read the scan time
printed in the header of IMD's images (see lib/server/header-time.ts).

IMD renders the header in DejaVu Sans Bold (matplotlib's default font), so the templates are
rendered from the copy of that font bundled with matplotlib. Only needed if IMD changes the font.

    python scripts/make-digit-templates.py [optional-frame.jpg to test against]
"""
import json
import os
import sys

import matplotlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont

GW, GH = 10, 14  # template grid
font_path = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf", "DejaVuSans-Bold.ttf")
font = ImageFont.truetype(font_path, 34)


def grid(mask):
    """Area-average a boolean glyph mask (already cropped to its bounding box) onto GW×GH."""
    h, w = mask.shape
    out = np.zeros((GH, GW))
    for j in range(GH):
        for i in range(GW):
            acc = 0
            for sj in range(4):
                for si in range(4):
                    y = min(h - 1, int((j + (sj + 0.5) / 4) / GH * h))
                    x = min(w - 1, int((i + (si + 0.5) / 4) / GW * w))
                    acc += mask[y, x]
            out[j, i] = acc / 16
    return out


def bbox(mask):
    ys, xs = np.where(mask)
    return mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


templates = {}
for d in "0123456789":
    im = Image.new("L", (60, 60), 0)
    ImageDraw.Draw(im).text((10, 5), d, fill=255, font=font)
    m = bbox(np.asarray(im) > 110)
    templates[d] = {"aspect": round(m.shape[1] / m.shape[0], 3), "grid": [round(float(v), 2) for v in grid(m).ravel()]}

out = os.path.join(os.path.dirname(__file__), "..", "lib", "server", "digit-templates.json")
json.dump({"w": GW, "h": GH, "digits": templates}, open(out, "w"))
print("wrote", os.path.normpath(out))


def classify(m):
    g = grid(m).ravel()
    asp = m.shape[1] / m.shape[0]
    best = None
    for d, t in templates.items():
        score = float(np.abs(g - np.array(t["grid"])).mean()) + 0.6 * abs(asp - t["aspect"])
        if best is None or score < best[1]:
            second = best
            best = (d, score)
    return best


if len(sys.argv) > 1:
    a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int)
    line = a[45:105, 200:, :].max(2) > 110
    # keep only the rows of the middle text line (largest run of rows with ink)
    has = line.sum(1) > 0
    runs_y, st = [], None
    for y, v in enumerate(list(has) + [False]):
        if v and st is None:
            st = y
        if not v and st is not None:
            runs_y.append((st, y))
            st = None
    y0, y1 = max(runs_y, key=lambda r: r[1] - r[0])
    line = line[y0:y1]
    cols = line.sum(0)
    runs, st = [], None
    for x, v in enumerate(cols):
        if v and st is None:
            st = x
        if not v and st is not None:
            runs.append((st, x - 1))
            st = None
    text = ""
    for x0, x1 in runs:
        d, score = classify(bbox(line[:, x0 : x1 + 1]))
        text += d if score < 0.25 else "?"
    print(len(runs), "glyphs:", text)
