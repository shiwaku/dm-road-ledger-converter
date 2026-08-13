// -----------------------------------------
// レイヤー定義
//
// 色・スプライト・角度の扱いは dm-converter の viewer/src/layers.ts に合わせている。
// 白図（黒線）を基本とし、ダークテーマでは線・文字を明色へ入れ替える。
//
// 分類コードごとの線種・線幅の描き分けは行っていない。道路台帳図の分類コードは
// 自治体・測量ベンダーによって運用が異なり、全国共通の図式として確定していないため。
// 記号・方向のアイコンは公共測量標準図式のコードと共通なので、スプライトが持っている
// コードはアイコンで描き、無いコードだけ代替図形（丸・矢印）で位置と向きを示す。
// -----------------------------------------
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl'
import { DM_SPRITE_ID } from './basemap'
import type { Theme } from './theme'

export const SOURCE_ID = 'road-ledger'

/**
 * PMTiles の配信元。既定は自分自身が配信する `public/road_ledger.pmtiles`
 * （`npm run copy:tiles` が output/ から複製する）。
 * 別の配信先を見たい場合は `VITE_PMTILES_BASE` で差し替える。
 *   VITE_PMTILES_BASE=http://localhost:8787 npm run dev
 */
const PMTILES_BASE = import.meta.env.VITE_PMTILES_BASE

/**
 * PMTiles の実URL。`base: './'` でビルドすると BASE_URL が相対になるため、
 * 表示中のページを基準に絶対URLへ解決する（`pmtiles://` は相対URLを解せない）。
 */
export const TILES_HREF = PMTILES_BASE
  ? `${PMTILES_BASE.replace(/\/$/, '')}/road_ledger.pmtiles`
  : new URL(`${import.meta.env.BASE_URL}road_ledger.pmtiles`, location.href).href

export const SOURCES: Record<string, SourceSpecification> = {
  [SOURCE_ID]: {
    type: 'vector',
    url: `pmtiles://${TILES_HREF}`,
  },
}

// ---- グループ（パネルのトグル単位） ----

export type GroupKey = 'polygon' | 'line' | 'symbol' | 'direction' | 'annotation'

export interface LayerGroup {
  key: GroupKey
  name: string
  desc: string
  on: boolean
  opacity: number
}

/** 配列の順序がパネルの並び順。 */
export const GROUPS: LayerGroup[] = [
  {
    key: 'polygon',
    name: '面',
    desc: 'DMの面要素（E1）。始終点が一致する線要素も面として出力される。分類コードごとの描き分けはしていない。',
    on: true,
    opacity: 1,
  },
  {
    key: 'line',
    name: '線',
    desc: 'DMの線要素（E2）。道路縁・区域界など。分類コードごとの線種・線幅の描き分けはしていない。等高線（71xx）は標高値を線に沿って表示する。',
    on: true,
    opacity: 1,
  },
  {
    key: 'symbol',
    name: '記号',
    desc: 'DMの記号要素（E5）。公共測量標準図式の分類コード（4桁）をキーにスプライトのアイコンを表示する。アイコンが無いコードは丸で位置を示す。標高点（7311・7312）は標高値を数値で併記する。z17以上で表示。',
    on: true,
    opacity: 1,
  },
  {
    key: 'direction',
    name: '方向',
    desc: 'DMの方向要素（E6）。分類コードのアイコンを角度属性に従って回転させる。アイコンが無いコードは矢印で向きを示す。標高点（7311・7312）はこの方向要素として記録されることがあり、標高値を数値で併記する。1要素に複数ペアが入るため、ペアごとに1地物として出力している（Seq で区別）。z17以上で表示。',
    on: true,
    opacity: 1,
  },
  {
    key: 'annotation',
    name: '注記',
    desc: 'DMの注記要素（E7）。文字列を代表点に配置し、角度属性に従って回転させる。z17以上で表示。',
    on: true,
    opacity: 1,
  },
]

export const groupOf = (key: GroupKey): LayerGroup => GROUPS.find((g) => g.key === key)!

// ---- テーマ連動のインク色 ----
// dm-converter の inkFor と同じ値。道路台帳図も白図（黒線）が既定だが、暗い背景では
// そのままだと埋もれるため、テーマに応じて線・文字・縁取りの色を入れ替える。
export interface Ink {
  line: string
  text: string
  halo: string
  fill: string
}

