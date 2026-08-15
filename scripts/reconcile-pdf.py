#!/usr/bin/env python3
"""同梱のPDF図面と変換結果を全数で突き合わせ、どちらか片方にしか無いものを出す。

`measure-pdf.py` が「描き方（線幅・破線・大きさ・字高）」を測るのに対して、
こちらは**地物の有無**を照合する。図面に描いてあるのに変換結果に無いもの、
変換結果にあるのに図面に描かれていないものを、両方向で数える。

やっていること
  1. 図枠のグリッドラベルから PDF pt → 平面直角座標のアフィン変換を作り、
     図郭（-48,800〜-48,400 / -135,300〜-135,000。400×300m）で切る
  2. PDFの描画パスを線分に展開し、変換結果の線・面・記号・方向の近くに
     あるかを見る。どれの近くでもない線分を「図面にしか無いインク」として
     5mのセルにまとめる
  3. 逆に、変換結果の線・面を図面のインクに投影して被覆率を出し、
     記号・方向はその位置の近くにインクがあるかを見る
  4. PDFのテキストと注記（E7）を突き合わせる。図面にしか無い文字は
     標高値かどうかで分ける（標高値は**DMに値が入っていない**ので出ないのが正しい）

前提として、図面のほうが情報が多い。図面にしか無いものが出ること自体は
不具合ではない。**数と内訳が説明できるか**を見るためのスクリプト。

使い方（リポジトリ直下で。`output/` に変換結果が要る）

    node src/index.js --input "data/図郭57-08(市役所付近)DMデータ"
    python3 scripts/reconcile-pdf.py
    python3 scripts/reconcile-pdf.py --crops      # 説明できないインクの上位を切り出す

必要なもの: pymupdf, pyproj, shapely, numpy
"""
from __future__ import annotations

import collections
import re
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import fitz
import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
# 実測スクリプトとアフィン変換・パス展開・読み込みを共用する。
# 同じPDFを別の読み方で2度実装すると、片方だけずれても気づけない。
MP = SourceFileLoader('measure_pdf', str(ROOT / 'scripts/measure-pdf.py')).load_module()

TR = Transformer.from_crs('EPSG:4326', 'EPSG:6674', always_xy=True)

# 図郭（図枠のグリッドラベルから）。ここから外は図枠・凡例・余白なので照合しない。
SHEET = box(-48800.0, -135300.0, -48400.0, -135000.0)

# 図面のインクと変換結果を「同じもの」とみなす距離(m)。
# 地図情報レベル500の許容誤差は 500×図上0.1mm = 0.05m だが、PDFは描画の都合で
# 記号の中心と代表点がずれるため、線は0.6m・記号は1.6mと広めに取る。
TOL_LINE = 0.6
TOL_SYMBOL = 1.6
# 線・面の被覆率がこれ未満なら「図面に描かれていない」とみなす。
COVER_MIN = 0.2
# 注記と文字を結びつける距離(m)。縦書きの長い注記は代表点から10m以上離れた
# ところまで字が続くので広く取り、代わりに「注記に含まれる字か」で絞る。
TOL_TEXT = 15.0

# 図面には目に見えない線が混ざる。1:500 では 0.1pt ＝ 0.018mm で紙に出ない。
HAIRLINE_PT = 0.1
# 図郭の枠線。3.0pt で図郭の縁をなぞる1本だけ。
FRAME_PT = 2.0


def sheet_clip(p0, p1):
    """線分を図郭で切る。またぐものは中点で判定して落とさない。"""
    mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    return SHEET.covers(Point(mid))


def sample(p0, p1, step=0.5):
    """線分上の点を step メートル間隔で取る（端点は必ず含む）。"""
    n = max(2, int(np.hypot(p1[0] - p0[0], p1[1] - p0[1]) / step) + 1)
    t = np.linspace(0, 1, n)
    return np.column_stack([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t])


