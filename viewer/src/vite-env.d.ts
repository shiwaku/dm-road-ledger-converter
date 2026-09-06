/// <reference types="vite/client" />

/** vite.config.ts の define で埋め込まれるビルド時刻。 */
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  /** PMTiles の配信元。未指定なら自分自身が配信する public/road_ledger.pmtiles を使う（src/layers.ts を参照）。 */
  readonly VITE_PMTILES_BASE?: string
  /**
   * 拡張DMコードのアイコンを引く提供元。カンマ区切りで優先順（例: `toyonaka`）。
   * 未指定なら同梱の検証データに合わせた `ext1,toyonaka`。空にすると標準図式の
   * アイコンだけを使う（src/basemap.ts を参照）。
   */
  readonly VITE_DM_PROVIDERS?: string
  /**
   * 表示中のデータに付ける承認・出典の文言（帰属コントロールと脚注に出る）。
   * 未指定なら同梱の検証データの承認番号。別のデータを表示するときは上書きするか
   * 空にする（src/layers.ts の DATA_ATTRIBUTION を参照）。
   */
  readonly VITE_DM_ATTRIBUTION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