export const inkFor = (theme: Theme): Ink =>
  theme === 'dark'
    ? { line: '#e8eaee', text: '#f2f4f7', halo: '#14161a', fill: '#ffffff' }
    : { line: '#000000', text: '#000000', halo: '#ffffff', fill: '#ffffff' }

// ---- レイヤー定義 ----

export interface LayerEntry {
  group: GroupKey
  spec: LayerSpecification
  /** 不透明度スライダーで操作する paint プロパティと、その基準値。 */
  opacity: Record<string, number>
}

/**
 * 記号・方向・注記はタイル生成時に ZL17 未満を除外している
 * （scripts/build.sh の SYMBOL_MIN_ZOOM 等）。表示側の minzoom もそれに揃える。
 */
const DETAIL_MINZOOM = 17

/**
 * 注記・方向に使うフォントスタック。地理院の最適化ベクトルタイルのグリフには
 * NotoSansJP-Regular しか無いため、明示しないと MapLibre 既定の
 * "Open Sans Regular, Arial Unicode MS Regular" を要求して404になり、文字が描画されない。
 */
const TEXT_FONT = ['NotoSansJP-Regular']

/**
 * アイコンが無い方向要素に使う矢印。NotoSansJP-Regular に字形があるものから選ぶ必要がある。
 * `➤`（U+27A4）は同フォントに無く、要求しても描画されない（グリフ範囲は配信されるが
 * 字形が入っていないため無音で消える）。`▶`（U+25B6）は入っている。
 */
const DIRECTION_ARROW = '▶'

/**
 * 方向（E6）の回転角。
 *
 * DMの角度は「水平右（東）を0度とする反時計回り」。スプライトのアイコンは右（東）向きに
 * 描かれており、MapLibre の icon-rotate は時計回りのため、符号を反転するだけでよい。
 * 代替の矢印（▶）も右向きなので同じ式を使う。
 */
const ICON_ROTATE = ['*', -1, ['coalesce', ['to-number', ['get', 'Angle']], 0]]

/**
 * 注記（E7）の回転角。dm-converter の viewer と同じ式。
 *
 * 角度の読み替えは方向と同じで符号反転。ただし ±90 度のときだけ 0 に倒す。
 * 豊中市サンプル（図郭57-08）では ±90 度の注記29件すべてが縦横フラグ=1（縦書き）で、
 * 角度 ±90 は「文字列を寝かせる」指示ではなく縦書きの表現だった。符号反転してそのまま
 * 回すと、縦書きのはずの注記が横倒しの文字列として出る。
 *
 * MapLibre で本来の縦書き（文字を縦に積む）を出すには text-writing-mode が必要だが、
 * データ駆動にできず、そもそも縦横フラグがタイルに載っていない（build.sh の TILE_ATTRS は
 * Code / Text / Angle のみ）。そのため横書きとして描いている。
 */
const TEXT_ROTATE = [
  'let',
  'a',
  ['coalesce', ['to-number', ['get', 'Angle']], 0],
  [
    'case',
    ['any', ['==', ['var', 'a'], 90], ['==', ['var', 'a'], -90]],
    0,
    ['*', -1, ['var', 'a']],
  ],
]

// ---- 標高値のラベル ----
//
// 標高点（7311・7312）と等高線（71xx）の標高は、注記（E7）ではなくEレコードの
// 標高値フィールドに入っている。コンバーターが `Elev`（メートル）として出力し、
// build.sh が TILE_ATTRS でタイルに載せている。ここで数値ラベルとして描く。
// 属性が無いタイル（`Elev` を載せる前に焼いたもの）ではフィルタで全件落ちるだけで、
// エラーにはならない。

/** 標高値を持つ地物だけを対象にするフィルタ。 */
const HAS_ELEV = ['all', ['has', 'Elev'], ['!=', ['get', 'Elev'], '']]

/** 標高値のラベル文字列。`27.3` のように出す。 */
const ELEV_LABEL = ['to-string', ['get', 'Elev']]