def load_converted():
    """変換結果を平面直角座標で読む。"""
    lines, points, texts = [], [], []
    for kind in ('線', '面'):
        for f in MP.load(kind):
            code = str(f['properties'].get('Code', ''))
            for ring in MP.rings(f['geometry']):
                if len(ring) >= 2:
                    lines.append((code, LineString([TR.transform(x, y) for x, y in ring])))
    for kind in ('記号', '方向'):
        for f in MP.load(kind):
            code = str(f['properties'].get('Code', ''))
            points.append((kind, code, Point(TR.transform(*f['geometry']['coordinates'][:2]))))
    for f in MP.load('注記'):
        p = f['properties']
        texts.append((str(p.get('Code', '')), str(p.get('Text', '')),
                      Point(TR.transform(*f['geometry']['coordinates'][:2]))))
    return lines, points, texts


def filled_shapes(page, aff):
    """塗りつぶしの図形を外接矩形で返す。

    記号には塗りで描かれるものがある（`get_drawings` の type が 'f'）。
    線分だけを見ていると、そこに図形があるのに「インクが無い」と数えてしまう。
    """
    out = []
    for d in page.get_drawings():
        if d['type'] != 'f':
            continue
        r = d['rect']
        p = MP.to_plane(aff, [(r.x0, r.y0), (r.x1, r.y1)])
        x0, x1 = sorted([p[0][0], p[1][0]])
        y0, y1 = sorted([p[0][1], p[1][1]])
        if max(x1 - x0, y1 - y0) < 5.0:   # 大きな塗りは地物ではなく下地
            out.append(box(x0, y0, x1, y1))
    return out


def pdf_spans(page, aff):
    """PDFの文字スパンを (文字列, 平面座標の中心, フォントサイズ) で返す。"""
    out = []
    for b in page.get_text('dict')['blocks']:
        if b['type'] != 0:
            continue
        for line in b['lines']:
            for s in line['spans']:
                t = s['text'].strip()
                if not t:
                    continue
                x = (s['bbox'][0] + s['bbox'][2]) / 2
                y = (s['bbox'][1] + s['bbox'][3]) / 2
                e, n = MP.to_plane(aff, [(x, y)])[0]
                out.append((t, Point(e, n), s['size']))
    return out


