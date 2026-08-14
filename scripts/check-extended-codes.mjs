// 変換結果に含まれる分類コードを「公共測量標準図式のコード」と「拡張コード」に仕分ける。
//
// 道路台帳図には、標準図式に無い自治体・測量ベンダー固有のコードが混ざる。
// 豊中サンプル（図郭57-08）では105コード中28コード・860件（14.8%）がこれにあたる。
// 混ざること自体は異常ではないが、**どれが固有コードかを知らないまま扱うと
// 静かに劣化する**ので、変換のたびに一覧して見えるようにする。
//
//   拡張コードは名称が出ない          → ポップアップが「（標準図式に記載なし）」になる
//   拡張コードのアイコンは提供元ごと    → 提供元の指定を間違えると他所の意匠を当てる
//   指定から漏れた提供元は代替図形の丸  → エラーにならないので気づけない（dm-sprite#23）
//
// 判定の根拠は dm-sprite の `data/standard-codes.csv`（453コード）。標準か拡張かの
// 機械判定のために起こされた表で、これだけが完全。`viewer/src/dmCodes.ts`（435件）や
// dm-sprite の `data/symbols.csv`（372件）は欠けがあるので判定には使わない。
// 準則 付録7 公共測量標準図式（https://www.gsi.go.jp/common/000258741.pdf）を
// 直に引くこともできるが、大分類がグループの縦中央に1回だけ印字されるため
// 行との対応を誤りやすい（`7521 ブレークライン` が `7321` に化ける）。
//
//   node scripts/check-extended-codes.mjs
//   node scripts/check-extended-codes.mjs --json
//   node scripts/check-extended-codes.mjs --providers=ext1        # 提供元を変えて試す
//   node scripts/check-extended-codes.mjs --codes=/path/to.csv    # 表を差し替える
//
// 終了コード
//   0  問題なし（拡張コードがあること自体は問題ではない）
//   1  提供元の指定漏れ。アイコンがあるのに引けていない拡張コードがある
//   2  標準コード表を取得できない（判定できない）
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStandardCodes, STANDARD_CSV_URL } from './standard-codes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const SPRITE_JSON = 'https://shiwaku.github.io/dm-sprite/sprite.json'
const KINDS = ['線', '面', '記号', '方向', '注記']
/** アイコンを描くのは記号と方向だけ。線・面・注記のコードはアイコンの有無を問わない。 */
const ICON_KINDS = new Set(['記号', '方向'])

const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true
}
const asJson = flag('json') === true

// ---- スプライト ----

/**
 * スプライトの索引を「分類コード → { 提供元, キー }」にする。
 *
 * キーは `dm-<コード>`（標準図式）と `dm-<提供元>-<コード>`（拡張DM）の2種類。
 * 分類コードは数字だけなので、末尾の数字列をコードとして切る（dm-sprite#23）。
 * ビューワの `basemap.ts` の splitIconName と同じ切り方をする。
 */
async function loadSprite() {
  try {
    const res = await fetch(SPRITE_JSON)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const entries = Object.keys(await res.json())
      .filter((k) => k.startsWith('dm-'))
      .map((k) => ({ key: k, m: /^(?:(.+)-)?(\d+)$/.exec(k.slice(3)) }))
      .filter((e) => e.m)
      .map((e) => ({ key: e.key, provider: e.m[1] ?? null, code: e.m[2] }))
    const byCode = new Map()
    for (const e of entries) byCode.set(e.code, [...(byCode.get(e.code) ?? []), e])
    return { entries, byCode }
  } catch (e) {
    return { entries: null, byCode: new Map(), error: e }
  }
}

// ---- ビューワ側の設定 ----

/**
 * ビューワが既定で引く提供元と、既存アイコンで代替する表を basemap.ts から読む。
 *
 * 実装をコピーせず、実際に使われている値をそのまま見る。ビューワの既定を変えたのに
 * 点検の側が古い値のままだと、この点検自体が嘘をつく。読めなければ既定なしで続ける。
 */