// ---- 記号の大きさの補正 ----
//
// dm-sprite のアイコンはすべて 64x64 のキャンバスだが、実際に描画されている領域
// （bbox）はアイコンごとに 4.4px〜64px とばらつく。icon-size は全コード共通なので、
// bbox が小さいアイコンだけが小さく見える。
//
// dm-sprite 自身の設計基準は bbox 10〜22px（同リポジトリの tools/gen_icons.py）。
// これを下回るものだけを目標サイズへ引き上げ、基準内のアイコンには手を入れない。
// 一律に icon-size を上げると、bbox の大きいアイコンが過大になるため。
//
// bbox の実測値と補正の方針は dm-converter の viewer/src/layers.ts と同じ。
// スプライトを更新したら測り直すこと（dm-sprite の tools/inspect_icons.py）。

/** 補正後の目標 bbox。dm-sprite の設計基準 10〜22px の中央値。 */
const ICON_TARGET_PX = 18.56

/**
 * 設計基準（10px）を下回るアイコンのうち、目標サイズへ引き上げるものの実測 bbox。
 *
 * 基準を下回っていても補正しないものがある。いずれも図式上そもそも小さく描く記号で、
 * 基準の中央値まで引き上げると大きすぎた。
 *   7311 標石を有しない標高点（4.44px）
 *   7312 図化機測定による標高点（4.44px）
 *   8199 指示点（5.94px）
 *   2238 並木（6.19px）
 * 標高点と指示点は数値注記と組で読む点記号で、記号そのものを目立たせる必要がない。
 */
const ICON_BBOX_PX: Record<string, number> = {
  '3401': 6.19, // 門
  '5226': 9.31, // 滝
  '6311': 9.94, // 田
  '6331': 9.94, // 広葉樹林
  '6340': 9.94, // 砂れき地（未分類）
}

/** 分類コードから記号の大きさの補正倍率を引く式。補正しないコードは 1.0。 */
const iconScale = (): unknown[] => {
  const match: unknown[] = ['match', ['to-string', ['get', 'Code']]]
  for (const [code, bbox] of Object.entries(ICON_BBOX_PX)) {
    match.push(code, Math.round((ICON_TARGET_PX / bbox) * 100) / 100)
  }
  match.push(1.0)
  return match
}

const iconSize = (z1: number, s1: number, z2: number, s2: number): unknown[] => [
  'interpolate',
  ['linear'],
  ['zoom'],
  z1,
  ['*', s1, iconScale()],
  z2,
  ['*', s2, iconScale()],
]

/** 分類コードからスプライトのアイコン名を組み立てる式。 */
const ICON_IMAGE = ['concat', `${DM_SPRITE_ID}:dm-`, ['to-string', ['get', 'Code']]]

/**
 * スプライトにアイコンがあるコードかどうかのフィルタ。
 * アイコンのあるコードはアイコンで、無いコードは代替図形で描き分けるため、
 * 同じソースレイヤーを排他フィルタの2レイヤーで受け持つ。
 */
const hasIcon = (codes: Set<string>): unknown[] => [
  'in',
  ['to-string', ['get', 'Code']],
  ['literal', [...codes]],
]
const lacksIcon = (codes: Set<string>): unknown[] => ['!', hasIcon(codes)]

/**
 * 描画順に並べたレイヤー定義。
 *
 * @param theme  線・文字の色をテーマで入れ替えるため
 * @param spriteCodes  スプライトが持っている分類コード（basemap.ts の loadSpriteCodes）
 */
