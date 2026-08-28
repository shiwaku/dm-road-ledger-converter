// -----------------------------------------
// 背景地図（淡色 / 標準 / 写真 / 白図）とダークテーマ化、記号スプライトの注入。
//
// dm-converter の viewer/src/basemap.ts と同じ作りにしている。
// -----------------------------------------
import type { StyleSpecification } from 'maplibre-gl'
import type { Theme } from './theme'

// ---- 色ユーティリティ（明度反転でダーク化するため） ----

function parseColor(str: string): [number, number, number, number] | null {
  const s = str.trim()
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (rgba) {
    return [+rgba[1], +rgba[2], +rgba[3], rgba[4] !== undefined ? +rgba[4] : 1]
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }
  return null
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const hue = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)]
}

/** 明度を反転して暗色に変換（色相は保持、彩度は少し抑える）。 */
function darkenColor(str: string): string {
  const c = parseColor(str)
  if (!c) return str
  const [r, g, b, a] = c
  const [h, s, l] = rgbToHsl(r, g, b)
  const nl = Math.min(0.9, Math.max(0.05, 1 - l))
  const [nr, ng, nb] = hslToRgb(h, s * 0.85, nl)
  return `rgba(${nr},${ng},${nb},${a})`
}

/** paint 値（文字列 or 式配列）の中の色文字列だけを再帰的に変換する。 */
function transformValue(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return parseColor(v) ? fn(v) : v
  if (Array.isArray(v)) return v.map((x) => transformValue(x, fn))
  return v
}

/** スタイル中の色系 paint プロパティだけを一括変換する。 */
function recolor(src: StyleSpecification, fn: (s: string) => string): StyleSpecification {
  const style = structuredClone(src) as StyleSpecification
  for (const layer of style.layers) {
    const paint = (layer as { paint?: Record<string, unknown> }).paint
    if (!paint) continue
    for (const key of Object.keys(paint)) {
      if (key.includes('color')) paint[key] = transformValue(paint[key], fn)
    }
  }
  return style
}

export type Basemap = 'pale' | 'std' | 'photo' | 'blank'

// ---- 追加スプライト（地図記号） ----
// MapLibre は sprite を配列で複数指定できる。接頭辞なしで参照できるのは id 'default' の
// スプライトだけなので、記号を接頭辞なしで参照している地理院スタイル側を 'default' に据え、
// 追加分は `<id>:<アイコン名>` で参照する。背景を切り替えても記号が出るよう、
// スタイルを返す直前に必ず注入する。
// 公共測量標準図式の分類コードに対応するアイコンを持つ dm-sprite を参照する。
// 道路台帳図固有のコード（95xx など）はこのスプライトに無いため、
// アイコンが無いコードは src/layers.ts でフォールバック（丸・矢印）を描いている。
export const DM_SPRITE_URL = 'https://shiwaku.github.io/dm-sprite/sprite'
export const DM_SPRITE_ID = 'dm'

/** dm-sprite のアイコン名の接頭辞。 */
const ICON_PREFIX = 'dm-'

/**
 * 同梱の検証データ向けの既定。
 *
 * `public/road_ledger.pmtiles` は豊中市サンプル（図郭57-08）から焼いたものを
 * コミットしてあり、GitHub Pages もこれを配信している。既定を空にすると、
 * 同梱データを開いたときに拡張DMコードのアイコンが出ない
 * （`4191` の82件・`2245` の5件）。**同梱データに合わせた既定を置く。**
 *
 * **別の自治体のDMを焼いて表示するときは、必ず `VITE_DM_PROVIDERS` で
 * 上書きするか空にすること。** そのままだと豊中市の意匠を他所のデータに当ててしまう。
 */
const DEFAULT_PROVIDERS = 'ext1,toyonaka'

