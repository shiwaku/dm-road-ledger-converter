/// <reference types="vite/client" />

/** vite.config.ts の define で埋め込まれるビルド時刻。 */
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  /** PMTiles の配信元。未指定なら自分自身が配信する public/road_ledger.pmtiles を使う（src/layers.ts を参照）。 */
  readonly VITE_PMTILES_BASE?: string
  /**
   * 拡張DMコードのアイコンを引く提供元。カンマ区切りで優先順（例: `toyonaka`）。
   * 未指定なら標準図式のアイコンだけを使う（src/basemap.ts を参照）。
   */
  readonly VITE_DM_PROVIDERS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