export function buildLayers(theme: Theme, spriteCodes: Set<string>): LayerEntry[] {
  const ink = inkFor(theme)
  return [
    {
      group: 'polygon',
      opacity: { 'fill-opacity': 0.25 },
      spec: {
        id: 'road_polygon_fill',
        type: 'fill',
        source: SOURCE_ID,
        'source-layer': 'road_polygon',
        paint: { 'fill-color': ink.fill, 'fill-opacity': 0.25 },
      },
    },
    {
      group: 'polygon',
      opacity: { 'line-opacity': 1 },
      spec: {
        id: 'road_polygon_outline',
        type: 'line',
        source: SOURCE_ID,
        'source-layer': 'road_polygon',
        paint: { 'line-color': ink.line, 'line-width': 0.8, 'line-opacity': 1 },
      },
    },
    {
      group: 'line',
      opacity: { 'line-opacity': 1 },
      spec: {
        id: 'road_line',
        type: 'line',
        source: SOURCE_ID,
        'source-layer': 'road_line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ink.line,
          // 引いたときに潰れないよう、ズームに応じて細くする
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 18, 1.4],
          'line-opacity': 1,
        },
      },
    },
    // 等高線（71xx）の標高値。線に沿って置く。
    {
      group: 'line',
      opacity: { 'text-opacity': 1 },
      spec: {
        id: 'road_line_elev',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_line',
        minzoom: DETAIL_MINZOOM,
        filter: HAS_ELEV as never,
        layout: {
          'text-field': ELEV_LABEL as never,
          'text-font': TEXT_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 9, 20, 12],
          'symbol-placement': 'line',
          // 等高線のラベルは間引かないと重なって読めなくなるため、衝突判定に任せる
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': ink.text,
          'text-halo-color': ink.halo,
          'text-halo-width': 1.4,
          'text-opacity': 1,
        },
      },
    },
    // 記号 — アイコンが無いコードは丸で位置だけ示す
    {
      group: 'symbol',
      opacity: { 'circle-opacity': 1, 'circle-stroke-opacity': 1 },
      spec: {
        id: 'road_symbol_dot',
        type: 'circle',
        source: SOURCE_ID,
        'source-layer': 'road_symbol',
        minzoom: DETAIL_MINZOOM,
        filter: lacksIcon(spriteCodes) as never,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 17, 2, 20, 4],
          'circle-color': ink.fill,
          'circle-opacity': 1,
          'circle-stroke-color': ink.line,
          'circle-stroke-width': 0.8,
          'circle-stroke-opacity': 1,
        },
      },
    },
    {
      group: 'symbol',
      opacity: { 'icon-opacity': 1 },
      spec: {
        id: 'road_symbol_icon',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_symbol',
        minzoom: DETAIL_MINZOOM,
        filter: hasIcon(spriteCodes) as never,
        layout: {
          'icon-image': ICON_IMAGE as never,
          'icon-size': iconSize(17, 0.6, 20, 1.2) as never,
          // 測量成果として決まった位置に置かれるものなので、衝突判定で間引かせず全部描く
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 1 },
      },
    },
    {
      group: 'symbol',
      opacity: { 'text-opacity': 1 },
      spec: {
        id: 'road_symbol_elev',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_symbol',
        minzoom: DETAIL_MINZOOM,
        filter: HAS_ELEV as never,
        layout: {
          'text-field': ELEV_LABEL as never,
          'text-font': TEXT_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 9, 20, 12],
          // 記号に重ならないよう右上へずらす
          'text-anchor': 'left',
          'text-offset': [0.6, -0.6],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': ink.text,
          'text-halo-color': ink.halo,
          'text-halo-width': 1.4,
          'text-opacity': 1,
        },
      },
    },
    // 方向 — アイコンが無いコードは矢印で向きだけ示す
    {
      group: 'direction',
      opacity: { 'text-opacity': 1 },
      spec: {
        id: 'road_direction_arrow',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_direction',
        minzoom: DETAIL_MINZOOM,
        filter: lacksIcon(spriteCodes) as never,
        layout: {
          'text-field': DIRECTION_ARROW,
          'text-font': TEXT_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 20, 16],
          'text-rotate': ICON_ROTATE as never,
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': ink.text,
          'text-halo-color': ink.halo,
          'text-halo-width': 1,
          'text-opacity': 1,
        },
      },
    },
    {
      group: 'direction',
      opacity: { 'icon-opacity': 1 },
      spec: {
        id: 'road_direction_icon',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_direction',
        minzoom: DETAIL_MINZOOM,
        filter: hasIcon(spriteCodes) as never,
        layout: {
          'icon-image': ICON_IMAGE as never,
          'icon-size': iconSize(17, 0.6, 20, 1.2) as never,
          'icon-rotate': ICON_ROTATE as never,
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 1 },
      },
    },
    {
      group: 'direction',
      opacity: { 'text-opacity': 1 },
      spec: {
        id: 'road_direction_elev',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_direction',
        minzoom: DETAIL_MINZOOM,
        filter: HAS_ELEV as never,
        layout: {
          'text-field': ELEV_LABEL as never,
          'text-font': TEXT_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 9, 20, 12],
          // 記号に重ならないよう右上へずらす
          'text-anchor': 'left',
          'text-offset': [0.6, -0.6],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': ink.text,
          'text-halo-color': ink.halo,
          'text-halo-width': 1.4,
          'text-opacity': 1,
        },
      },
    },
    {
      group: 'annotation',
      opacity: { 'text-opacity': 1 },
      spec: {
        id: 'road_annotation',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_annotation',
        minzoom: DETAIL_MINZOOM,
        layout: {
          'text-field': ['coalesce', ['get', 'Text'], ''] as never,
          'text-font': TEXT_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 20, 14],
          // 注記（E7）の代表点は文字列の書き出し位置。既定の center だと文字列長の
          // 半分だけ西へずれる（豊中サンプルの横書き39件で、PDF図面の文字列左端との
          // 東西差が中央値0.32m、中央との差が7.28m）。左端合わせにして図面に揃える。
          // 回転はアンカー基準なので、角度付きの注記もそのまま合う。
          // 複数行（￥を改行にしたもの）は text-justify の既定が center で行が
          // 中央揃えになるため、左揃えも明示する。
          'text-anchor': 'left',
          'text-justify': 'left',
          'text-rotate': TEXT_ROTATE as never,
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-max-width': 20,
        },
        paint: {
          'text-color': ink.text,
          'text-halo-color': ink.halo,
          'text-halo-width': 1.4,
          'text-opacity': 1,
        },
      },
    },
  ]
}

