#!/usr/bin/env python3
"""ビューワの描画結果とPDF図面を同じ範囲・同じ縮尺のラスタにして突き合わせる。

`reconcile-pdf.py`（地物の有無）と `measure-pdf.py`（線幅・大きさなどの指定値）は、
どちらも**変換結果とスタイルの指定**を見ていて、画面に出た絵は見ていない。
衝突判定で間引かれるラベル、縦書き、線幅が実際にどう出ているかは、
描いたものを測らないと分からない。その穴を埋めるのがこのスクリプト。

やっていること
  1. 図郭（-48,800〜-48,400 / -135,300〜-135,000。400×300m）を経度緯度に直し、
     `viewer/scripts/render-sheet.mjs` にヘッドレス描画させてPNGを得る
  2. 同じ図郭をPDFから同じ画素数で切り出す
  3. どちらも「インクがあるか」の白黒にして、格子のマスごとに被覆を比べる

**画素の一致は狙わない。** アンチエイリアス・線の色・ハローで必ず外れる。
見るのは「そのマスにインクがあるか」だけで、片側にしか無いマスを数える。

`--breakdown` を付けると、インクの総量の差（豊中サンプルでビューワが図面の1.58倍）を
**線・記号・文字に分けて**数える。ビューワは種類ごとに描き直し（`render-sheet.mjs --only`）、
PDFは描画パスを線幅・塗り・記号で分けて再描画する（`page.get_drawings()` を
`Shape` で描き直すと元の絵と画素単位で一致する）。文字はどちらも「全部の絵から
線と記号を引いた残り」で出す。文字だけを消したPDF（redaction）と突き合わせて検算する。

使い方（リポジトリ直下で。PMTiles が焼けていること）

    python3 scripts/raster-diff.py
    python3 scripts/raster-diff.py --png output/render/viewer-sheet.png   # 描画を省く
    python3 scripts/raster-diff.py --breakdown                            # 内訳（描画4回）
    python3 scripts/raster-diff.py --breakdown --reuse                    # 前回のPNGを使う
    python3 scripts/raster-diff.py --breakdown --ppm 8.157                # z19 の画素密度で

**4px/m は zoom 17.97 にあたり、ビューワの地上サイズ固定は z19 未満で頭打ちになる。**
記号と文字がこの縮尺では z19 の約2倍の地上サイズで描かれるので、図面と同じ地上サイズで
比べるには `--ppm 8.157`（z19。1m＝8.157px）で測る。

必要なもの: pymupdf, pyproj, numpy, Pillow, shapely / それと Chrome（描画するとき）
"""
from __future__ import annotations

import collections
import json
import re
import subprocess
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import fitz
import numpy as np
from PIL import Image
from pyproj import Transformer
from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

# Windows のコンソール既定（cp932）だと日本語の出力が化けるので UTF-8 に揃える
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parent.parent
MP = SourceFileLoader('measure_pdf', str(ROOT / 'scripts/measure-pdf.py')).load_module()

# 図郭。reconcile-pdf.py の SHEET と同じ
E0, E1 = -48800.0, -48400.0
N0, N1 = -135300.0, -135000.0
SHEET = box(E0, N0, E1, N1)

# 出力の画素数。既定は図郭 400×300m に対して 4px/m。
# 細くしすぎるとヘアラインが消え、大きくしすぎると描画が重い。
#
# **4px/m は zoom 17.97 で、ビューワの地上サイズ固定（groundSize）が z19 未満で
# 頭打ちになる範囲。** そのため記号と文字は z19 で描くときの約2倍の地上サイズで出る。
# 図面と同じ地上サイズで比べたいときは `--ppm 8.157`（z19。1m＝8.157px）で測る。
PPM = 4.0
W, H = int((E1 - E0) * PPM), int((N1 - N0) * PPM)
# 出力ファイル名に付ける印。既定の 4px/m は無印（従来のファイル名を保つ）
SUFFIX = ''