def main() -> None:
    page = fitz.open(MP.PDF)[0]
    aff = MP.affine(page)
    print(f'PDF図面 {MP.PDF.name}  縮尺 {1 / abs(aff[0]):.4f} pt/m')
    print(f'図郭 {SHEET.bounds[0]:.0f}〜{SHEET.bounds[2]:.0f} / '
          f'{SHEET.bounds[1]:.0f}〜{SHEET.bounds[3]:.0f}（400×300m）\n')

    lines, points, texts = load_converted()
    line_tree = STRtree([g for _, g in lines])
    sym_tree = STRtree([g for _, _, g in points])
    outside = sum(1 for _, _, g in points if not SHEET.covers(g))

    # ---- 1. 図面 → 変換結果 ----
    segs = [s for s in MP.stroke_segments(page, aff) if sheet_clip(s[0], s[1])]
    seg_geoms = [LineString([s[0], s[1]]) for s in segs]
    seg_tree = STRtree(seg_geoms)

    explained = collections.Counter()
    unknown, unknown_len = [], 0.0
    for s, g in zip(segs, seg_geoms):
        pts = sample(s[0], s[1])
        on_line = on_sym = 0
        for q in pts:
            p = Point(q)
            if any(lines[i][1].distance(p) < TOL_LINE
                   for i in line_tree.query(p.buffer(TOL_LINE))):
                on_line += 1
            elif any(points[i][2].distance(p) < TOL_SYMBOL
                     for i in sym_tree.query(p.buffer(TOL_SYMBOL))):
                on_sym += 1
        hit = (on_line + on_sym) / len(pts)
        if hit >= 0.7:
            explained['線・面' if on_line >= on_sym else '記号・方向'] += 1
        else:
            unknown.append((s, g))
            unknown_len += g.length

    total_len = sum(g.length for g in seg_geoms)
    print(f'■ 図面 → 変換結果  描画パス {len(segs)}本 / 総延長 {total_len:,.0f}m')
    for k, v in explained.most_common():
        print(f'   {k} で説明できる  {v:6d}本')
    print(f'   説明できない        {len(unknown):6d}本 / {unknown_len:,.0f}m')

    # 説明できないものを線幅で分ける。**延長の比率で語らないこと。**
    # 紙に出ないヘアラインが図郭を貫いて何本も走っており、延長で見ると
    # それだけで2割近くを占めて、実際の食い違いが埋もれる。
    groups = collections.defaultdict(lambda: [0, 0.0])
    for s, g in unknown:
        if s[2] < HAIRLINE_PT:
            k = f'紙に出ないヘアライン（{s[2]:.2f}pt）'
        elif s[2] >= FRAME_PT:
            k = f'図郭の枠線（{s[2]:.2f}pt）'
        else:
            k = f'実際に描かれている線（{s[2]:.2f}pt）'
        groups[k][0] += 1
        groups[k][1] += g.length
    for k, (cnt, ln) in sorted(groups.items(), key=lambda kv: -kv[1][1]):
        print(f'     {k:32} {cnt:4d}本 {ln:8.1f}m')

    # 紙に出るものだけを場所でまとめる
    real = [(s, g) for s, g in unknown if HAIRLINE_PT <= s[2] < FRAME_PT]
    cells = collections.defaultdict(lambda: [0, 0.0])
    for _, g in real:
        c = g.centroid
        cells[(int(c.x // 20) * 20, int(c.y // 20) * 20)][0] += 1
        cells[(int(c.x // 20) * 20, int(c.y // 20) * 20)][1] += g.length
    top = sorted(cells.items(), key=lambda kv: -kv[1][1])[:8]
    if top:
        print('\n   紙に出るのに説明できない線が集まっている場所（20mのセル）')
        for (e, n), (cnt, ln) in top:
            print(f'     E{e} N{n}  {cnt:4d}本 {ln:7.1f}m')

    # ---- 2. 変換結果 → 図面 ----
    print('\n■ 変換結果 → 図面')
    nodraw = collections.Counter()
    ncode = collections.Counter()
    for code, g in lines:
        pts = sample(g.coords[0], g.coords[-1]) if len(g.coords) == 2 else \
            np.array([g.interpolate(d).coords[0]
                      for d in np.arange(0, g.length + 0.01, 0.5)] or [g.coords[0]])
        on = sum(1 for q in pts
                 if any(seg_geoms[i].distance(Point(q)) < TOL_LINE
                        for i in seg_tree.query(Point(q).buffer(TOL_LINE))))
        ncode[code] += 1
        if on / max(len(pts), 1) < COVER_MIN:
            nodraw[code] += 1
    print(f'   線・面 {len(lines)}本のうち、図面にインクが無いもの: {sum(nodraw.values())}本')
    for code, c in nodraw.most_common(10):
        print(f'     {code}  {c:4d} / {ncode[code]}本')

    spans = [(t, p, sz) for t, p, sz in pdf_spans(page, aff) if SHEET.covers(p)]
    span_tree = STRtree([p for _, p, _ in spans])

    fills = filled_shapes(page, aff)
    fill_tree = STRtree(fills)
    sym_nodraw = collections.Counter()
    sym_total = collections.Counter()
    for kind, code, g in points:
        if not SHEET.covers(g):
            continue
        sym_total[(kind, code)] += 1
        near_path = any(seg_geoms[i].distance(g) < TOL_SYMBOL
                        for i in seg_tree.query(g.buffer(TOL_SYMBOL)))
        near_fill = any(fills[i].distance(g) < TOL_SYMBOL
                        for i in fill_tree.query(g.buffer(TOL_SYMBOL)))
        near_text = any(spans[i][1].distance(g) < TOL_SYMBOL
                        for i in span_tree.query(g.buffer(TOL_SYMBOL)))
        if not (near_path or near_fill or near_text):
            sym_nodraw[(kind, code)] += 1
    n_sym = sum(sym_total.values())
    print(f'\n   記号・方向 {n_sym}件のうち、位置の近く（{TOL_SYMBOL}m）に'
          f'インクも文字も無いもの: {sum(sym_nodraw.values())}件')
    for (kind, code), c in sym_nodraw.most_common(10):
        print(f'     {kind} {code}  {c:4d} / {sym_total[(kind, code)]}件')
    if outside:
        print(f'   （記号・方向のうち図郭の外にあるもの {outside}件は照合から除いた）')

    # ---- 3. 注記とテキスト ----
    #
    # 図面は1つの注記を1文字ずつのスパンに割ることがあり、縦書き（Vnflag=1）だと
    # 代表点から10m以上離れたところまで字が続く。距離だけで結ぶと取り違えるので、
    # 「その注記に含まれる字だけでできたスパンか」で絞ってから距離で拾う。
    print('\n■ 注記とPDFのテキスト')
    used = set()
    matched = 0
    for code, text, g in texts:
        if not SHEET.covers(g):
            continue
        chars = set(text.replace('\n', ''))
        found = [i for i in span_tree.query(g.buffer(TOL_TEXT))
                 if spans[i][1].distance(g) < TOL_TEXT and set(spans[i][0]) <= chars]
        if found:
            matched += 1
            used.update(found)
    in_sheet = sum(1 for _, _, g in texts if SHEET.covers(g))
    print(f'   注記 {len(texts)}件（図郭内 {in_sheet}件）のうち、'
          f'図面に対応する文字があるもの: {matched}件')

    # 標高値はDMに値が無く注記でもない。記号・方向の Elev に紐づくので分けて数える
    elev_pts = [g for kind, code, g in points if SHEET.covers(g)]
    elev_tree = STRtree(elev_pts)
    rest = [(i, spans[i]) for i in range(len(spans)) if i not in used]
    num = [(i, s) for i, s in rest if re.fullmatch(r'-?\d{1,3}(\.\d+)?', s[0])]
    on_sym = [(i, s) for i, s in num
              if any(elev_pts[j].distance(s[1]) < 3.0 for j in elev_tree.query(s[1].buffer(3.0)))]
    print(f'   図面にしか無い文字: {len(rest)}スパン')
    print(f'     うち数値だけのもの {len(num)}'
          f'（記号・方向の位置にあるもの {len(on_sym)} ＝ 標高値）')
    kinds = collections.Counter(
        s[0] for _, s in rest if not re.fullmatch(r'-?\d{1,3}(\.\d+)?', s[0]))
    if kinds:
        print('     数値以外の内訳:',
              ', '.join(f'{t}×{c}' if c > 1 else t for t, c in kinds.most_common(15)))

    if '--crops' in sys.argv and top:
        out = ROOT / 'output' / 'reconcile'
        out.mkdir(parents=True, exist_ok=True)
        a_e, b_e, a_n, b_n = aff
        for i, ((e, n), _) in enumerate(top[:5], 1):
            x0, x1 = (e - b_e) / a_e, (e + 5 - b_e) / a_e
            y0, y1 = (n - b_n) / a_n, (n + 5 - b_n) / a_n
            pad = 5.6687 * 3
            r = fitz.Rect(min(x0, x1) - pad, min(y0, y1) - pad,
                          max(x0, x1) + pad, max(y0, y1) + pad)
            page.get_pixmap(clip=r, matrix=fitz.Matrix(12, 12)).save(
                out / f'unknown-{i}-E{e}-N{n}.png')
        print(f'\n   切り出しを {out} に置いた')


if __name__ == '__main__':
    main()
