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

使い方（リポジトリ直下で。PMTiles が焼けていること）

    python3 scripts/raster-diff.py
    python3 scripts/raster-diff.py --png output/render/viewer-sheet.png   # 描画を省く

必要なもの: pymupdf, pyproj, numpy, Pillow / それと Chrome（描画するとき）
"""
from __future__ import annotations

import json
import subprocess
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import fitz
import numpy as np
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
MP = SourceFileLoader('measure_pdf', str(ROOT / 'scripts/measure-pdf.py')).load_module()

# 図郭。reconcile-pdf.py の SHEET と同じ
E0, E1 = -48800.0, -48400.0
N0, N1 = -135300.0, -135000.0

# 出力の画素数。図郭 400×300m に対して 4px/m。
# 細くしすぎるとヘアラインが消え、大きくしすぎると描画が重い。
PPM = 4
W, H = int((E1 - E0) * PPM), int((N1 - N0) * PPM)

# インクとみなす明るさ。白地に黒線なので、これより暗ければインク。
INK_MAX = 200
# 比べるマスの大きさ(m)。記号1つがだいたい1マスに収まる大きさにする。
CELL_M = 5.0
CELL = int(CELL_M * PPM)
# マスに「インクがある」とみなす被覆率。アンチエイリアスの薄い縁だけで
# 立たないように、画素数で下限を置く。
CELL_MIN_PX = 3


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


def render_viewer(out: Path) -> dict:
    """ビューワをヘッドレスで描かせてPNGにする。"""
    v = view_params()
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ['node', 'scripts/render-sheet.mjs',
           '--center', f"{v['lon']:.9f},{v['lat']:.9f}",
           '--zoom', f"{v['zoom']:.6f}",
           '--bearing', f"{v['bearing']:.6f}",
           '--width', str(W), '--height', str(H), '--out', str(out)]
    print(f"  ビューワを描画中… {W}x{H}px = {PPM}px/m  "
          f"zoom {v['zoom']:.4f} / 方位 {v['bearing']:+.4f}度")
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
    return got


def render_pdf() -> np.ndarray:
    """PDF図面の図郭を同じ画素数で切り出してグレースケールで返す。"""
    page = fitz.open(MP.PDF)[0]
    a_e, b_e, a_n, b_n = MP.affine(page)
    xs = sorted([(E0 - b_e) / a_e, (E1 - b_e) / a_e])
    ys = sorted([(N0 - b_n) / a_n, (N1 - b_n) / a_n])
    rect = fitz.Rect(xs[0], ys[0], xs[1], ys[1])
    m = fitz.Matrix(W / rect.width, H / rect.height)
    pix = page.get_pixmap(clip=rect, matrix=m, colorspace=fitz.csGRAY, alpha=False)
    a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    return a[:H, :W]


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


def main() -> None:
    png = None
    if '--png' in sys.argv:
        png = Path(sys.argv[sys.argv.index('--png') + 1])
    out_dir = ROOT / 'output' / 'render'
    if png is None:
        png = out_dir / 'viewer-sheet.png'
        render_viewer(png)
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

    # 目で確かめられるように重ね絵を出す。赤＝ビューワだけ、青＝図面だけ、黒＝両方
    ov = np.full((H, W, 3), 255, dtype=np.uint8)
    ov[vi & pi] = (0, 0, 0)
    ov[vi & ~pi] = (220, 30, 30)
    ov[~vi & pi] = (30, 80, 220)
    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(ov).save(out_dir / 'overlay.png')
    Image.fromarray(p).save(out_dir / 'pdf-sheet.png')
    print(f'\n   重ね絵: {out_dir / "overlay.png"}（赤＝ビューワだけ／青＝図面だけ／黒＝両方）')


if __name__ == '__main__':
    main()