# インクとみなす明るさ。白地に黒線なので、これより暗ければインク。
INK_MAX = 200
# 比べるマスの大きさ(m)。記号1つがだいたい1マスに収まる大きさにする。
CELL_M = 5.0
CELL = int(CELL_M * PPM)
# マスに「インクがある」とみなす被覆率。アンチエイリアスの薄い縁だけで
# 立たないように、画素数で下限を置く。
CELL_MIN_PX = 3


def configure(ppm: float) -> None:
    """画素密度を変える（`--ppm`）。W/H/CELL とファイル名の印が連動する。"""
    global PPM, W, H, CELL, SUFFIX
    PPM = float(ppm)
    W, H = int(round((E1 - E0) * PPM)), int(round((N1 - N0) * PPM))
    CELL = int(round(CELL_M * PPM))
    SUFFIX = '' if abs(PPM - 4.0) < 1e-9 else f'-{PPM:g}ppm'

# 内訳で使う線幅の区切り。reconcile-pdf.py の HAIRLINE_PT / FRAME_PT と同じ
HAIRLINE_PT = 0.1
FRAME_PT = 2.0
# 記号とみなす描画パスの大きさと、記号の位置からの距離（measure-pdf.py と同じ）
SYMBOL_MAX_M = 3.0
SYMBOL_R = 1.3
ON_LINE_TOL = 0.35

# 図面の文字を種類に分ける正規表現。図面は等高線の標高を全角整数、標高点を半角で描く
# （reconcile-pdf.py と同じ判別）
ZEN_INT = re.compile('^[０-９]+$')
HAN_NUM = re.compile('^-?[0-9]{1,3}([.][0-9]+)?$')

OUT_DIR = ROOT / 'output' / 'render'


def view_params() -> dict:
    """図郭を画面いっぱいに収める中心・ズーム・方位を出す。

    `fitBounds` は使えない。図郭は平面直角座標の矩形だが、Webメルカトルでは
    子午線収差のぶんわずかに回った平行四辺形になる。緯度経度の外接矩形に
    合わせると図郭より広く撮れ、しかも北がずれたまま差分を取ることになる。

    方位は、図郭の中央で真北（平面直角座標のN方向）が画面上でどちらを向くかを
    メルカトル上で測って決める。ズームは中心緯度での解像度が PPM px/m に
    なる値。MapLibre は512pxタイルなので、256pxタイル基準の式から1段ずれる。
    """
    to_wgs = Transformer.from_crs('EPSG:6674', 'EPSG:4326', always_xy=True)
    cx, cy = (E0 + E1) / 2, (N0 + N1) / 2
    lon, lat = to_wgs.transform(cx, cy)

    # 中央で平面直角座標の北がメルカトル上でどちらを向くか
    lon_s, lat_s = to_wgs.transform(cx, cy - 50.0)
    lon_n, lat_n = to_wgs.transform(cx, cy + 50.0)
    merc = lambda d: np.log(np.tan(np.pi / 4 + np.radians(d) / 2))
    # 経度もラジアンに直してから比べる。メルカトルのy はラジアン基準なので、
    # 度のまま混ぜると桁が合わず方位が大きく狂う
    dx = np.radians(lon_n - lon_s)
    bearing = float(np.degrees(np.arctan2(dx, merc(lat_n) - merc(lat_s))))

    # 256pxタイル基準の解像度。MapLibre の zoom は512pxタイル基準なので1を引く
    res256 = 156543.03392804097 * np.cos(np.radians(lat))
    zoom = float(np.log2(res256 * PPM) - 1)
    return {'lon': lon, 'lat': lat, 'zoom': zoom, 'bearing': bearing}