function readViewerConfig() {
  const path = join(ROOT, 'viewer', 'src', 'basemap.ts')
  const config = { providers: [], aliases: new Map(), path }
  if (!existsSync(path)) return config
  const src = readFileSync(path, 'utf8')
  const def = /const DEFAULT_PROVIDERS = '([^']*)'/.exec(src)
  if (def) config.providers = def[1].split(',').map((s) => s.trim()).filter(Boolean)
  const block = /const ICON_ALIASES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(src)
  if (block) {
    for (const p of block[1].matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
      for (const a of p[2].matchAll(/'(\d+)':\s*'([\w-]+)'/g)) {
        config.aliases.set(`${p[1]}:${a[1]}`, a[2])
      }
    }
  }
  return config
}

// ---- 変換結果 ----

/** 分類コードごとの件数と、出現した地物種別を数える。 */
function readCounts() {
  const counts = new Map()
  const kinds = new Map()
  let files = 0
  for (const kind of KINDS) {
    const path = join(ROOT, 'output', `道路台帳図_${kind}.geojson`)
    if (!existsSync(path)) continue
    files++
    for (const f of JSON.parse(readFileSync(path, 'utf8')).features) {
      const c = String(f.properties.Code ?? '')
      if (!c) continue
      counts.set(c, (counts.get(c) ?? 0) + 1)
      kinds.set(c, (kinds.get(c) ?? new Set()).add(kind))
    }
  }
  return { counts, kinds, files }
}

// ---- 本体 ----

const { counts, kinds, files } = readCounts()
if (files === 0) {
  console.error('output/ に変換結果がありません。先に node src/index.js を実行してください。')
  process.exit(2)
}

const { codes: standard, source, error, tried } = await loadStandardCodes(
  flag('codes') ?? process.env.DM_STANDARD_CODES,
)
if (!standard) {
  console.error(`標準コード表を取得できません: ${tried}`)
  console.error(`  ${error}`)
  console.error(`  隣に dm-sprite をクローンするか、--codes=<path> で渡してください。`)
  process.exit(2)
}

const sprite = await loadSprite()
const viewer = readViewerConfig()
const providers = (() => {
  const given = flag('providers') ?? process.env.VITE_DM_PROVIDERS
  if (typeof given === 'string') return given.split(',').map((s) => s.trim()).filter(Boolean)
  return viewer.providers
})()

const used = [...counts.keys()].sort()
const total = used.reduce((a, c) => a + counts.get(c), 0)
const extended = used.filter((c) => !standard.has(c))
const extTotal = extended.reduce((a, c) => a + counts.get(c), 0)

/**
 * そのコードをビューワがどう描くかを決める。basemap.ts の loadSpriteIcons と同じ順。
 * 標準のアイコン → 指定した提供元の区画 → 代替表 → 無ければ代替図形の丸。
 */
function iconFor(code) {
  const entries = sprite.byCode.get(code) ?? []
  const std = entries.find((e) => e.provider === null)
  if (std) return { key: std.key, via: '標準', provider: null }
  for (const p of providers) {
    const hit = entries.find((e) => e.provider === p)
    if (hit) return { key: hit.key, via: `${p} の区画`, provider: p }
  }
  for (const p of providers) {
    const alias = viewer.aliases.get(`${p}:${code}`)
    if (alias && sprite.entries?.some((e) => e.key === alias)) {
      return { key: alias, via: `${p} の代替表`, provider: p }
    }
  }
  // 指定していない提供元なら引ける、という場合は設定漏れ。
  // **区画にアイコンがある場合と、代替表で既存アイコンを指している場合を混ぜないこと。**
  // 「toyonaka の区画にある」と出すと dm-toyonaka-<コード> が実在するように読めるが、
  // 代替表は既存の標準アイコン（`4191` → `dm-4161`）を指しているだけで、
  // 提供元の区画にキーがあるとは限らない（dm-sprite#28 で誤解を招いた）
  const other = entries.find((e) => e.provider && !providers.includes(e.provider))
  if (other) {
    return { key: null, via: null, missingProvider: other.provider, missingKey: other.key }
  }
  const otherAlias = [...viewer.aliases.entries()]
    .filter(([k]) => k.endsWith(`:${code}`))
    .map(([k, name]) => ({ provider: k.split(':')[0], name }))
    .find((a) => !providers.includes(a.provider) && sprite.entries?.some((e) => e.key === a.name))
  if (otherAlias) {
    return {
      key: null,
      via: null,
      missingProvider: otherAlias.provider,
      missingAlias: otherAlias.name,
    }
  }
  return { key: null, via: null }
}

