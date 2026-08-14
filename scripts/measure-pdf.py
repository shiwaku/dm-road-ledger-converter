#!/usr/bin/env python3
"""同梱のPDF図面を実測して、ビューワのスタイルの根拠になる数値を出す。

道路台帳図の分類コードは自治体・測量ベンダーによって運用が異なり、全国共通の
図式として確定していない。そのため線の太さ・破線・記号の大きさ・注記の字高は
図式の書物ではなく、同梱のPDF図面（`data/.../PDF_57-08/DM-_57-08.pdf`、A0のベクタ
PDF、1:500）そのものを基準にしている。ここで出す数値が viewer/src/layers.ts の
LINE_STYLES・ICON_SCALE・ANNOTATION_M の根拠。

やっていること
  1. 図枠のグリッドラベル（`-48,800` など）から PDF pt → 平面直角座標のアフィン
     変換を作る（実測 5.6687 pt/m）
  2. PDFの描画パスを平面座標に載せ、変換結果の線・面に投影して被覆区間を取る。
     図面は dash 属性を使わず短い実線の連なりで破線を描くので、破線パターンは
     こうして測るしかない
  3. 記号・方向の位置の周りから、線に沿わないパスだけを集めて図上の大きさを測り、
     dm-sprite のインク寸法（アルファ>8 の外接矩形）と比べる
  4. 注記の位置に最も近い文字スパンのフォントサイズを字高として拾う

使い方（リポジトリ直下で。`output/` に変換結果が要る）

    node src/index.js --input "data/図郭57-08(市役所付近)DMデータ"
    python3 scripts/measure-pdf.py            # 全部
    python3 scripts/measure-pdf.py lines      # 線だけ

必要なもの: pymupdf, pyproj, shapely, numpy, pillow
"""
from __future__ import annotations

import collections
import csv
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

import fitz
import numpy as np
from PIL import Image
from pyproj import Transformer
from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / 'data/図郭57-08(市役所付近)DMデータ/PDF_57-08/DM-_57-08.pdf'
OUT = ROOT / 'output'
SPRITE = 'https://shiwaku.github.io/dm-sprite/'
EPSG = 'EPSG:6674'

# z19 で地上1メートルに相当する画面ピクセル数（layers.ts の PX_PER_M_Z19 と同じ）
PX_PER_M_Z19 = 8.157

TR = Transformer.from_crs('EPSG:4326', EPSG, always_xy=True)


# ---- PDF を平面直角座標に載せる ----

def affine(page: fitz.Page) -> tuple[float, float, float, float]:
    """図枠のグリッドラベルから PDF pt → (easting, northing) の一次式を作る。"""
    xs, es, ys, ns = [], [], [], []
    for w in page.get_text('words'):
        if not re.fullmatch(r'-?[0-9,]{5,9}', w[4]):
            continue
        v = int(w[4].replace(',', ''))
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        if -49000 < v < -48000:      # 東西方向のラベル = easting
            xs.append(cx)
            es.append(v)
        elif -136000 < v < -135000:  # 南北方向のラベル = northing
            ys.append(cy)
            ns.append(v)
    if len(xs) < 2 or len(ys) < 2:
        sys.exit('図枠のグリッドラベルを読めませんでした。PDFが想定と違います。')
    a_e, b_e = np.polyfit(xs, es, 1)
    a_n, b_n = np.polyfit(ys, ns, 1)
    return float(a_e), float(b_e), float(a_n), float(b_n)


def to_plane(aff, pts) -> np.ndarray:
    a_e, b_e, a_n, b_n = aff
    p = np.asarray(pts, dtype=float)
    return np.column_stack([p[:, 0] * a_e + b_e, p[:, 1] * a_n + b_n])


def path_points(item) -> list[tuple[float, float]]:
    """描画パスの1項目から、平面に載せる点を取り出す。"""
    pts = []
    for q in item[1:]:
        if hasattr(q, 'x'):
            pts.append((q.x, q.y))
        elif hasattr(q, 'ul'):
            pts += [(q.ul.x, q.ul.y), (q.lr.x, q.lr.y)]
        elif hasattr(q, 'x0'):
            pts += [(q.x0, q.y0), (q.x1, q.y1)]
    return pts


