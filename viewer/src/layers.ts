// -----------------------------------------
// レイヤー定義
//
// 色・スプライト・角度の扱いは dm-converter の viewer/src/layers.ts に合わせている。
// 白図（黒線）を基本とし、ダークテーマでは線・文字を明色へ入れ替える。
//
// 分類コードごとの線種・線幅は、同梱のPDF図面（DM-_57-08.pdf、1:500）の実測で決めている。
// 図式の書物ではなく図面そのものを基準にしたのは、道路台帳図の分類コードが自治体・測量
// ベンダーによって運用が異なり、全国共通の図式として確定していないため（LINE_STYLES）。
// 記号・方向のアイコンは公共測量標準図式のコードと共通なので、スプライトが持っている
// コードはアイコンで描き、無いコードだけ代替図形（丸）で位置を示す。
// -----------------------------------------
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl'
import { DM_SPRITE_ID } from './basemap'
import { codeName } from './dmCodes'
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

/**
 * 道路台帳図データの帰属表示。
 *
 * **背景地図ではなくデータ側に付ける。** 白図（`blankStyle`）は `sources: {}` で
 * 帰属を持つソースが1つも無いため、ここが無いと表示する文字列が空になり、
 * MapLibre が帰属コントロールごと隠す（`maplibregl-attrib-empty`）。
 * 右下の ⓘ が背景を切り替えたときだけ消える、という挙動になっていた。
 *
 * 出典の具体名（自治体名）は入れない。表示するPMTilesは利用者が
 * `scripts/build.sh` で焼いたもので、どのデータかはここでは分からないため。
 * パネル下部の脚注に利用条件を書いてある。
 */
const ATTRIBUTION =
  '道路台帳平面図（DM） / ' +
  '<a href="https://github.com/shiwaku/dm-road-ledger-converter" target="_blank" rel="noopener">dm-road-ledger-converter</a>'

