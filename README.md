# road-ledger-dm-converter

## 概要

道路台帳図（DMデータ）をGeoJSON形式に変換します。線・面・記号・注記の4種類に分割して出力します。

サブフォルダを再帰的に検索するため、土木事務所・路線単位のディレクトリ構造に対応しています。

## 前提条件

- Node.js 18以上

## ディレクトリ構成

```
road-ledger-dm-converter/
├── index.js               # メインスクリプト（シングルスレッド）
├── index_parallel.js      # メインスクリプト（並列処理版・推奨）
├── dm.js                  # DMファイル読み込みクラス
├── dmfiles.js             # DMファイルリスト管理クラス（再帰検索）
├── geojsonWriter.js       # GeoJSON出力クラス（バッファリング書き込み）
├── epsgDefs.js            # 座標参照系定義
├── package.json
└── output/                # 変換後のGeoJSONファイルが出力される
```

## セットアップ

```bash
npm install
```

## 利用方法

並列処理版（`index_parallel.js`）を推奨します。シングルスレッド版（`index.js`）の約4倍高速です。

```bash
# 全データ（../DMデータ/ を再帰検索）- 並列版
node index_parallel.js

# ワーカー数を指定（CPUコア数に合わせて調整）
node index_parallel.js --workers 12

# 特定の土木事務所のみ
node index_parallel.js --input "../DMデータ/道路台帳DMデータ"

# シングルスレッド版
node index.js --input "../DMデータ/道路台帳DMデータ/DMデータ/路線フォルダ"
```

### オプション

| オプション | デフォルト | 説明 |
|---|---|---|
| `--scale` | `500` | 縮尺（出力ファイル名に使用） |
| `--epsg` | `6672` | 入力データの座標参照系（EPSGコード） |
| `--input` | `../DMデータ/` | DMファイルが格納されたフォルダ（サブフォルダを再帰検索） |
| `--workers` | `8` | 並列ワーカー数（`index_parallel.js` のみ） |

### 処理時間の目安（AMD Ryzen 7 5700X）

| 実行方法 | 処理時間 |
|---|---|
| シングルスレッド | 約5分 |
| 並列版（12ワーカー） | **約77秒** |

### 出力ファイル

`output/` フォルダに以下の4ファイルが生成されます。

| ファイル名 | 内容 |
|---|---|
| `道路台帳図_<縮尺>_線.geojson` | 線要素（E2） |
| `道路台帳図_<縮尺>_面.geojson` | 面要素（E1） |
| `道路台帳図_<縮尺>_記号.geojson` | 記号・点要素（E5） |
| `道路台帳図_<縮尺>_注記.geojson` | 注記要素（E7） |

出力されたGeoJSONはQGIS等に読み込むことで地図表示や、tippecanoe等のツールを使ってベクトルタイルへの変換が可能です。

なお、以下のレコードタイプは現在未対応のためスキップされます。

| RecordType | 名称 |
|---|---|
| E3 | 円 |
| E4 | 円弧 |
| E6 | 方向 |
| E8 | 属性 |

### 出力GeoJSONの属性

線・面・記号に共通する属性：

| 属性名 | 説明 | 例 |
|---|---|---|
| `Code` | 分類コード（DMの層番号） | `2101` |
| `Elno` | 要素識別番号 | `3193-112-2101-0001` |
| `RecordType` | レコードタイプ | `E1`（面）、`E2`（線）、`E5`（記号） |
| `DataType` | データタイプ（日本語） | `面`、`線`、`点` |
| `DataKind` | 実データ区分 | `0`（データなし）、`2`（二次元）、`4`（注記） |

注記（E7）のみに追加される属性：

| 属性名 | 説明 | 例 |
|---|---|---|
| `Text` | 注記文字列 | `県道` |
| `Vnflag` | 縦横フラグ | `0`（横書き）、`1`（縦書き） |
| `Angle` | 文字の角度（度） | `86` |

## 座標系

出力はすべて EPSG:4326（WGS84 / 緯度経度）です。

入力は `--epsg` で指定します。

| 系 | JGD2011 | JGD2000 | 都道府県 |
|---|---|---|---|
| 第1系 | 6669 | 2443 | 長崎県、鹿児島県の一部（奄美大島等） |
| 第2系 | 6670 | 2444 | 福岡県、佐賀県、熊本県、大分県、宮崎県、鹿児島県の一部 |
| 第3系 | 6671 | 2445 | 山口県、島根県、広島県 |
| **第4系** | **6672** | 2446 | **四国4県** |
| 第5系 | 6673 | 2447 | 兵庫県、鳥取県、岡山県 |
| 第6系 | 6674 | 2448 | 京都府、大阪府、福井県、滋賀県、三重県、奈良県、和歌山県 |
| 第7系 | 6675 | 2449 | 石川県、富山県、岐阜県、愛知県 |
| 第8系 | 6676 | 2450 | 新潟県、長野県、山梨県、静岡県 |
| 第9系 | 6677 | 2451 | 東京都（島嶼部を除く）、福島県、栃木県、茨城県、埼玉県、千葉県、群馬県、神奈川県 |
| 第10系 | 6678 | 2452 | 青森県、秋田県、山形県、岩手県、宮城県 |

太字（**6672**）がデフォルト値（JGD2011 第4系）です。

## GeoParquet変換

### geopandas を使う場合（Linux / WSL）

```bash
python3 -c "
import geopandas as gpd, os
d = 'output'
for f in sorted(f for f in os.listdir(d) if f.endswith('.geojson')):
    gdf = gpd.read_file(os.path.join(d, f))
    gdf.to_parquet(os.path.join(d, f.replace('.geojson', '.parquet')))
    print('Done:', f)
"
```

### ogr2ogr を使う場合（OSGeo4W / Windows）

[OSGeo4W](https://trac.osgeo.org/osgeo4w/) の ogr2ogr（Parquetドライバ対応版）で `output/` フォルダから実行します。

```bat
for %f in (*.geojson) do ogr2ogr -f Parquet "%~nf.parquet" "%f"
```

`output/` フォルダに `*.parquet` が生成されます。

## ベクトルタイル作成（参考）

出力したGeoJSONから[tippecanoe](https://github.com/felt/tippecanoe)と[pmtiles](https://github.com/protomaps/go-pmtiles)を使ってベクトルタイルを作成できます。

```bash
tippecanoe \
  -o road_ledger_500.mbtiles \
  -Z15 -z18 \
  -r1 \
  --no-feature-limit \
  --no-tile-size-limit \
  --force \
  -L road_line:道路台帳図_500_線.geojson \
  -L road_polygon:道路台帳図_500_面.geojson \
  -L road_symbol:道路台帳図_500_記号.geojson \
  -L road_annotation:道路台帳図_500_注記.geojson
```