def stroke_segments(page: fitz.Page, aff) -> list[tuple]:
    """描画パスを (始点, 終点, 線幅pt) の線分に展開する。"""
    raw = []
    for d in page.get_drawings():
        if d['type'] not in ('s', 'fs'):
            continue
        w = d.get('width') or 0
        for it in d['items']:
            k = it[0]
            if k == 'l':
                segs = [(it[1], it[2])]
            elif k == 'c':
                # ベジエは端点を結ぶ直線で近似する（図面の曲線は十分短い）
                segs = [(it[1], it[4])]
            elif k == 're':
                r = it[1]
                c = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)]
                segs = list(zip(c[:-1], c[1:]))
            elif k == 'qu':
                q = it[1]
                c = [q.ul, q.ur, q.lr, q.ll, q.ul]
                segs = list(zip(c[:-1], c[1:]))
            else:
                continue
            for a, b in segs:
                pa = (a.x, a.y) if hasattr(a, 'x') else tuple(a)
                pb = (b.x, b.y) if hasattr(b, 'x') else tuple(b)
                raw.append((pa, pb, w))
    p0 = to_plane(aff, [r[0] for r in raw])
    p1 = to_plane(aff, [r[1] for r in raw])
    out = []
    for i, r in enumerate(raw):
        if float(np.hypot(*(p1[i] - p0[i]))) > 1e-6:
            out.append((tuple(p0[i]), tuple(p1[i]), r[2]))
    return out


# ---- 変換結果 ----

def rings(geom) -> list:
    t, c = geom['type'], geom['coordinates']
    if t == 'LineString':
        return [c]
    if t in ('MultiLineString', 'Polygon'):
        return list(c)
    if t == 'MultiPolygon':
        return [r for poly in c for r in poly]
    return []


def load(kind: str) -> list:
    path = OUT / f'道路台帳図_{kind}.geojson'
    if not path.exists():
        sys.exit(f'{path} がありません。先に node src/index.js で変換してください。')
    return json.load(open(path, encoding='utf-8'))['features']


# ---- 1. 線の太さと破線 ----

def measure_lines(page, aff) -> None:
    segs = stroke_segments(page, aff)
    geoms = [LineString([s[0], s[1]]) for s in segs]
    tree = STRtree(geoms)
    widths = [s[2] for s in segs]

    TOL = 0.20  # 線の直交方向の許容(m)
    runs = collections.defaultdict(
        lambda: {'on': [], 'off': [], 'w': collections.Counter(), 'n': 0})

    for kind in ('線', '面'):
        for f in load(kind):
            code = str(f['properties'].get('Code', ''))
            runs[code]['n'] += 1
            for ring in rings(f['geometry']):
                if len(ring) < 2:
                    continue
                line = LineString([TR.transform(x, y) for x, y in ring])
                if line.length < 2:
                    continue
                iv = []
                for i in tree.query(line.buffer(TOL)):
                    a, b = Point(geoms[i].coords[0]), Point(geoms[i].coords[1])
                    if line.distance(a) > TOL or line.distance(b) > TOL:
                        continue
                    ta, tb = line.project(a), line.project(b)
                    if abs(tb - ta) < 0.05:
                        continue
                    # 投影長が実長とずれるものは、たまたま近くを通る別方向の線
                    if abs(abs(tb - ta) - geoms[i].length) > 0.15 * geoms[i].length + 0.05:
                        continue
                    iv.append((min(ta, tb), max(ta, tb)))
                    runs[code]['w'][round(widths[i], 2)] += 1
                if not iv:
                    runs[code]['off'].append(line.length)
                    continue
                iv.sort()
                merged = [list(iv[0])]
                for s, e in iv[1:]:
                    if s <= merged[-1][1] + 0.02:
                        merged[-1][1] = max(merged[-1][1], e)
                    else:
                        merged.append([s, e])
                prev = 0.0
                for s, e in merged:
                    if s - prev > 0.02:
                        runs[code]['off'].append(s - prev)
                    runs[code]['on'].append(e - s)
                    prev = e
                if line.length - prev > 0.02:
                    runs[code]['off'].append(line.length - prev)

    print('■ 線・面 — 分類コードごとの線幅と実線／空白の長さ')
    print('  空白の中央値が 0.2m 以下なら頂点のつなぎ目なので実線とみなす。')
    print(f"  {'code':5} {'件数':>5} {'延長m':>7} {'実線率':>6} {'線幅pt':>7} "
          f"{'実線m':>7} {'空白m':>7}")
    rows = []
    for code, r in runs.items():
        tot = sum(r['on']) + sum(r['off'])
        if tot < 1:
            continue
        w = r['w'].most_common(1)[0][0] if r['w'] else float('nan')
        on = np.median(r['on']) if r['on'] else float('nan')
        off = np.median(r['off']) if r['off'] else 0.0
        rows.append((code, r['n'], tot, sum(r['on']) / tot, w, on, off))
    for code, n, tot, cov, w, on, off in sorted(rows, key=lambda x: -x[2]):
        mark = '破線' if off > 0.2 else ''
        print(f'  {code:5} {n:5d} {tot:7.0f} {cov:6.2f} {w:7.2f} '
              f'{on:7.2f} {off:7.2f}  {mark}')
    print()


