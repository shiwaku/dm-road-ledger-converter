# dm-road-ledger-converter

## プロジェクト概要

道路台帳平面図のDMデータ（`*.dm` / `*.DM`）をGeoJSONに変換するツール。
線・面・記号・方向・注記の5種類に分割して出力する。

都市計画基本図向けの [dm-converter](https://github.com/shiwaku/dm-converter) の派生。
道路台帳は地図情報レベル500で、座標値の単位や含まれる地物が基本図と異なるため分離している。

## もっとも重要な注意点

**座標オフセットの単位はミリメートル（`/1000`）** で、dm-converter のセンチメートル（`/100`）と異なる。
入れ替えて使うと座標が10倍ずれる。単位を変更するときは、必ず図郭サイズと
座標オフセットの実測で裏を取ること（README「dm-converter との違い」に実測表がある）。

## ディレクトリ構成

```
dm-road-ledger-converter/
├── src/
│   ├── index.js          エントリポイント（引数解釈・逐次実行）
│   ├── convert.js        変換ループ（逐次とワーカーで共用）
│   ├── parallel.js       ワーカーへの分割と断片の連結
│   ├── worker.js         並列変換のワーカー
│   ├── dm.js             DMファイルの解析
│   ├── dmfiles.js        .dm ファイルの再帰検索
│   ├── geojsonWriter.js  GeoJSON出力
│   └── epsgDefs.js       平面直角座標系の定義
├── scripts/
│   ├── build.sh              GeoJSON + GeoParquet + PMTiles の一括生成
│   └── geojson2parquet.py    GeoParquet変換（ogr2ogr が使えない環境向け）
├── docs/
│   ├── 検証データ調査.md
│   └── 豊中市DM500入手手順.md
├── viewer/               PMTiles を表示するWebビューワ（MapLibre GL JS + Vite）
│   ├── src/main.ts           地図初期化・パネルUI・イベント配線
│   ├── src/layers.ts         ソース定義・レイヤー定義・ポップアップ
│   ├── src/basemap.ts        背景地図（淡色/標準/写真/白図）とダーク化
│   ├── src/theme.ts          テーマの判定と保存
│   └── public/               地理院スタイル（pale/std）・PWA・複製されたタイル
├── data/                 検証用データ（.gitignore）
└── output/               変換結果（.gitignore）
```

ビューワは dm-converter の `viewer/` に揃えている。UI・テーマ・背景地図・PWA だけでなく、
**色（白図＝黒線／ダークで明色）・記号スプライト（dm-sprite）・角度の読み替え（符号反転）も同じ**。
向こうを直したらこちらにも同じ修正が要るか確認する。逆も同じ。

揃えていないのは2点だけ。いずれも道路台帳図の分類コードが自治体ごとに違うことに由来する。
1. 線・面の分類コード別の線種・線幅（公共測量標準図式の20パターン）を持たない
2. ポップアップに分類コード名称を併記しない

加えて、記号・方向はスプライトにアイコンが無いコードを代替図形（丸・矢印）で描く。
豊中サンプルでは記号1,210件中267件、方向1,473件中695件がこちらに回る。

## 使い方

```bash
npm install

# ../DMデータ/ を再帰検索して変換
node src/index.js

# 入力フォルダと座標系を指定
node src/index.js --epsg 6674 --input /path/to/dm_dir

# 逐次実行（並列との一致確認に使う）
node src/index.js --jobs 1 --input /path/to/dm_dir

# GeoJSON + GeoParquet + PMTiles を一括生成
EPSG=6674 scripts/build.sh /path/to/dm_dir
```

縮尺は指定しない。Mレコードから自動取得し `Scale` 属性に入れる。

## 検証用データ

| データ | 場所 | 用途 |
|---|---|---|
| 豊中市サンプル（図郭57-08） | `data/` | 道路台帳の実データ。**シェープファイル版が同梱**され突き合わせできる。EPSG:6674 |
| リポジトリ外のDMデータ | — | **検証に使わない。** そこから得た件数・統計も、リポジトリのコード・ドキュメントに一切載せない（[docs/検証データ調査.md](docs/検証データ調査.md)） |
| 静岡市 都市計画基本図 | `../dm-converter/input/` | dm-converter 用。**単位がセンチメートルなので本ツールでは正しく変換できない** |

豊中市サンプルは[市の公開ページ](https://www.city.toyonaka.osaka.jp/machi/doro/daityou/digitalmap/sanple.html)から無償で入手できる。

## 変更時に必ず確認すること

1. **逐次と並列がバイト単位で一致するか**
   ```bash
   node src/index.js --jobs 1 --input <dir> && cp output/*.geojson /tmp/seq/
   node src/index.js --jobs 4 --input <dir> && cp output/*.geojson /tmp/par/
   for f in /tmp/seq/*.geojson; do cmp "$f" "/tmp/par/$(basename "$f")"; done
   ```
2. **豊中サンプルの件数が変わっていないか** — 線2,647／面400／記号1,210／方向1,473／注記95
3. **シェープファイル版との突き合わせ** — `data/.../SHP_5708/shp` と分類コード単位で比較する

## 実装上の勘所

- **E6（方向）は1要素に複数ペアが入る。** ペアごとに1フィーチャとして出し、`Seq` で区別する。
  先頭ペアだけ読むと豊中サンプルで198本（13.4%）を取りこぼす
- **実データ区分 `6` も三次元**（21バイト/点・4点/レコード）。`3` だけを三次元扱いにしない
- **注記の文字コードは作成元により異なる。** 全角スペース（`0x21`）埋めの痕跡がある場合のみ
  JIS X 0208（7bit）として扱う。推測でJIS判定すると `1?` が `運` になるような誤変換が起きる
- 注記に含まれる `￥`（JIS `216F`）は改行マーカー。未処理のまま出力している
- `recno` はループ内で進めず、ヘッダ位置から `recordcnt + 1` で確定させる
- **ビューワの文字はグリフに字形があるものしか描けない。** 地理院の最適化ベクトルタイルの
  グリフに入っているフォントは `NotoSansJP-Regular` だけ。`text-font` を明示しないと
  MapLibre 既定の `Open Sans Regular` を要求して404になる。代替矢印も同フォントに字形がある
  `▶`（U+25B6）を使う。`➤`（U+27A4）はグリフ範囲は200で返るが字形が無く、無音で消える
- **スプライトに無い分類コードをそのまま `icon-image` で要求すると地物が黙って消える。**
  道路台帳図には図式に無い自治体固有コードが混ざる。起動時に `sprite.json` を読んで
  アイコンの有無でレイヤーを2つに振り分け、無い側は丸・矢印で位置と向きを出す
- **標高値はEレコードの50〜56桁（ミリメートル）にあり、注記（E7）ではない。**
  同じ位置の意味が分類コードで変わるため、`convert.js` の `ELEV_CODES`（等高線71xx・
  標高点7311/7312）に限って `Elev`（メートル）として出す。`7304`・`7306`（基準点）は
  点番号が入る（DM `3013400` ⇔ SHP版の点番号 `30134`）。`7311` は豊中サンプルでは
  70件すべて0で、DMに標高が無い。**0は未記録として出さない**（出すと標高0が並ぶ）
- **注記の角度 ±90 は縦書き（縦横フラグ=1）の表現。** 豊中サンプルでは ±90 の注記29件が
  すべてフラグ1だった。符号反転してそのまま回すと横倒しの文字列になるため、基本図ビューワ
  と同じく 0 に倒す。方向（E6）は符号反転だけで倒さない

## 関連

- [dm-converter](https://github.com/shiwaku/dm-converter) — 都市計画基本図向けの本家
- [dm-converter#46](https://github.com/shiwaku/dm-converter/issues/46) — E6の取りこぼしを起票済み