/**
 * 拡張DMのアイコンを引く提供元。カンマ区切りで、書いた順に優先する。
 *
 *   VITE_DM_PROVIDERS= npm run dev            標準図式のアイコンだけを引く
 *   VITE_DM_PROVIDERS=toyonaka npm run dev    豊中市の区画も引く
 *
 * 拡張DMコードの意匠は提供元ごとに違うので、**表示するデータの提供元と一致して
 * いなければ他所の意匠を当ててしまう**（dm-sprite#20 で整理された問題）。
 * どの提供元のPMTilesかはビューワからは判定できないため、同梱データ向けの既定を
 * 置いたうえで、違うデータを見るときは利用者に上書きしてもらう。
 *
 * 挙げなかった提供元の拡張DMコードはアイコンを引けず代替図形の丸で描かれる。
 * 位置は出るので地物が消えることはない。
 */
const PROVIDERS: string[] = String(import.meta.env.VITE_DM_PROVIDERS ?? DEFAULT_PROVIDERS)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * スプライトのキーを「提供元」と「分類コード」に分ける。
 *
 *   dm-4132           → { provider: null,       code: '4132' }      標準図式
 *   dm-ext1-2245      → { provider: 'ext1',     code: '2245' }      拡張DM（提供元未特定）
 *   dm-ext1-9101100   → { provider: 'ext1',     code: '9101100' }   同（コードが7桁のもの）
 *   dm-toyonaka-4191  → { provider: 'toyonaka', code: '4191' }      拡張DM（豊中市。作成中）
 *
 * いま配信されている区画は `ext1` だけ。豊中市の区画は dm-sprite で作成中で、
 * それまで `4191` は ICON_ALIASES で `dm-4161` を指して解決している。
 *
 * 分類コードは数字だけなので、末尾の数字列をコード、その手前を提供元として切る
 * （dm-sprite#23 の命名。`dm-ext1-9101100` のように7桁のものもある）。
 */
function splitIconName(name: string): { provider: string | null; code: string } | null {
  const rest = name.slice(ICON_PREFIX.length)
  const m = /^(?:(.+)-)?(\d+)$/.exec(rest)
  return m ? { provider: m[1] ?? null, code: m[2] } : null
}

/**
 * 拡張DMコードを既存アイコンで代替する表。
 *
 * dm-sprite は「どんなアイコンが存在するか」だけを持ち、**どのコードをどのアイコンで
 * 代替するかは、そのデータを扱う側の判断**という切り分けになっている
 * （dm-sprite#22）。図面から起こした意匠が既存アイコンと同じなら、同じ絵を別のキーで
 * 二重に配らず、利用側が既存のキーを指す。
 *
 * **提供元ごとに持つこと。** 別の自治体の同じコードは別物かもしれず、その判断は
 * データを持っている側にしかできない。PROVIDERS に挙げた提供元の分だけが効く。
 *
 * 追加するときは、必ず図面での確認と出典を根拠として書き残す。
 */
