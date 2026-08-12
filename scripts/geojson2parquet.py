#!/usr/bin/env python
"""GeoJSON を GeoParquet に変換する。

Parquet ドライバを持つ GDAL が無い環境向けのフォールバック。
scripts/build.sh から呼ばれるほか、単体でも使える。

    python scripts/geojson2parquet.py output/道路台帳図_線.geojson
    python scripts/geojson2parquet.py output/*.geojson
"""
import pathlib
import sys

import geopandas as gpd


def convert(src: pathlib.Path) -> pathlib.Path:
    dst = src.with_suffix(".parquet")
    gdf = gpd.read_file(src)
    # write_covering_bbox で bbox 列を付ける。範囲指定で読むときに効く。
    gdf.to_parquet(
        dst,
        compression="zstd",
        geometry_encoding="WKB",
        write_covering_bbox=True,
    )
    return dst


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1

    status = 0
    for a in args:
        src = pathlib.Path(a)
        if not src.exists():
            print(f"  !! {src} が見つかりません")
            status = 1
            continue
        try:
            dst = convert(src)
        except Exception as e:  # noqa: BLE001 - 1ファイルの失敗で全体を止めない
            print(f"  !! {src.name} の変換に失敗: {e}")
            status = 1
            continue
        print(
            f"  {dst.name}  "
            f"{src.stat().st_size / 1024:.1f}KB -> {dst.stat().st_size / 1024:.1f}KB"
        )
    return status


if __name__ == "__main__":
    sys.exit(main())