def render_viewer(out: Path, only: str = '') -> dict:
    """ビューワをヘッドレスで描かせてPNGにする。

    `only` に strokes / icons / text（カンマ区切り）を渡すと、その種類だけを描く。
    返り値（描かれた地物数など）は PNG の隣に JSON でも残す。`--reuse` で読む。
    """
    v = view_params()
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ['node', 'scripts/render-sheet.mjs',
           '--center', f"{v['lon']:.9f},{v['lat']:.9f}",
           '--zoom', f"{v['zoom']:.6f}",
           '--bearing', f"{v['bearing']:.6f}",
           '--width', str(W), '--height', str(H), '--out', str(out)]
    if only:
        cmd += ['--only', only]
    print(f"  ビューワを描画中… {W}x{H}px = {PPM}px/m  "
          f"zoom {v['zoom']:.4f} / 方位 {v['bearing']:+.4f}度"
          + (f'  [{only} だけ]' if only else ''))
    # vite も Chrome も UTF-8 で書くので、既定のコードページで読ませない
    r = subprocess.run(cmd, cwd=ROOT / 'viewer', capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if r.returncode != 0:
        sys.exit('描画に失敗しました:' + chr(10) + r.stdout + chr(10) + r.stderr)
    last = [ln for ln in r.stdout.splitlines() if ln.startswith('{')]
    got = json.loads(last[-1]) if last else {}
    if got:
        print(f"  描かれた地物 {got.get('features', 0)}件 / "
              f"{got.get('layers', 0)}レイヤー")
        out.with_suffix('.json').write_text(json.dumps(got, ensure_ascii=False, indent=1),
                                            encoding='utf-8')
    return got


# ---- PDF ----

def pdf_page() -> tuple[fitz.Document, fitz.Page, fitz.Rect, fitz.Matrix, tuple]:
    """図面のページと、図郭を切り出す矩形・行列・アフィン変換を返す。"""
    doc = fitz.open(MP.PDF)
    page = doc[0]
    aff = MP.affine(page)
    a_e, b_e, a_n, b_n = aff
    xs = sorted([(E0 - b_e) / a_e, (E1 - b_e) / a_e])
    ys = sorted([(N0 - b_n) / a_n, (N1 - b_n) / a_n])
    rect = fitz.Rect(xs[0], ys[0], xs[1], ys[1])
    m = fitz.Matrix(W / rect.width, H / rect.height)
    return doc, page, rect, m, aff


def rasterize(page: fitz.Page, rect: fitz.Rect, m: fitz.Matrix) -> np.ndarray:
    pix = page.get_pixmap(clip=rect, matrix=m, colorspace=fitz.csGRAY, alpha=False)
    a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    return a[:H, :W]


def render_pdf() -> np.ndarray:
    """PDF図面の図郭を同じ画素数で切り出してグレースケールで返す。"""
    _, page, rect, m, _ = pdf_page()
    return rasterize(page, rect, m)


def render_pdf_without_text() -> np.ndarray:
    """文字だけを消したPDFを同じ画素数で描く（redaction で文字を除く）。

    描画パスの再描画（`redraw`）の検算に使う。両者が画素単位で一致すれば、
    再描画で分けた内訳は元の絵の内訳と見てよい。
    """
    doc = fitz.open(MP.PDF)
    page = doc[0]
    _, _, rect, m, _ = pdf_page()
    page.add_redact_annot(page.rect)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                          graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    return rasterize(page, rect, m)


def is_white(d: dict) -> bool:
    """白い塗り・白い線か。図面はこれを「下の線を消すマスク」として使っている。"""
    white = (1.0, 1.0, 1.0)
    return (d.get('fill') == white and d.get('color') in (None, white)) or (
        d.get('fill') is None and d.get('color') == white)


def redraw(src: fitz.Page, drawings: list, rect: fitz.Rect, m: fitz.Matrix,
           masks: list | None = None) -> np.ndarray:
    """描画パスの一部だけを新しいページに描き直し、同じ画素数で返す。

    `get_drawings()` の項目を `Shape` でそのまま描くと、元の絵と画素単位で一致する
    （豊中サンプルの図郭で 172,966px が完全一致、元の絵にだけあるのは182px）。

    `masks`（白いパス）は元の順番に割り込ませて描く。図面は白い塗りで下の線を消してから
    その上に記号を描く箇所があり、種類ごとに分けると「線を消す白」が線の絵から抜けて
    元の絵より多く、「白の上の記号」が白より先に描かれて元の絵より少なくなる。
    分類のときに付けた `_seq`（元の並び順）で並べ直す。
    """
    doc = fitz.open()
    page = doc.new_page(width=src.rect.width, height=src.rect.height)
    sh = page.new_shape()
    todo = sorted(list(drawings) + list(masks or []), key=lambda d: d.get('_seq', 0))
    for d in todo:
        for it in d['items']:
            k = it[0]
            if k == 'l':
                sh.draw_line(it[1], it[2])
            elif k == 'c':
                sh.draw_bezier(it[1], it[2], it[3], it[4])
            elif k == 're':
                sh.draw_rect(it[1])
            elif k == 'qu':
                sh.draw_quad(it[1])
        cap = d.get('lineCap') or 0
        if isinstance(cap, (tuple, list)):
            cap = cap[0]
        sh.finish(color=d.get('color'), fill=d.get('fill'), width=d.get('width') or 0,
                  closePath=bool(d.get('closePath', False)), lineCap=int(cap),
                  lineJoin=int(d.get('lineJoin') or 0), even_odd=bool(d.get('even_odd', False)))
    sh.commit()
    return rasterize(page, rect, m)


def dm_geometries() -> tuple[list, list]:
    """変換結果の線・面（LineString）と、記号・方向の点（Point）を平面直角座標で返す。"""
    lines = []
    for kind in ('線', '面'):
        for f in MP.load(kind):
            for ring in MP.rings(f['geometry']):
                if len(ring) >= 2:
                    lines.append(LineString([MP.TR.transform(x, y) for x, y in ring]))
    points = []
    for kind in ('記号', '方向'):
        for f in MP.load(kind):
            points.append(Point(MP.TR.transform(*f['geometry']['coordinates'][:2])))
    return lines, points


def classify_drawings(page: fitz.Page, rect: fitz.Rect, aff) -> dict[str, list]:
    """図郭内の描画パスを内訳の種類に分ける。

      hairline   線幅 0.1pt 未満（1:500 では 0.02mm。紙に出ない）
      frame      線幅 2.0pt 以上（図郭の枠線）
      icons      記号・方向の位置の周りにある小さなパス。線に沿うものは除く
                 （measure-pdf.py の measure_symbols と同じ判定）
      strokes    上記以外の線（type 's'）
      fills      上記以外の塗り（type 'f'）。図面は破線の1画や太い線を塗りで描くことがある
      white      白い塗り・線。下の線を消すマスクで、インクではない。再描画のとき
                 元の順番で割り込ませる（`redraw` の masks）
    """
    lines, points = dm_geometries()
    ltree = STRtree(lines)
    ptree = STRtree(points)
    out: dict[str, list] = collections.defaultdict(list)
    for seq, d in enumerate(page.get_drawings()):
        if not rect.intersects(d['rect']):
            continue
        d['_seq'] = seq
        if is_white(d):
            out['white'].append(d)
            continue
        w = d.get('width') or 0
        stroked = d['type'] in ('s', 'fs')
        if stroked and w < HAIRLINE_PT:
            out['hairline'].append(d)
            continue
        if stroked and w >= FRAME_PT:
            out['frame'].append(d)
            continue
        r = d['rect']
        p = MP.to_plane(aff, [(r.x0, r.y0), (r.x1, r.y1)])
        x0, x1 = sorted([p[0][0], p[1][0]])
        y0, y1 = sorted([p[0][1], p[1][1]])
        is_symbol = False
        if max(x1 - x0, y1 - y0) <= SYMBOL_MAX_M:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            near = [i for i in ptree.query(box(cx - SYMBOL_R, cy - SYMBOL_R, cx + SYMBOL_R, cy + SYMBOL_R))
                    if abs(points[i].x - cx) < SYMBOL_R and abs(points[i].y - cy) < SYMBOL_R]
            if near:
                pts = [q for it in d['items'] for q in MP.path_points(it)]
                pl = MP.to_plane(aff, pts) if pts else []
                pl = [q for q in pl if np.isfinite(q).all()]
                on = sum(
                    1 for q in pl
                    if any(lines[i].distance(Point(q)) < ON_LINE_TOL
                           for i in ltree.query(Point(q).buffer(ON_LINE_TOL))))
                is_symbol = not pts or on / len(pl) < 0.6
        if is_symbol:
            out['icons'].append(d)
        elif stroked:
            out['strokes'].append(d)
        else:
            out['fills'].append(d)
    return out


def stroke_length_m(drawings: list, aff) -> float:
    """線パスの延長（m）。図郭内の線分だけを足す。"""
    total = 0.0
    for d in drawings:
        for it in d['items']:
            if it[0] == 'l':
                seg = [(it[1].x, it[1].y), (it[2].x, it[2].y)]
            elif it[0] == 'c':
                seg = [(it[1].x, it[1].y), (it[4].x, it[4].y)]
            else:
                continue
            p = MP.to_plane(aff, seg)
            mid = ((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2)
            if E0 <= mid[0] <= E1 and N0 <= mid[1] <= N1:
                total += float(np.hypot(*(p[1] - p[0])))
    return total


def pdf_text_spans(page: fitz.Page, aff) -> collections.Counter:
    """図郭内の文字スパンを種類別に数える。"""
    c: collections.Counter = collections.Counter()
    for b in page.get_text('dict')['blocks']:
        for line in b.get('lines', []):
            for s in line['spans']:
                t = s['text'].strip()
                if not t:
                    continue
                x = (s['bbox'][0] + s['bbox'][2]) / 2
                y = (s['bbox'][1] + s['bbox'][3]) / 2
                e, n = MP.to_plane(aff, [(x, y)])[0]
                if not (E0 <= e <= E1 and N0 <= n <= N1):
                    continue
                if ZEN_INT.match(t):
                    c['等高線の標高（全角整数）'] += 1
                elif HAN_NUM.match(t):
                    c['標高点の標高（半角数値）'] += 1
                else:
                    c['注記など'] += 1
    return c


# ---- 共通 ----

def ink_of_png(p: Path) -> np.ndarray:
    """PNGをグレースケールにして返す。透明は白（紙）として扱う。"""
    im = Image.open(p).convert('RGBA')
    if im.size != (W, H):
        sys.exit(f'画素数が違います: {im.size} ≠ {(W, H)}')
    a = np.asarray(im).astype(np.float32)
    alpha = a[:, :, 3:4] / 255.0
    rgb = a[:, :, :3] * alpha + 255.0 * (1 - alpha)
    return (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]).astype(np.uint8)


def registration(vi: np.ndarray, pi: np.ndarray, rng: int = 6) -> tuple[int, int, float]:
    """2枚のインクが最もよく重なる画素のずれを探す。

    **これは補正ではなく検算。** 範囲・縮尺・方位の計算をどこかで間違えると
    絵は一見それらしいのに全部ずれ、差分の数字だけが静かに悪化する。
    最良のずれが (0, 0) 近くに出ることを確かめて、初めて他の数字が読める。
    """
    best = (0, 0, -1.0)
    for dy in range(-rng, rng + 1):
        for dx in range(-rng, rng + 1):
            a = vi[max(0, dy):vi.shape[0] + min(0, dy), max(0, dx):vi.shape[1] + min(0, dx)]
            b = pi[max(0, -dy):pi.shape[0] + min(0, -dy), max(0, -dx):pi.shape[1] + min(0, -dx)]
            n = float((a & b).sum())
            if n > best[2]:
                best = (dx, dy, n)
    return best


def cells(mask: np.ndarray) -> np.ndarray:
    """画素のマスクをマスごとの画素数にまとめる。"""
    h, w = mask.shape
    ch, cw = h // CELL, w // CELL
    m = mask[:ch * CELL, :cw * CELL].reshape(ch, CELL, cw, CELL)
    return m.sum(axis=(1, 3))


def cell_center(r: int, c: int) -> tuple[float, float]:
    """マスの中心を平面直角座標で返す（行は北から数える）。"""
    e = E0 + (c + 0.5) * CELL_M
    n = N1 - (r + 0.5) * CELL_M
    return e, n


def save_overlay(vi: np.ndarray, pi: np.ndarray, name: str) -> Path:
    """重ね絵を出す。赤＝ビューワだけ、青＝図面だけ、黒＝両方。"""
    ov = np.full((H, W, 3), 255, dtype=np.uint8)
    ov[vi & pi] = (0, 0, 0)
    ov[vi & ~pi] = (220, 30, 30)
    ov[~vi & pi] = (30, 80, 220)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    Image.fromarray(ov).save(p)
    return p


def compare(png: Path) -> None:
    print(f'図郭 {E0:.0f}〜{E1:.0f} / {N0:.0f}〜{N1:.0f}（400×300m）'
          f'  {W}x{H}px = {PPM}px/m  マス {CELL_M:.0f}m')

    v = ink_of_png(png)
    p = render_pdf()
    vi, pi = v < INK_MAX, p < INK_MAX
    print(f'\n■ 画素のインク    ビューワ {vi.sum():,}px / 図面 {pi.sum():,}px')

    dx, dy, n = registration(vi, pi)
    base = float((vi & pi).sum())
    print(f'■ 位置合わせの検算  最良のずれ ({dx:+d}, {dy:+d})px = '
          f'({dx / PPM:+.2f}, {dy / PPM:+.2f})m'
          f'  重なり {n / max(base, 1):.3f}倍')
    if abs(dx) > 2 or abs(dy) > 2:
        print('   ずれが大きい。範囲・縮尺・方位の計算を疑うこと')

    vc, pc = cells(vi), cells(pi)
    von, pon = vc >= CELL_MIN_PX, pc >= CELL_MIN_PX
    both = int((von & pon).sum())
    vonly = von & ~pon
    ponly = pon & ~von
    total = int(von.sum() | 0) + int(pon.sum()) - both
    print(f'■ マス（{CELL_M:.0f}m角。全 {von.size}マス）')
    print(f'   両方にインク            {both:5d}マス')
    print(f'   ビューワにしか無い      {int(vonly.sum()):5d}マス  ← 描きすぎ')
    print(f'   図面にしか無い          {int(ponly.sum()):5d}マス  ← 描き足りない')
    print(f'   どちらにも無い          {int((~von & ~pon).sum()):5d}マス')
    if total:
        print(f'   一致率 {both / total * 100:.1f}%（どちらかにインクがあるマスのうち）')

    for name, m, cnt in (('ビューワにしか無い', vonly, vc), ('図面にしか無い', ponly, pc)):
        idx = np.argwhere(m)
        if not len(idx):
            continue
        order = sorted(idx.tolist(), key=lambda rc: -cnt[rc[0], rc[1]])[:8]
        print(f'\n   {name}マスのうちインクが多い順')
        for r, c in order:
            e, n = cell_center(r, c)
            print(f'     E{e:.0f} N{n:.0f}   ビューワ {vc[r, c]:5d}px / 図面 {pc[r, c]:5d}px')

    # 目で確かめられるように重ね絵を出す
    ov = save_overlay(vi, pi, f'overlay{SUFFIX}.png')
    Image.fromarray(p).save(OUT_DIR / f'pdf-sheet{SUFFIX}.png')
    print(f'\n   重ね絵: {ov}（赤＝ビューワだけ／青＝図面だけ／黒＝両方）')


# ---- 内訳 ----

VIEWER_CLASSES = ('strokes', 'icons', 'text')


def breakdown(reuse: bool) -> None:
    """インクの総量の差を、線・記号・文字に分けて数える。"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- ビューワ: 全部と、種類ごとの描き直し ----
    pngs = {'': OUT_DIR / f'viewer-sheet{SUFFIX}.png'}
    for c in VIEWER_CLASSES:
        pngs[c] = OUT_DIR / f'viewer-{c}{SUFFIX}.png'
    got: dict[str, dict] = {}
    for c, path in pngs.items():
        js = path.with_suffix('.json')
        if reuse and path.exists() and js.exists():
            got[c] = json.loads(js.read_text(encoding='utf-8'))
        else:
            got[c] = render_viewer(path, c)
    v_full = ink_of_png(pngs['']) < INK_MAX
    v = {c: ink_of_png(pngs[c]) < INK_MAX for c in VIEWER_CLASSES}
    # 文字は「全部の絵から線と記号を引いた残り」。等高線のラベルは衝突判定に
    # 任せているので、文字だけを描いた絵は全部描いたときより増えうる
    v_text_resid = v_full & ~(v['strokes'] | v['icons'])

    # ---- 図面: 描画パスを分けて再描画 ----
    doc, page, rect, m, aff = pdf_page()
    p_full = rasterize(page, rect, m) < INK_MAX
    p_draw = render_pdf_without_text() < INK_MAX
    p_text = p_full & ~p_draw
    groups = classify_drawings(page, rect, aff)
    print('  図面の描画パスを再描画中…')
    p = {k: redraw(page, groups[k], rect, m, groups['white']) < INK_MAX
         for k in ('strokes', 'fills', 'icons', 'hairline', 'frame')}
    p_redraw_all = np.zeros_like(p_full)
    for k in p:
        p_redraw_all |= p[k]

    print(f'図郭 {E0:.0f}〜{E1:.0f} / {N0:.0f}〜{N1:.0f}（400×300m）  {W}x{H}px = {PPM}px/m')
    print('\n■ 検算')
    dx, dy, n = registration(v_full, p_full)
    print(f'   位置合わせ  最良のずれ ({dx:+d}, {dy:+d})px')
    miss = int((p_draw & ~p_redraw_all).sum())
    extra = int((p_redraw_all & ~p_draw).sum())
    print(f'   図面の再描画  文字を消した元の絵 {p_draw.sum():,}px に対し '
          f'再描画に無い {miss:,}px（{miss / max(p_draw.sum(), 1) * 100:.1f}%） / '
          f'再描画にだけある {extra:,}px')
    # 種類ごとに別々に描くと、2本の細い線が隣り合う画素は片方ずつでは薄くて
    # インクの閾値を越えず、合わせて描いた元の絵でだけ越える。1〜2% はこれで減る
    # （全部を1枚に描き直すと 182px まで合う）。それ以上なら分類か再描画を疑う
    if miss > p_draw.sum() * 0.02 or extra > p_draw.sum() * 0.005:
        print('   !! 再描画が元の絵と合っていない。内訳の数字は読めない')
    for k in VIEWER_CLASSES:
        print(f"   ビューワ {k:8}  描かれた地物 {got[k].get('features', 0):5d}件"
              f"  ／ 全部 {got[''].get('features', 0):5d}件")

    # ---- 内訳 ----
    vt, pt = int(v_full.sum()), int(p_full.sum())
    rows = [
        ('線・面', int(v['strokes'].sum()), int((p['strokes'] | p['fills']).sum())),
        ('  うち塗りで描かれた線（図面のみ）', None, int(p['fills'].sum())),
        ('記号・方向', int(v['icons'].sum()), int(p['icons'].sum())),
        ('文字（全部から線と記号を引いた残り）', int(v_text_resid.sum()), int(p_text.sum())),
        ('  文字だけを描いた絵', int(v['text'].sum()), None),
        ('紙に出ないヘアライン（図面のみ）', None, int(p['hairline'].sum())),
        ('図郭の枠線（図面のみ）', None, int(p['frame'].sum())),
        ('合計', vt, pt),
    ]
    print(f'\n■ インクの内訳（px。ビューワ zoom {view_params()["zoom"]:.2f}）')
    print(f"   {'':38} {'ビューワ':>9} {'図面':>9} {'比':>6}  {'差（ビューワ−図面）':>12}")
    for name, a, b in rows:
        sa = f'{a:9,d}' if a is not None else f"{'―':>9}"
        sb = f'{b:9,d}' if b is not None else f"{'―':>9}"
        ratio = f'{a / b:6.2f}' if a and b else f"{'':6}"
        diff = f'{a - b:+10,d}' if a is not None and b is not None else ''
        print(f'   {name:38} {sa} {sb} {ratio}  {diff}')
    # 種類の重なり（線の上に記号が乗るなど）は各行に二重に数えるので、行の和は合計を超える
    print('   ※ 種類が重なる画素は両方の行に数えるので、行の和は合計を上回る')
    print('   ※ 4px/m（zoom 17.97）ではビューワの地上サイズ固定が z19 で頭打ちになり、'
          '記号・文字・線幅が z19 の約2倍の地上サイズで出る。'
          '図面と同じ地上サイズで比べるには --ppm 8.157（z19）')

    # ---- 線幅 ----
    lines, _ = dm_geometries()
    dm_len = sum(g.intersection(SHEET).length for g in lines)
    pdf_len = stroke_length_m(groups['strokes'], aff)
    print('\n■ 線幅（インク ÷ 延長。塗りで描かれた線は延長が測れないので除く）')
    print(f'   ビューワ  延長 {dm_len:9,.0f}m  インク {int(v["strokes"].sum()):8,d}px'
          f'  → 平均 {v["strokes"].sum() / max(dm_len * PPM, 1):.2f}px'
          f' = {v["strokes"].sum() / max(dm_len * PPM, 1) / PPM:.3f}m')
    print(f'   図面      延長 {pdf_len:9,.0f}m  インク {int(p["strokes"].sum()):8,d}px'
          f'  → 平均 {p["strokes"].sum() / max(pdf_len * PPM, 1):.2f}px'
          f' = {p["strokes"].sum() / max(pdf_len * PPM, 1) / PPM:.3f}m')
    print(f'   （{PPM}px/m なので 1px ＝ {1 / PPM:.2f}m。アンチエイリアスで細い線も1px以上になる）')

    # ---- 文字 ----
    per = got['text'].get('perLayer', {})
    v_labels = {
        '等高線の標高': per.get('road_line_elev', 0),
        '標高点の標高': per.get('road_symbol_elev', 0) + per.get('road_direction_elev', 0),
        '注記': per.get('road_annotation', 0),
    }
    p_spans = pdf_text_spans(page, aff)
    p_labels = {
        '等高線の標高': p_spans.get('等高線の標高（全角整数）', 0),
        '標高点の標高': p_spans.get('標高点の標高（半角数値）', 0),
        '注記': p_spans.get('注記など', 0),
    }
    print('\n■ 文字の数（ビューワは画面に出た数。図面は文字スパンの数）')
    for k in v_labels:
        print(f'   {k:12} ビューワ {v_labels[k]:4d} / 図面 {p_labels[k]:4d}')
    nv, npn = sum(v_labels.values()), sum(p_labels.values())
    if nv and npn:
        print(f'   1つあたりのインク  ビューワ {v_text_resid.sum() / nv:6.1f}px'
              f' / 図面 {p_text.sum() / npn:6.1f}px'
              f'  → 字形・字高の比 {v_text_resid.sum() / nv / (p_text.sum() / npn):.2f}倍、'
              f'数の比 {nv / npn:.2f}倍')

    # ---- 重ね絵 ----
    paths = [
        save_overlay(v['strokes'], p['strokes'] | p['fills'], f'overlay-strokes{SUFFIX}.png'),
        save_overlay(v['icons'], p['icons'], f'overlay-icons{SUFFIX}.png'),
        save_overlay(v_text_resid, p_text, f'overlay-text{SUFFIX}.png'),
    ]
    print('\n   重ね絵（赤＝ビューワだけ／青＝図面だけ／黒＝両方）:')
    for q in paths:
        print(f'     {q}')


def main() -> None:
    if '--ppm' in sys.argv:
        configure(float(sys.argv[sys.argv.index('--ppm') + 1]))
    if '--breakdown' in sys.argv:
        breakdown(reuse='--reuse' in sys.argv)
        return
    png = None
    if '--png' in sys.argv:
        png = Path(sys.argv[sys.argv.index('--png') + 1])
    if png is None:
        png = OUT_DIR / f'viewer-sheet{SUFFIX}.png'
        render_viewer(png)
    compare(png)


if __name__ == '__main__':
    main()