const ICON_ALIASES: Record<string, Record<string, string>> = {
  toyonaka: {
    // 図面では丸囲みの「水」（㊌）。標準の 4161 マンホール（水道）と同一意匠で
    // 描かれており、図面が両者を記号で描き分けていない（大きさは 4191 が 4161 の
    // 73%だが、形は同じ）。dm-sprite 側は「図面に無い区別は発明しない」方針で
    // 標準の枠には 4191 を作らないと決めたため、こちらで 4161 を指す。
    // 出典: 豊中市サンプル 図郭57-08 の DM-_57-08.pdf（dm-sprite#22 で実測）
    //
    // **豊中市の区画（dm-toyonaka-4191）が配信されるまでの措置。**
    // 区画のアイコンは代替表より先に採る（loadSpriteIcons の順）ので、配信されれば
    // 無修正で切り替わる。切り替わったらこの行を外すこと（残っても害はないが死ぬ）。
    '4191': 'dm-4161',

    // 以下の5コードは、dm-sprite が図面から意匠を起こしたうえで
    // 「既存アイコンと同じ形なので追加しない」と決めたもの
    // （tools/gen_icons.py「追加しなかったコード（既存アイコンで代替できる）」）。
    // 代替先の判断は利用側の仕事なので、ここで指す。
    // 出典はいずれも豊中市サンプル 図郭57-08 の DM-_57-08.pdf（1:500）の実測。

    // 図面では素の円（外形0.540m）。--similar は dm-3519 と dm-4231 のどちらとも
    // 同形（比率差0.0%・覆い率100/100）。**大きさで 4231 を採る。** 外径18.88pxで、
    // 41xx の兄弟（dm-toyonaka-4133/4134/4144/4145＝18.62px）にそろう。
    // dm-3519 は22pxで、同じ0.540mの円が兄弟より2割大きく出てしまう。
    '4143': 'dm-4231',

    // 図面では塗りつぶした点（外形0.254m）。dm-8199 指示点と同形
    // （比率差0.0%・覆い率100/100）。実寸も 6.16px 相当で dm-8199 の6.00pxと近い。
    '2224': 'dm-8199',

    // 図面では円の中心に点（外形0.413m）。dm-7303 多角点等と同じ形
    // （dm-sprite の実測で覆い率97.0/89.3、目視で同一）。
    '4146': 'dm-7303',
    // 4147 は 4146 と幾何が完全に同じ（外形・半径の峰・線分がすべて一致）。
    '4147': 'dm-7303',

    // 図面では四角の枠（外形1.30〜1.43m）。dm-2235 雨水桝と同じ形
    // （dm-sprite の実測で覆い率100/89.6、目視で同一）。
    // **大きさは合わない。** 図面の 4181 は 2235（0.60m角）の2倍以上あるが、
    // 同じ形のアイコンが他に無いのでこれを指す。大きさまで合わせるなら
    // dm-sprite に豊中の区画（dm-toyonaka-4181）を作ることになる。
    '4181': 'dm-2235',
  },
}

interface SpriteEntry {
  id: string
  url: string
}

function withDmSprite(style: StyleSpecification): StyleSpecification {
  const base = style.sprite
  const list: SpriteEntry[] = []
  if (typeof base === 'string') list.push({ id: 'default', url: base })
  else if (Array.isArray(base)) list.push(...(base as SpriteEntry[]))
  if (list.some((s) => s.id === DM_SPRITE_ID)) return style
  list.push({ id: DM_SPRITE_ID, url: DM_SPRITE_URL })
  return { ...style, sprite: list } as StyleSpecification
}

/**
 * スプライトの索引を読み、分類コードから引けるアイコン名の対応表を作る。
 *
 * 道路台帳図の記号・方向には、公共測量標準図式に無い自治体固有のコードが混ざる。
 * アイコンが無いコードを icon-image で要求すると何も描かれず、地物が黙って消える。
 * どのコードが描けるのかを起動時に確かめ、描けないコードだけ代替図形で出す
 * （フィルタと icon-image は src/layers.ts で組み立てる）。
 *
 * 標準図式のアイコンは常に使う。拡張DMは PROVIDERS に挙げた提供元のものだけを、
 * 挙げた順に採る。**同じコードに標準と拡張の両方がある場合は標準を優先する。**
 *
 * 読めなかった場合は空の対応表を返す。その場合は全コードが代替図形に回り、
 * 見た目は素朴になるが地物が消えることはない。
 *
 * @returns 分類コード → スプライトのキー（`dm:` は付けない）
 */