// ---- ポップアップ ----

/** DMの属性の日本語見出し。 */
const ATTR_LABELS: Record<string, string> = {
  Code: '分類コード',
  Elno: '要素識別番号',
  RecordType: 'レコードタイプ',
  DataType: 'データタイプ',
  DataKind: '実データ区分',
  Text: '注記文字列',
  Vnflag: '縦横フラグ',
  Angle: '角度',
  Seq: 'ペア番号',
  Scale: '縮尺',
  Elev: '標高値（m）',
}

/** ポップアップに出す属性の並び順。ここに無いものは後ろにまとめる。 */
export const PROP_ORDER = [
  'Code',
  'Text',
  'Elev',
  'Angle',
  'Seq',
  'Elno',
  'Scale',
  'RecordType',
  'DataType',
  'DataKind',
  'Vnflag',
]

/** ポップアップに並べる1件分。クリック地点で重なっている地物ごとに1つ。 */
export interface PopupItem {
  groupName: string
  props: Record<string, unknown>
}

/** 1回のクリックで表示する地物数の上限。これを超えた分は件数だけ知らせる。 */
export const POPUP_MAX_ITEMS = 20

/** 注記文字列に < などが含まれてもポップアップが壊れないようにする。 */
const escapeHtml = (v: unknown): string =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const orderOf = (key: string): number => {
  const i = PROP_ORDER.indexOf(key)
  return i < 0 ? PROP_ORDER.length : i
}

/**
 * クリック時のポップアップ本文。重なっている地物をすべて並べる。
 * 地物が1件なら見出しはグループ名、複数なら件数を出す。
 *
 * 分類コードに名称は併記しない。道路台帳図の分類コードは自治体・測量ベンダーに
 * よって運用が異なり、全国共通の対応表が無いため（基本図ビューワとの差はここだけ）。
 */
export function popupHtml(items: PopupItem[], total = items.length): string {
  const row = (label: string, value: unknown): string =>
    `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`

  const section = (item: PopupItem): string => {
    const { groupName, props } = item
    const parts = Object.entries(props)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .sort(([a], [b]) => orderOf(a) - orderOf(b))
      .map(([k, v]) => row(ATTR_LABELS[k] ?? k, v))
    // 複数件のときだけ、どの地物かを見出しで示す。
    const code =
      props.Code === undefined || props.Code === '' ? '' : ` — ${escapeHtml(props.Code)}`
    const head =
      items.length > 1 ? `<h4 class="pop-item-head">${escapeHtml(groupName)}${code}</h4>` : ''
    return `<section class="pop-item">${head}<table class="pop-tbl">${parts.join('')}</table></section>`
  }

  const head =
    items.length > 1
      ? `${total}件の地物${total > items.length ? `（うち${items.length}件を表示）` : ''}`
      : escapeHtml(items[0]?.groupName ?? '')
  return `<div class="pop"><div class="pop-head">${head}</div><div class="pop-body">${items
    .map(section)
    .join('')}</div></div>`
}