# ---- 2. 記号の大きさ ----

def sprite_ink() -> dict[str, int]:
    """dm-sprite の各アイコンの、実際に描かれている範囲の最大辺（px）。"""
    idx = json.loads(urllib.request.urlopen(SPRITE + 'sprite.json').read())
    sheet = np.array(Image.open(
        io.BytesIO(urllib.request.urlopen(SPRITE + 'sprite.png').read())).convert('RGBA'))
    ink = {}
    for k, v in idx.items():
        if not k.startswith('dm-'):
            continue
        a = sheet[v['y']:v['y'] + v['height'], v['x']:v['x'] + v['width'], 3] > 8
        ys, xs = np.nonzero(a)
        if len(xs):
            ink[k[3:]] = int(max(xs.max() - xs.min(), ys.max() - ys.min()) + 1)
    return ink


def measure_symbols(page, aff) -> None:
    # DMの線・面。記号のインクと線のインクを分けるために使う
    dm = []
    for kind in ('線', '面'):
        for f in load(kind):
            for ring in rings(f['geometry']):
                if len(ring) >= 2:
                    dm.append(LineString([TR.transform(x, y) for x, y in ring]))
    dmtree = STRtree(dm)

    TOL = 0.35
    sym = []
    for d in page.get_drawings():
        r = d['rect']
        p = to_plane(aff, [(r.x0, r.y0), (r.x1, r.y1)])
        x0, x1 = sorted([p[0][0], p[1][0]])
        y0, y1 = sorted([p[0][1], p[1][1]])
        if max(x1 - x0, y1 - y0) > 3.0:   # 線や建物の輪郭は除く
            continue
        pts = [q for it in d['items'] for q in path_points(it)]
        if not pts:
            continue
        pl = to_plane(aff, pts)
        on = sum(
            1 for q in pl
            if any(dm[i].distance(Point(q)) < TOL for i in dmtree.query(Point(q).buffer(TOL)))
        )
        if on / len(pl) >= 0.6:           # ほぼ線に沿うパスは記号ではない
            continue
        sym.append((x0, y0, x1, y1))
    tree = STRtree([box(*b) for b in sym])

    R = 1.3   # 記号の中心から集める範囲(m)
    out = collections.defaultdict(list)
    for kind in ('記号', '方向'):
        for f in load(kind):
            code = str(f['properties'].get('Code', ''))
            x, y = TR.transform(*f['geometry']['coordinates'][:2])
            bbs = [sym[i] for i in tree.query(box(x - R, y - R, x + R, y + R))
                   if abs((sym[i][0] + sym[i][2]) / 2 - x) < R
                   and abs((sym[i][1] + sym[i][3]) / 2 - y) < R]
            if bbs:
                a = np.array(bbs)
                out[(kind, code)].append(
                    max(a[:, 2].max() - a[:, 0].min(), a[:, 3].max() - a[:, 1].min()))
            else:
                out[(kind, code)].append(None)

    ink = sprite_ink()
    print('■ 記号・方向 — 図面での大きさと、スプライトを倍率1.0で描いたときの大きさ')
    print(f'  スプライト {len(ink)} コード。「倍率」が図面に対する大きさの比。')
    print(f"  {'種':2} {'code':5} {'件数':>5} {'検出':>5} {'図面m':>6} "
          f"{'ink px':>6} {'倍率1.0のm':>9} {'倍率':>5}")
    rows, ratios = [], []
    for (kind, code), v in out.items():
        ok = [x for x in v if x]
        if not ok or code not in ink:
            continue
        med = float(np.median(ok))
        cur = ink[code] / PX_PER_M_Z19
        rows.append((kind, code, len(v), len(ok), med, ink[code], cur, cur / med))
        ratios += [cur / med] * len(v)
    for r in sorted(rows, key=lambda x: -x[2]):
        print(f'  {r[0]:2} {r[1]:5} {r[2]:5d} {r[3]:5d} {r[4]:6.2f} '
              f'{r[5]:6d} {r[6]:9.2f} {r[7]:5.1f}')
    if ratios:
        uniq = [r[7] for r in rows]
        print(f'\n  倍率の中央値 コード単位 {np.median(uniq):.2f} / '
              f'件数で重み付け {np.median(ratios):.2f}')
        print(f'  → ICON_SCALE の目安 {1 / np.median(uniq):.2f}〜{1 / np.median(ratios):.2f}')
    print()