export async function loadSpriteIcons(): Promise<Map<string, string>> {
  const icons = new Map<string, string>()
  try {
    const res = await fetch(`${DM_SPRITE_URL}.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const index = (await res.json()) as Record<string, unknown>
    const parsed = Object.keys(index)
      .filter((name) => name.startsWith(ICON_PREFIX))
      .map((name) => ({ name, ...(splitIconName(name) ?? { provider: undefined, code: '' }) }))
      .filter((e) => e.code && e.provider !== undefined)
    // 標準図式 → 指定された提供元の順。先に入ったものを優先する
    for (const e of parsed) {
      if (e.provider === null) icons.set(e.code, e.name)
    }
    for (const p of PROVIDERS) {
      for (const e of parsed) {
        if (e.provider === p && !icons.has(e.code)) icons.set(e.code, e.name)
      }
    }
    // 最後に代替の表。スプライトに実体があるキーだけを採る（綴り間違いや、
    // 参照先が消えた場合に、存在しないアイコンを要求して地物を消さないため）
    const exists = new Set(parsed.map((e) => e.name))
    for (const p of PROVIDERS) {
      for (const [code, name] of Object.entries(ICON_ALIASES[p] ?? {})) {
        if (icons.has(code)) continue
        if (!exists.has(name)) {
          console.warn(`[sprite] 代替先のアイコンがありません: ${code} → ${name}`)
          continue
        }
        icons.set(code, name)
      }
    }
  } catch (e) {
    console.warn('[sprite] アイコン一覧を読めませんでした。記号・方向は代替図形で描きます', e)
  }
  if (import.meta.env.VITE_DM_PROVIDERS === undefined && PROVIDERS.length) {
    console.info(
      `[sprite] 拡張DMの提供元は既定の「${PROVIDERS.join(',')}」を使っています。` +
        '別の自治体のデータを表示するときは VITE_DM_PROVIDERS で上書きしてください。',
    )
  }
  return icons
}

/** ?debug の HUD 用。どの提供元を引いているかを出す。 */
export const spriteProviders = (): string[] => PROVIDERS

/**
 * 注記に使うグリフの配信元。
 * 淡色・標準（地理院 最適化ベクトルタイル）のスタイルと同じものを、写真・白図でも使う。
 * 背景を切り替えても注記のフォントが変わらないようにするため。
 */
export const GLYPHS = 'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf'

/** 素のスタイル（public/*.json）のキャッシュ。 */
const rawCache = new Map<string, StyleSpecification>()
/** `${base}-${theme}` をキーにした変換済みスタイルのキャッシュ。ダーク化は重いので一度だけ行う。 */
const styleCache = new Map<string, StyleSpecification>()

/**
 * 地理院 最適化ベクトルタイルのスタイルを実行時に読む。
 * pale.json（淡色地図風）と std.json（標準地図風）はレイヤーID・glyphs・sprite が
 * 同一構成のため、切り替えても道路台帳図側のレイヤーの貼り直し方は変わらない。
 */
async function loadRaw(name: 'pale' | 'std'): Promise<StyleSpecification> {
  const hit = rawCache.get(name)
  if (hit) return hit
  const res = await fetch(`${import.meta.env.BASE_URL}${name}.json`)
  const style = withDmSprite((await res.json()) as StyleSpecification)
  rawCache.set(name, style)
  return style
}

/** 地理院 全国最新写真（シームレス）ラスタスタイル。 */
function photoStyle(): StyleSpecification {
  return withDmSprite({
    version: 8,
    glyphs: GLYPHS,
    sprite: 'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std',
    sources: {
      photo: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（全国最新写真）</a>',
      },
    },
    layers: [{ id: 'photo', type: 'raster', source: 'photo' }],
  } as StyleSpecification)
}

/** 背景なし。道路台帳図を白図として見るための無地スタイル。 */
function blankStyle(theme: Theme): StyleSpecification {
  return withDmSprite({
    version: 8,
    glyphs: GLYPHS,
    sprite: 'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std',
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#14161a' : '#ffffff' },
      },
    ],
  } as StyleSpecification)
}

export async function getBasemapStyle(base: Basemap, theme: Theme): Promise<StyleSpecification> {
  if (base === 'photo') return photoStyle()
  if (base === 'blank') return blankStyle(theme)

  const key = `${base}-${theme}`
  const cached = styleCache.get(key)
  if (cached) return cached

  const src = await loadRaw(base)
  // ダークテーマは、選択中のスタイルの色を明度反転して生成する。
  const style = theme === 'dark' ? recolor(src, darkenColor) : src

  styleCache.set(key, style)
  return style
}
