# dm-road-ledger-converter

道路台帳平面図のDM（数値地形図データファイル）をGeoJSON形式に変換します。線・面・記号・方向・注記の5種類に分割して出力します。

出力したGeoJSONは、QGIS等での地図表示のほか、GeoParquetへの変換や、tippecanoe・pmtiles によるベクトルタイル化を経てWeb地図での利用ができます。

まず動くものを見るなら、変換済みデータを表示するデモがそのまま開けます（インストール不要）。豊中市の道路台帳平面図DM500（図郭57-08・市役所付近）を、右下の背景切替で「白図」を選ぶと変換結果だけで表示できます。

- **デモ**: https://shiwaku.github.io/dm-road-ledger-converter/

[dm-converter](https://github.com/shiwaku/dm-converter) の派生です。道路台帳図は**座標オフセットの単位がミリメートル**（基本図はセンチメートル）で含まれる地物も異なるため、リポジトリを分けています。**両者を入れ替えて使うと座標が10倍ずれます**（[dm-converter との違い](docs/dm-format.md#dm-converter-との違い)）。

## クイックスタート

必要なのは **Node.js 18以上**だけです。変換自体に外部ツールは要りません（依存パッケージは `iconv-lite` と `proj4` の2つ）。

**1. DMデータを用意する**

手元にデータが無ければ、豊中市が道路台帳平面図DM500のサンプル（図郭57-08・市役所付近）を[無償公開](https://www.city.toyonaka.osaka.jp/machi/doro/daityou/digitalmap/sanple.html)しています。DM・DXF・PDF・シェープファイルの4形式が入っており、動作確認に使えます。

> DMデータは測量法に基づく公共測量成果です。複製・使用には原則として道路管理者の承認が必要です（[利用上の注意](docs/legal.md)）。

**2. 変換する**

```bash
git clone https://github.com/shiwaku/dm-road-ledger-converter.git
cd dm-road-ledger-converter
npm install
node src/index.js --epsg 6674 --input /path/to/DM_57-08/dm
ls output/                   # 線・面・記号・方向・注記 の5ファイルが出る
```

`--epsg` には入力データの平面直角座標系を指定します（大阪府なので第6系＝6674）。系の一覧は[出力仕様](docs/output-spec.md#座標系)にあります。**縮尺は指定しません**。Mレコードから自動で読み取り、`Scale` 属性として出力します。

豊中市サンプルでの件数です。

| 種別 | 件数 |
|---|---|
| 線 | 2,647 |
| 面 | 400 |
| 記号 | 1,210 |
| 方向 | 1,473 |
| 注記 | 95 |

**3. 地図で見る**

出力した GeoJSON は QGIS にそのまま読み込めます。ベクトルタイル化して同梱のビューワで表示する手順は[ベクトルタイルと一括ビルド](docs/build-and-tiles.md)を参照してください。

## 使い方

```bash
# ../DMデータ/ を再帰検索して変換
node src/index.js

# 入力フォルダを指定
node src/index.js --input /path/to/dm_dir

# 座標系を指定（大阪府＝第6系）
node src/index.js --epsg 6674 --input /path/to/dm_dir

# 並列数を指定。1 で逐次実行
node src/index.js --jobs 4 --input /path/to/dm_dir
```

入力フォルダは**サブフォルダを再帰的に検索**します。道路台帳DMは路線ごとにフォルダが分かれていることが多いためです。

### オプション

| オプション | 既定値 | 説明 |
|---|---|---|
| `--input` | `../DMデータ/` | 入力フォルダ（再帰検索） |
| `--epsg` | `6674` | 入力データの座標参照系。JGD2011 第6系（京都・大阪ほか） |
| `--jobs` | CPUコア数-1 | 並列数。`1` で逐次実行 |

### 出力ファイル

`output/` に5ファイルが生成されます。出力はすべて EPSG:4326（WGS84 / 緯度経度）です。

| ファイル名 | 内容 |
|---|---|
| `道路台帳図_線.geojson` | 線要素（E2） |
| `道路台帳図_面.geojson` | 面要素（E1） |
| `道路台帳図_記号.geojson` | 記号・点要素（E5） |
| `道路台帳図_方向.geojson` | 方向要素（E6） |
| `道路台帳図_注記.geojson` | 注記要素（E7） |

属性の一覧は[出力仕様](docs/output-spec.md)を参照してください。並列実行は**逐次実行とバイト単位で同じGeoJSON**になります。

## 一括ビルド（GeoJSON + GeoParquet + PMTiles）

GeoJSONだけ作り直してGeoParquetやPMTilesが古いまま残ると、配信データと変換結果が食い違います。`scripts/build.sh` で最後までまとめて焼き直せます。

```bash
EPSG=6674 scripts/build.sh /path/to/DM_57-08/dm
SKIP_CONVERT=1 SKIP_PARQUET=1 scripts/build.sh   # タイルだけ焼き直す
```

DM → GeoJSON → GeoParquet（`ogr2ogr`）→ MBTiles（`tippecanoe`）→ PMTiles（`pmtiles convert`）の順に処理します。ogr2ogr / tippecanoe / pmtiles が無ければ該当する段だけスキップされます。段を飛ばす環境変数やタイル設計は[ベクトルタイルと一括ビルド](docs/build-and-tiles.md)を参照してください。

GeoJSON を作った直後に[拡張コードの点検](docs/extended-codes.md)（`npm run check:extended`）が走ります。道路台帳図には公共測量標準図式に無い自治体固有のコードが混ざり（豊中サンプルでは105コード中28コード・860件）、それを知らないまま扱うとビューワの表示が静かに劣化するためです。

## ビューワ

生成した PMTiles を表示するWebビューワを [`viewer/`](viewer/) に同梱しています（MapLibre GL JS + PMTiles）。

```bash
cd viewer
npm install
npm run dev      # → http://localhost:5175/
```

**右下の背景切替で「白図」を選ぶと背景地図が消え、道路台帳図だけが表示されます。** 線幅・破線・記号の大きさ・字高は、同梱のPDF図面（A0のベクタPDF、1:500）の実測に合わせてあり、記号と文字は**地上サイズ固定**で描きます。レイヤー構成やスタイルの根拠は [viewer/README.md](viewer/README.md) を参照してください。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [道路台帳図とDMデータ](docs/dm-format.md) | 道路台帳図とは・縮尺・対応レコードタイプ・DMファイルの構造・dm-converter との違い |
| [出力仕様](docs/output-spec.md) | 出力ファイルと属性・方向（E6）と注記（E7）の扱い・標高値・座標系 |
| [ベクトルタイルと一括ビルド](docs/build-and-tiles.md) | `scripts/build.sh` の詳細・環境変数・タイル設計・最大ズームレベルの決め方 |
| [拡張コード（自治体独自コード）](docs/extended-codes.md) | 点検スクリプト・拡張DMの提供元の指定・既存アイコンでの代替 |
| [ビューワ](viewer/README.md) | 同梱のWebビューワの機能・線幅と破線・アイコン・角度・帰属表示 |
| [検証](docs/verification.md) | シェープファイル版との突き合わせ・PDF図面との全数照合／実測／ラスタ差分 |
| [利用上の注意](docs/legal.md) | 測量法上の扱い・豊中市データの使用承認・ライセンス |

## ディレクトリ構成

```
dm-road-ledger-converter/
├── src/                  # 変換プログラム（エントリポイントは index.js）
├── docs/                 # 詳細ドキュメント
├── scripts/
│   ├── build.sh                  # GeoJSON + GeoParquet + PMTiles の一括生成
│   ├── check-extended-codes.mjs  # 拡張コードの点検（npm run check:extended）
│   ├── standard-codes.mjs        # 標準コード表の読み口（標準か拡張かの判定）
│   ├── reconcile-pdf.py          # PDF図面と変換結果の全数照合（地物の有無）
│   ├── measure-pdf.py            # PDF図面の実測（線幅・破線・記号の大きさ・字高）
│   ├── raster-diff.py            # ビューワの描画結果とPDF図面のラスタ差分
│   └── geojson2parquet.py        # GeoParquet変換（ogr2ogr が使えない環境向け）
├── viewer/               # PMTiles を表示するWebビューワ（Vite + MapLibre）
├── data/                 # 検証用データ（豊中市サンプル）。Git管理対象外
└── output/               # 変換結果。Git管理対象外
```

## 留意事項

- **DMデータは測量法に基づく公共測量成果です。** 複製・使用には原則として道路管理者の承認が必要です。`data/` と `output/` は `.gitignore` で除外しており、リポジトリにDM原本は含めていません。
- **デモとリポジトリで使用している豊中市データは、測量法第44条の使用承認（豊基管第304号／2026年8月27日）に基づいています。** この承認は申請者に与えられたもので、本リポジトリの利用者に及ぶものではありません。同じデータを使う場合は別途申請が必要です。成果品には次の文言を明示します（**承認書の指定なので言い換えません**）。

  > 測量法に基づく豊中市長承認（使用）R8 豊基管第304号

- 対応しているのは E1（面）・E2（線）・E5（記号）・E6（方向）・E7（注記）です。E3（円）・E4（円弧）・E8（属性）は出力せず、含まれていた場合は件数を警告します。
- **座標オフセットの単位はミリメートル**です。地図情報レベル2,500・10,000のDMは [dm-converter](https://github.com/shiwaku/dm-converter) を使ってください。
- 出力される属性はすべて文字列型です（`Angle` も `"86"` のような文字列）。

詳細は[利用上の注意](docs/legal.md)を参照してください。

## ライセンス

[Apache License 2.0](LICENSE)

Copyright 2026 Yohei Shiwaku

**対象は変換プログラムとビューワです。入力するDMデータおよび変換結果には適用されません。**

## 参考文献

- 国土交通省「[公共測量標準図式](https://psgsv2.gsi.go.jp/koukyou/public/sagyoukitei/index.html)」
- 豊中市「[豊中市道路台帳平面図DM500](https://www.city.toyonaka.osaka.jp/machi/doro/daityou/digitalmap/hajimeni.html)」
- Geolonia「道路台帳図カスタムタイル仕様書（案）」（`geolonia/smartcity-smartmap-custom-tiles-spec`）— 道路台帳図の定義・縮尺・最大ズームレベルの考え方はこの仕様書に整合させています
