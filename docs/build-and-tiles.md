# ベクトルタイルと一括ビルド

- [一括ビルド](#一括ビルド)
- [環境変数](#環境変数)
- [必要なツール](#必要なツール)
- [タイルのレイヤー構成](#タイルのレイヤー構成)
- [タイルに残す属性](#タイルに残す属性)
- [最大ズームレベルの決め方](#最大ズームレベルの決め方)

## 一括ビルド

GeoJSONだけ作り直してGeoParquetやPMTilesが古いまま残ると、配信データと変換結果が食い違います。`scripts/build.sh` でDM → GeoJSON → GeoParquet → MBTiles → PMTiles をまとめて焼き直せます。

```bash
# ../DMデータ/ を変換して一式を生成
scripts/build.sh

# 入力フォルダを指定
EPSG=6674 scripts/build.sh /path/to/DM_57-08/dm

# タイルだけ焼き直す
SKIP_CONVERT=1 SKIP_PARQUET=1 scripts/build.sh
```

DM→GeoJSON の直後に[拡張コードの点検](extended-codes.md)（`npm run check:extended`）を実行します。

## 環境変数

| 変数 | 効果 |
|---|---|
| `EPSG=6674` | 入力データの座標参照系を指定 |
| `JOBS=4` | 並列数を指定 |
| `MAXZOOM=17` | タイルの最大ズーム（既定18） |
| `MINZOOM=14` | タイルの最小ズーム（既定15） |
| `SKIP_CONVERT=1` | DM→GeoJSON を飛ばす |
| `SKIP_CHECK=1` | 拡張コードの点検を飛ばす（ネットワークが要るため） |
| `SKIP_PARQUET=1` | GeoParquet を作らない |
| `SKIP_TILES=1` | MBTiles / PMTiles を作らない |
| `VITE_DM_PROVIDERS=` | 点検で使う拡張DMの提供元（既定はビューワと同じ） |
| `ATTRIBUTION="..."` | タイルのメタデータに入れる帰属・承認の文言（tippecanoe `-A`）。測量成果の使用承認で明示を求められる文言を承認書の指定どおりに書く。未指定なら入れず、最後に注意を出す（[利用上の注意](legal.md)） |

## 必要なツール

いずれも無ければ該当する段だけスキップされ、変換自体は完了します。

| ツール | 用途 |
|---|---|
| [OSGeo4W](https://trac.osgeo.org/osgeo4w/) の ogr2ogr | GeoParquet 生成 |
| geopandas + pyarrow | GeoParquet 生成（ogr2ogr が使えない場合の代替） |
| [tippecanoe](https://github.com/felt/tippecanoe) | ベクトルタイル生成 |
| [go-pmtiles](https://github.com/protomaps/go-pmtiles) | PMTiles 変換 |

> **GeoParquet には Parquet ドライバを持つGDALが必要です。** conda版・Debian版のGDALは既定でParquetドライバを含みません。スクリプトは `PATH` 上の `ogr2ogr` を調べ、Parquet非対応であれば `C:\OSGeo4W\bin\ogr2ogr.exe`（見つからなければ `C:\OSGeo4W64\bin\ogr2ogr.exe`）へフォールバックし、それも無ければ `scripts/geojson2parquet.py`（geopandas）を使います。

## タイルのレイヤー構成

| レイヤー名 | 元データ | 出現ズーム |
|---|---|---|
| `road_line` | 線（E2） | Z15〜 |
| `road_polygon` | 面（E1） | Z15〜 |
| `road_symbol` | 記号（E5） | Z17〜 |
| `road_direction` | 方向（E6） | Z17〜 |
| `road_annotation` | 注記（E7） | Z17〜 |

記号・方向・注記はZL17未満では小さすぎて読めないため、タイルに入れていません。

## タイルに残す属性

タイルに残す属性は `Code`・`Text`・`Angle`・`Elev`・`Seq` の5つだけです（`build.sh` の `TILE_ATTRS`）。`Elno` はフィーチャごとにユニークな文字列でタイル内の文字列辞書を最も膨らませるため落としています。`RecordType`・`DataType`・`DataKind`・`Scale`・`Vnflag` はレイヤー内でほぼ単一値か表示専用のため同様です。

`Seq` はビューワが電柱の向き（複数ペアの方向要素）を要素につき1個のアイコンで描くのに使います（[電柱の向きを示す短い線](../viewer/README.md#電柱の向きを示す短い線)）。

## 最大ズームレベルの決め方

ベクトルタイルは座標をタイル内の整数格子（0〜4,095）に量子化して格納するため、変換時にわずかな位置誤差が生じます。元データの精度を損なわないよう、**格子間隔（分解能）が地図の許容誤差以下**になる最小のZLを最大ズームレベルに選びます。

- **許容誤差** = 縮尺分母 × 0.1mm（図上0.1mmに相当する地上距離）
- **分解能** = 赤道周長 40,075,016.686m ÷ (2^ZL × 4,096)

| 地図情報レベル | 許容誤差 | 最大ZL | そのZLの分解能 | 1段下のZLの分解能 |
|---|---|---|---|---|
| 500 | 0.05m | **18** | 0.037m | 0.075m ✗ |
| 1,000 | 0.1m | **17** | 0.075m | 0.149m ✗ |

分解能は赤道基準の最大値で、実際には緯度 φ において cos φ 倍に小さくなります。したがって日本国内では余裕をもって許容誤差を満たします。

1/1,000 のデータだけを扱う場合は `MAXZOOM=17` を指定するとタイル数を減らせます。