# ---- 3. 注記の字高 ----

def measure_text(page, aff) -> None:
    spans = []
    for b in page.get_text('dict')['blocks']:
        for line in b.get('lines', []):
            for s in line['spans']:
                x = (s['bbox'][0] + s['bbox'][2]) / 2
                y = (s['bbox'][1] + s['bbox'][3]) / 2
                p = to_plane(aff, [(x, y)])[0]
                spans.append((p[0], p[1], s['size'], s['text']))

    pt_per_m = 1 / abs(aff[0])
    out = collections.defaultdict(list)
    for f in load('注記'):
        code = str(f['properties'].get('Code', ''))
        txt = (f['properties'].get('Text') or '').replace('\n', '')
        x, y = TR.transform(*f['geometry']['coordinates'][:2])
        best, bd = None, 8.0
        for sx, sy, sz, st in spans:
            d = float(np.hypot(sx - x, sy - y))
            if d < bd and st.strip() and (st.strip() in txt or txt[:2] == st.strip()[:2]):
                best, bd = (sz, st), d
        if best is None:
            for sx, sy, sz, st in spans:
                d = float(np.hypot(sx - x, sy - y))
                if d < bd:
                    best, bd = (sz, st), d
        if best:
            out[code].append(best)

    print('■ 注記 — 分類コードごとの字高')
    print(f"  {'code':5} {'件数':>5} {'字高pt':>7} {'地上m':>6}  例")
    for code in sorted(out):
        v = out[code]
        sz = float(np.median([a[0] for a in v]))
        ex = ', '.join(sorted({a[1][:6] for a in v})[:3])
        print(f'  {code:5} {len(v):5d} {sz:7.2f} {sz / pt_per_m:6.2f}  {ex}')
    print()


def main() -> None:
    if not PDF.exists():
        sys.exit(f'{PDF} がありません。豊中市サンプルを data/ に展開してください。')
    want = set(sys.argv[1:]) or {'lines', 'symbols', 'text'}
    page = fitz.open(PDF)[0]
    aff = affine(page)
    print(f'PDF図面 {PDF.name}  縮尺 {1 / abs(aff[0]):.4f} pt/m（1:500 なら 5.6687）\n')
    if 'lines' in want:
        measure_lines(page, aff)
    if 'symbols' in want:
        measure_symbols(page, aff)
    if 'text' in want:
        measure_text(page, aff)


if __name__ == '__main__':
    main()