const rows = extended.map((code) => {
  const kindList = [...kinds.get(code)]
  const icon = kindList.some((k) => ICON_KINDS.has(k)) ? iconFor(code) : null
  return { code, count: counts.get(code), kinds: kindList, icon }
})
// 指定していない提供元にアイコンがある＝そのままだと丸に落ちる。気づけないので拾う
const missing = rows.filter((r) => r.icon?.missingProvider)

if (asJson) {
  console.log(
    JSON.stringify(
      {
        source,
        standardCodes: standard.size,
        providers,
        total: { codes: used.length, features: total },
        extended: { codes: extended.length, features: extTotal, items: rows },
        missingProviders: [...new Set(missing.map((r) => r.icon.missingProvider))],
      },
      null,
      2,
    ),
  )
  process.exit(missing.length ? 1 : 0)
}

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`
const num = (n) => n.toLocaleString('ja-JP')
/** 全角を2桁として数え、桁を揃える。`String.padEnd` は文字数で数えるため崩れる。 */
const width = (s) => [...s].reduce((w, c) => w + (/[\x20-\x7e]/.test(c) ? 1 : 2), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))

console.log(`標準コード表  ${source}`)
console.log(`              ${standard.size} コード`)
console.log(
  sprite.entries
    ? `スプライト    ${SPRITE_JSON}\n              ${sprite.entries.length} キー / ${sprite.byCode.size} コード`
    : `スプライト    読めませんでした（${sprite.error}）。アイコンの欄は空にします`,
)
console.log(`変換結果      output/ の ${files} ファイル`)
console.log(`              ${used.length} コード / ${num(total)} 件`)
console.log(`提供元        ${providers.length ? providers.join(',') : '（なし）'}`)

console.log(
  `\n■ 拡張コード（標準図式に無い）: ${extended.length} コード / ${num(extTotal)} 件（${pct(extTotal)}）`,
)
if (extended.length) {
  console.log(`   コード  ${pad('件数', 6)}  ${pad('地物', 14)}アイコン`)
  for (const r of [...rows].sort((a, b) => b.count - a.count)) {
    const icon = !r.icon
      ? '（アイコンを使わない地物）'
      : r.icon.key
        ? `${r.icon.key}（${r.icon.via}）`
        : r.icon.missingProvider
          ? `!! ${r.icon.missingKey ?? r.icon.missingAlias} を引けるのに引いていない`
          : '―（代替図形の丸）'
    console.log(
      `   ${r.code}  ${num(r.count).padStart(6)}  ${pad(r.kinds.join('・'), 14)}${icon}`,
    )
  }
  console.log(
    '\n   拡張コードが混ざること自体は道路台帳図では普通のことで、異常ではありません。' +
      '\n   名称は出ず「（標準図式に記載なし）」と表示されます。コード自体は隠しません。',
  )
}

if (missing.length) {
  const ps = [...new Set(missing.map((r) => r.icon.missingProvider))]
  console.log(`\n!! 提供元の指定漏れ: ${missing.length} コード / ${num(missing.reduce((a, r) => a + r.count, 0))} 件`)
  for (const r of missing) {
    const how = r.icon.missingKey
      ? `${r.icon.missingKey}（${r.icon.missingProvider} の区画）`
      : `${r.icon.missingAlias}（${r.icon.missingProvider} の代替表。区画にキーがあるわけではない）`
    console.log(`   ${r.code}（${num(r.count)}件）→ ${how}`)
  }
  console.log(
    `   アイコンがあるのに引けておらず、代替図形の丸に落ちています。エラーは出ません。` +
      `\n   このデータの提供元が合っているなら VITE_DM_PROVIDERS=${[...providers, ...ps].join(',')} を指定してください。` +
      `\n   違う自治体のデータなら、意匠を当ててはいけないので指定しないのが正しい判断です。`,
  )
  process.exit(1)
}

console.log('\n提供元の指定漏れはありません。')
