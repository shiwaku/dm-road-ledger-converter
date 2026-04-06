# road-ledger plan-dm-converter

## プロジェクト概要

道路台帳DMデータ（*.dm / *.DM）をGeoJSON形式に変換するプロジェクト。
`city-plan-dm-converter-main` をベースに、道路台帳用途で利用している。

## ディレクトリ構成

```
road-ledger plan-dm-converter/
├── CLAUDE.md
├── DMデータ/                        # 変換対象のDMデータ（*.dm / *.DM のみ）
│   ├── 1028中讃土木DMデータ/
│   ├── 1028西讃土木DMデータ/
│   ├── 1028高松土木DMデータ/
│   └── 道路台帳DMデータ/
└── city-plan-dm-converter/          # 変換ツール本体
    ├── index.js
    ├── dm.js
    ├── dmfiles.js
    ├── geojsonWriter.js
    ├── epsgDefs.js
    └── package.json
```

## DMデータの管理ルール

- `DMデータ/` フォルダには `*.dm` / `*.DM` ファイルのみ保持する
- `旧データ` フォルダは不要のため削除済み
- `PDFデータ` フォルダは不要のため削除済み
- `.pdf`, `.tif`, `.sfc`, `.idx`, `.DMI`, `.txt`, `.db` 等は削除済み

## 変換ツールの使い方

```bash
cd city-plan-dm-converter-main
npm install

# 基本実行（縮尺1/2500、EPSG:6676）
node index.js

# 入力フォルダを直接指定
node index.js --scale 2500 --input /path/to/dm_folder

# 座標系を指定（四国4県 = 第4系 EPSG:6672）
node index.js --epsg 6672 --input /path/to/dm_folder
```

## 座標系

入力データの座標系に合わせて `--epsg` を指定する。

## 出力

`output/` フォルダに以下のGeoJSONが生成される：

| ファイル名 | 内容 |
|---|---|
| `都市計画基本図_<縮尺>_線.geojson` | 線要素（E2） |
| `都市計画基本図_<縮尺>_面.geojson` | 面要素（E1） |
| `都市計画基本図_<縮尺>_記号.geojson` | 記号・点要素（E5） |
| `都市計画基本図_<縮尺>_注記.geojson` | 注記要素（E7） |