export const SOURCES: Record<string, SourceSpecification> = {
  [SOURCE_ID]: {
    type: 'vector',
    url: `pmtiles://${TILES_HREF}`,
    attribution: ATTRIBUTION,
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
    desc: 'DMの面要素（E1）。始終点が一致する線要素も面として出力される。輪郭は線と同じ図面実測の線種・線幅で描く。PDF図面は面を塗らないので既定では塗りつぶさない。',
    on: true,
    opacity: 1,
  },
  {
    key: 'line',
    name: '線',
    desc: 'DMの線要素（E2）。道路縁・区域界など。分類コードごとの線幅と破線は、同梱のPDF図面（1:500）の実測に合わせている。等高線（71xx）は標高値を線に沿って表示する。',
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
    desc: 'DMの方向要素（E6）。分類コードのアイコンを角度属性に従って回転させる。アイコンが無いコードは丸で位置を示す（角度はポップアップで確認できる）。標高点（7311・7312）はこの方向要素として記録されることがあり、標高値を数値で併記する。1要素に複数ペアが入るため、ペアごとに1地物として出力している（Seq で区別）。z17以上で表示。',
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
 * 方向（E6）の回転角。
 *
 * DMの角度は「水平右（東）を0度とする反時計回り」。スプライトのアイコンは右（東）向きに
 * 描かれており、MapLibre の icon-rotate は時計回りのため、符号を反転するだけでよい。
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

// ---- 記号の大きさ ----
//
// dm-sprite のアイコンはすべて 64x64 のキャンバスだが、実際に描画されている領域
// （bbox）はアイコンごとに 4.4px〜64px とばらつく。icon-size は全コード共通なので、
// bbox が小さいアイコンだけが小さく見える。
//
// dm-converter の viewer はこれを分類コードごとの倍率で引き上げている（設計基準
// 10〜22px の中央値 18.56px を目標にする）。**こちらではコードごとの補正はしない。**
// ラスタのスプライトを引き伸ばすと輪郭がぼやけるうえ、図面より大きくなるため（Issue #13）。
//
// 代わりに全コード一律の倍率だけを掛ける。PDF図面（DM-_57-08.pdf）の記号49コードを
// 実測して、スプライトのインク寸法（アルファ>8 の外接矩形）と比べたところ、
// 倍率1.0では図面の 1.8倍（コード単位の中央値）／2.2倍（件数で重み付けした中央値）
// あった。0.5 を掛けると図面とほぼ同じ大きさになる。
//
//   例（図面の大きさ ← 倍率1.0での大きさ）
//     6331 広葉樹林 358件  0.91m ← 1.35m      4151      175件  1.06m ← 2.45m
//     3401 門      306件  0.65m ← 0.98m      6214      101件  1.08m ← 2.94m
//
// コードごとの比率は 0.7〜6.1倍とばらついたままで、これは dm-sprite のインクの
// 大きさが揃っていないことに由来する（dm-sprite#15）。一律倍率ではそこは直らない。
//
// 測り直しは scripts/measure-pdf.py（PDF図面の実測）と dm-sprite の
// tools/inspect_icons.py で行う。**dm-sprite が更新されたら測り直すこと。**

/** 記号・方向のアイコンに一律に掛ける倍率。PDF図面の実測に合わせる。 */
const ICON_SCALE = 0.5

// ---- 地上サイズ固定 ----
//
// 紙の図面は 1:500 で固定なので、記号や文字の「地上での大きさ」が変わらない。
// 画面ピクセル固定にすると、拡大するほど図面より小さく、縮小するほど大きくなる。
// 標高値の文字は z19 で地上1.35m、z20 で0.74m、z21 で0.37m と動いていた
// （図面は常に0.99m）。ズームを上げると小さく見えるのはこれが原因。
//
// そこで指数2の補間にして、ズーム1段ごとに画面ピクセルを倍にする。これで
// 地上サイズが不変になり、図面と同じ見え方になる。
//
// z19 の1画素は緯度34.78度で 0.1226m（MapLibre は512pxタイルなので
// 156543.03392×cos(lat)/2^z/2）。したがって 1m ＝ 8.157px。
//
// 上下は自動で頭打ちになる。MapLibre は補間の範囲外を端の値で止めるため、
// z19未満は z19 の値、z21超は z21 の値のまま。低ズームで潰れず、
// 高ズームで無限に大きくならない。

/** z19 で地上1メートルに相当する画面ピクセル数。 */
const PX_PER_M_Z19 = 8.157

/**
 * 地上 `meters` メートルを保つサイズの式。
 *
 * @param meters  図面での地上サイズ（PDF図面の実測値を使う）
 * @param floorPx 小さすぎて読めなくなるのを防ぐ下限。地上サイズより優先する
 */
const groundPx = (meters: number, floorPx = 8): number =>
  Math.max(Math.round(meters * PX_PER_M_Z19 * 10) / 10, floorPx)

const groundSize = (meters: number, floorPx = 8): unknown[] => {
  const px19 = groundPx(meters, floorPx)
  return ['interpolate', ['exponential', 2], ['zoom'], 19, px19, 21, px19 * 4]
}

/**
 * アイコンの大きさ。`icon-size` は倍率なので px ではなく倍率で書く。
 * z19 で ICON_SCALE、以降はズーム1段ごとに倍にして地上サイズを保つ。
 */
const ICON_SIZE: unknown[] = [
  'interpolate',
  ['exponential', 2],
  ['zoom'],
  19,
  ICON_SCALE,
  21,
  ICON_SCALE * 4,
]

// ---- 注記の字高 ----
//
// 分類コード別の字高はPDF図面の実測値（スパンのフォントサイズ ÷ 5.6687 pt/m）。
// 既定は建物名・ビル名などの 1.50m。
//
// **ズーム補間の中に `match` を入れること。** 逆にして `match` の各分岐に
// ズーム補間を置くと「Only one zoom-based "step" or "interpolate" subexpression
// may be used in an expression」で text-size が丸ごと弾かれ、**注記レイヤーが
// 無言で消える**（e458b54 で実際に消えていた）。線幅の SOLID_WIDTH も同じ形。

const ANNOTATION_M: [string, number][] = [
  ['8114', 2.25],   // 町丁目名
  ['8164', 1.75],
  ['8181', 0.99],
  ['8173', 0.75],   // 等高線の標高注記
  ['8144', 0.5],
]

const annotationSize = (mul: number): unknown[] => [
  'match',
  ['to-string', ['get', 'Code']],
  ...ANNOTATION_M.flatMap(([code, m]) => [code, groundPx(m) * mul]),
  groundPx(1.5) * mul,   // 8121 国道番号・8135 建物名・8136 ビル名など
]

const ANNOTATION_SIZE: unknown[] = [
  'interpolate',
  ['exponential', 2],
  ['zoom'],
  19,
  annotationSize(1),
  21,
  annotationSize(4),
]

// ---- 線の描き分け ----
//
// 分類コードごとの線幅と破線は、同梱のPDF図面（DM-_57-08.pdf）の実測で決めた。
// PDFの描画パスを平面直角座標に載せ（図枠のグリッドラベルから 5.6687 pt/m）、
// 変換結果の線・面に投影して被覆区間を取り、線幅と実線／空白の長さを測っている
// （scripts/measure-pdf.py）。図面は dash 属性を使わず短い実線の連なりで破線を
// 描くので、パターンは投影した被覆区間から読むしかない。
//
// 図面の線幅は 0.30 / 0.42 / 0.54 / 0.84 pt の4種類で、図式どおりに分かれていた。
// 堅ろう建物・堅ろう塀が太線、等高線は計曲線（0.54）＞主曲線（0.30）。
// 既定は最も多い 0.42pt。

/** PDF図面の1ptに相当する地上メートル（1:500、図枠から実測 5.6687 pt/m）。 */
const M_PER_PT = 1 / 5.6687

interface LineStyle {
  /** 図面での線幅（pt）。 */
  pt: number
  /** 破線の [実線, 空白]（地上メートル）。省略すると実線。 */
  dash?: [number, number]
  codes: string[]
  /** 実測の根拠を残すための覚え書き。 */
  note: string
}

/** 既定の線幅（pt）。LINE_STYLES に無いコードはこれで描く。 */
const LINE_DEFAULT_PT = 0.42

/**
 * 図面の実測から起こした線の描き方。実線は線幅だけを変えるので1レイヤーにまとめ、
 * 破線はパターンごとにレイヤーを分ける（`line-dasharray` はコード別にできないため）。
 */
const LINE_STYLES: LineStyle[] = [
  // --- 実線（線幅だけが既定と違うもの） ---
  { pt: 0.84, codes: ['3002', '6141'], note: '堅ろう建物・堅ろう塀' },
  { pt: 0.54, codes: ['7101'], note: '等高線（計曲線）' },
  { pt: 0.3, codes: ['7102'], note: '等高線（主曲線）' },
  // --- 破線 ---
  { pt: 0.54, dash: [2.52, 0.58], codes: ['1106'], note: '大字・町・丁目界' },
  { pt: 0.42, dash: [1.59, 0.53], codes: ['2233'], note: '側溝 L字溝' },
  { pt: 0.42, dash: [1.06, 0.53], codes: ['2106', '2230'], note: '庭園路等' },
  { pt: 0.42, dash: [0.71, 0.61], codes: ['2234', '5107'], note: '側溝・水路の地下部' },
  { pt: 0.42, dash: [0.53, 0.26], codes: ['3003'], note: '普通無壁舎' },
  { pt: 0.42, dash: [0.26, 0.26], codes: ['3402', '6301'], note: '屋門・植生界' },
  { pt: 0.42, dash: [1.3, 1.15], codes: ['6201', '6302'], note: '区域界・耕地界' },
  { pt: 0.3, dash: [0.44, 0.44], codes: ['4146', '4148', '4149'], note: '自治体固有コード' },
  { pt: 0.3, dash: [0.26, 0.53], codes: ['2273'], note: '自治体固有コード' },
]

// 6136 生垣（169m）は図面に下地の線が無く、植生の記号を並べて表現している
// （被覆区間で測ると実線率0.12）。再現できないので既定の実線のままにしている。

/** 線幅を z19 の画面ピクセルにする。地上サイズ固定なので groundSize と同じ考え方。 */
const widthPx19 = (pt: number): number =>
  Math.round(pt * M_PER_PT * PX_PER_M_Z19 * 100) / 100

/** `line-dasharray` は線幅の倍数で書く。地上の長さを線幅の地上長で割る。 */
const dashArray = (s: LineStyle): number[] =>
  s.dash!.map((m) => Math.round((m / (s.pt * M_PER_PT)) * 10) / 10)

const DASH_STYLES = LINE_STYLES.filter((s) => s.dash)
const DASH_CODES = DASH_STYLES.flatMap((s) => s.codes)

/** 実線として描くコードの線幅（pt）。 */
const SOLID_PT = new Map<string, number>(
  LINE_STYLES.filter((s) => !s.dash).flatMap((s) => s.codes.map((c) => [c, s.pt] as const)),
)

/**
 * 実線の線幅。ズーム補間の外側でしか `['zoom']` は使えないため、
 * 補間の各停留点の中でコード別の `match` を組む。
 */
const solidWidth = (mul: number): unknown[] => [
  'match',
  ['to-string', ['get', 'Code']],
  ...[...SOLID_PT].flatMap(([code, pt]) => [code, widthPx19(pt) * mul]),
  widthPx19(LINE_DEFAULT_PT) * mul,
]

const SOLID_WIDTH: unknown[] = [
  'interpolate',
  ['exponential', 2],
  ['zoom'],
  19,
  solidWidth(1),
  21,
  solidWidth(4),
]

/** 破線レイヤーの線幅（レイヤーごとに1種類なのでコード別の分岐は要らない）。 */
const dashWidth = (pt: number): unknown[] => [
  'interpolate',
  ['exponential', 2],
  ['zoom'],
  19,
  widthPx19(pt),
  21,
  widthPx19(pt) * 4,
]

/** 破線で描くコードを実線レイヤーから除くフィルタ。 */
const NOT_DASHED: unknown[] = [
  '!',
  ['in', ['to-string', ['get', 'Code']], ['literal', DASH_CODES]],
]

/**
 * 線・面の輪郭のレイヤー一式。実線1枚＋破線パターンごとに1枚を返す。
 * 面の輪郭は id を `_outline` で終わらせる（main.ts が地物取得の対象から外す）。
 */
function strokeLayers(
  group: GroupKey,
  sourceLayer: string,
  ink: Ink,
  idFor: (suffix: string) => string,
): LayerEntry[] {
  const base = {
    type: 'line' as const,
    source: SOURCE_ID,
    'source-layer': sourceLayer,
    layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
  }
  const solid: LayerEntry = {
    group,
    opacity: { 'line-opacity': 1 },
    spec: {
      ...base,
      id: idFor(''),
      filter: NOT_DASHED as never,
      paint: { 'line-color': ink.line, 'line-width': SOLID_WIDTH as never, 'line-opacity': 1 },
    },
  }
  const dashed = DASH_STYLES.map((s, i) => ({
    group,
    opacity: { 'line-opacity': 1 },
    spec: {
      ...base,
      // 破線の端は丸めない。丸めると空白が詰まってパターンが読めなくなる
      layout: { ...base.layout, 'line-cap': 'butt' as const },
      id: idFor(`d${i}`),
      filter: ['in', ['to-string', ['get', 'Code']], ['literal', s.codes]] as never,
      paint: {
        'line-color': ink.line,
        'line-width': dashWidth(s.pt) as never,
        'line-dasharray': dashArray(s) as never,
        'line-opacity': 1,
      },
    },
  })) as LayerEntry[]
  return [solid, ...dashed]
}

/**
 * スプライトにアイコンが無いコードを描く丸の半径。
 *
 * 記号・方向とも同じ丸で描く。**方向にも矢印を使わない。** 方向要素（E6）は
 * 「向きを持つ記号」であって流向ではないため矢印は誤読を招くこと、そして図面の
 * 実物がそう描いていないことによる。豊中サンプルで代替図形に回る全コードを
 * PDF図面から切り出して確かめたところ、4181（8件、回転した四角）と
 * 4214（7件、旗）を除くすべてが小さな丸か点だった。
 *
 *   記号 1,210件中 221件（11コード）… 2224（102件）・4191（82件）が多数
 *   方向 1,473件中 241件（ 8コード）… 4143（109件）・4145（81件）が多数
 *
 * 件数は dm-sprite が166コードを収録する時点のもの。**スプライトが増えると変わる**
 * ので、書き換えるときは `npm run check:codes` で数え直すこと。
 *
 * 大きさは図面の実測（0.25〜1.4m、中央値およそ1m）に合わせて直径1m相当にする。
 * 向きは失われるが、角度はポップアップの Angle で確認できる。
 */
const FALLBACK_RADIUS = groundSize(0.5, 2)

/**
 * 分類コードからスプライトのアイコン名を組み立てる式。
 *
 * 標準図式は `dm-<コード>` なので連結で足りるが、拡張DMは提供元の区画が挟まる
 * （`dm-ext1-2245`・`dm-ext1-9101100`。dm-sprite#23）。区画つきのものだけを
 * `match` で先に拾い、残りは連結で組む。
 *
 * 区画を無視して連結だけで引くと、改名された拡張DMのアイコンが引けなくなる。
 * 消えはしない（レイヤーの振り分けで代替図形に回る）が、静かに劣化する。
 */
const iconImage = (icons: Map<string, string>): unknown[] => {
  const plain = ['concat', `${DM_SPRITE_ID}:dm-`, ['to-string', ['get', 'Code']]]
  const scoped = [...icons].filter(([code, name]) => name !== `dm-${code}`)
  if (!scoped.length) return plain
  return [
    'match',
    ['to-string', ['get', 'Code']],
    ...scoped.flatMap(([code, name]) => [code, `${DM_SPRITE_ID}:${name}`]),
    plain,
  ]
}

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
 * @param spriteIcons  分類コード → スプライトのキー（basemap.ts の loadSpriteIcons）
 */
export function buildLayers(theme: Theme, spriteIcons: Map<string, string>): LayerEntry[] {
  const ink = inkFor(theme)
  const spriteCodes = new Set(spriteIcons.keys())
  const ICON_IMAGE = iconImage(spriteIcons)
  return [
    // 面の塗り。PDF図面は面を塗らない（白図に黒線だけ）ので既定では見せない。
    // レイヤー自体は残す。クリックで面の属性を拾う当たり判定になっているため
    // （queryRenderedFeatures は塗りの不透明度を見ない）。
    {
      group: 'polygon',
      opacity: {},
      spec: {
        id: 'road_polygon_fill',
        type: 'fill',
        source: SOURCE_ID,
        'source-layer': 'road_polygon',
        paint: { 'fill-color': ink.fill, 'fill-opacity': 0 },
      },
    },
    ...strokeLayers('polygon', 'road_polygon', ink, (s) =>
      s ? `road_polygon_${s}_outline` : 'road_polygon_outline',
    ),
    ...strokeLayers('line', 'road_line', ink, (s) => (s ? `road_line_${s}` : 'road_line')),
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
          // PDF図面の標高値は 5.64pt ＝ 地上0.99m
          'text-size': groundSize(0.99) as never,
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
          'circle-radius': FALLBACK_RADIUS as never,
          // 地色で抜いて中空の丸にする。ink.fill（白）だとダークテーマで
          // 縁と同じ明色になり、塗りつぶした白丸として悪目立ちする
          'circle-color': ink.halo,
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
          'icon-size': ICON_SIZE as never,
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
          'text-size': groundSize(0.99) as never,   // PDF図面の標高値と同じ地上0.99m
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
    // 方向 — アイコンが無いコードは記号と同じ丸で位置だけ示す
    {
      group: 'direction',
      opacity: { 'circle-opacity': 1, 'circle-stroke-opacity': 1 },
      spec: {
        id: 'road_direction_dot',
        type: 'circle',
        source: SOURCE_ID,
        'source-layer': 'road_direction',
        minzoom: DETAIL_MINZOOM,
        filter: lacksIcon(spriteCodes) as never,
        paint: {
          'circle-radius': FALLBACK_RADIUS as never,
          // 地色で抜いて中空の丸にする。ink.fill（白）だとダークテーマで
          // 縁と同じ明色になり、塗りつぶした白丸として悪目立ちする
          'circle-color': ink.halo,
          'circle-opacity': 1,
          'circle-stroke-color': ink.line,
          'circle-stroke-width': 0.8,
          'circle-stroke-opacity': 1,
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
          'icon-size': ICON_SIZE as never,
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
          'text-size': groundSize(0.99) as never,   // PDF図面の標高値と同じ地上0.99m
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
          'text-size': ANNOTATION_SIZE as never,
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
 * 分類コードの直後に名称を併記する（dmCodes.ts）。コードだけでは地物種別が分からない。
 * 道路台帳図には標準図式に無い自治体固有コードが混ざるため、そのときは
 * 「（標準図式に記載なし）」と出す。豊中サンプルでは105コード中77コードに名称が付く。
 */
export function popupHtml(items: PopupItem[], total = items.length): string {
  const row = (label: string, value: unknown): string =>
    `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`

  const section = (item: PopupItem): string => {
    const { groupName, props } = item
    const parts = Object.entries(props)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .sort(([a], [b]) => orderOf(a) - orderOf(b))
      .flatMap(([k, v]) =>
        // 分類コードの直後に名称を差し込む
        k === 'Code'
          ? [row(ATTR_LABELS.Code, v), row('名称', codeName(v) ?? '（標準図式に記載なし）')]
          : [row(ATTR_LABELS[k] ?? k, v)],
      )
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
