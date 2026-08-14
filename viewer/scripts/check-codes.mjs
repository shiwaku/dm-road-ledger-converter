// 分類コードの名称表（src/dmCodes.ts）とスプライト（dm-sprite）の整合を確認する。
//
// ビューワは分類コードを2か所で引く。
//   アイコン  dm-sprite の `dm-<コード>`（無ければ丸・矢印の代替図形）
//   名称      src/dmCodes.ts（無ければ「（標準図式に記載なし）」）
// この2つは別々に育つので、片方だけ増えると
// 「アイコンは出るのに名称が出ない」という中途半端な状態になる。
//
// dm-sprite は随時更新されるため、件数をドキュメントに書くのではなく
// これを実行して確かめる。出力する `output/` の変換結果があれば、
// 豊中サンプルでの実際の出現件数も併せて出す。
//
//   node scripts/check-codes.mjs
//
// アイコンがあるのに名称が無いコードが1つでもあれば終了コード1。
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SPRITE_JSON = 'https://shiwaku.github.io/dm-sprite/sprite.json'

/** src/dmCodes.ts から `'2235': '雨水桝',` の行を拾う。 */
function readNames() {
  const src = readFileSync(join(HERE, '..', 'src', 'dmCodes.ts'), 'utf8')
  const names = new Map()
  for (const m of src.matchAll(/^\s*'(\d+)':\s*'(.+?)',$/gm)) names.set(m[1], m[2])
  return names
}

/** 変換結果があれば、分類コードごとの件数を数える。無ければ空。 */
function readCounts() {
  const counts = new Map()
  for (const kind of ['線', '面', '記号', '方向', '注記']) {
    const path = join(ROOT, 'output', `道路台帳図_${kind}.geojson`)
    if (!existsSync(path)) continue
    const gj = JSON.parse(readFileSync(path, 'utf8'))
    for (const f of gj.features) {
      const c = String(f.properties.Code ?? '')
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
    }
  }
  return counts
}

const names = readNames()
const res = await fetch(SPRITE_JSON)
if (!res.ok) {
  console.error(`スプライトを取得できません: ${SPRITE_JSON} (HTTP ${res.status})`)
  process.exit(2)
}
// スプライトのキーは `dm-<コード>`（標準図式）と `dm-<提供元>-<コード>`（拡張DM）の
// 2種類（dm-sprite#23）。分類コードは数字だけなので、末尾の数字列をコードとして切る。
// 区画を無視して `dm-` を落とすだけだと `ext1-2245` のような値になり、
// 「4桁でない拡張コード」として素通りしてしまう（2245 は4桁の標準枠のコード）。
const spriteEntries = Object.keys(await res.json())
  .filter((k) => k.startsWith('dm-'))
  .map((k) => /^(?:(.+)-)?(\d+)$/.exec(k.slice(3)))
  .filter(Boolean)
  .map((m) => ({ provider: m[1] ?? null, code: m[2] }))
const sprite = new Set(spriteEntries.map((e) => e.code))
const providerOf = new Map(spriteEntries.map((e) => [e.code, e.provider]))
const counts = readCounts()
const n = (code) => counts.get(code) ?? 0
const scope = (code) => {
  const p = providerOf.get(code)
  return p ? `［${p}］` : ''
}
const withCount = (code) =>
  `${code}${scope(code)}${counts.size ? `（豊中 ${n(code)}件）` : ''}`

console.log(`名称表 src/dmCodes.ts : ${names.size} コード`)
console.log(`スプライト dm-sprite  : ${sprite.size} コード`)
if (counts.size) console.log(`変換結果 output/       : ${counts.size} コード`)

// アイコンがあるのに名称が無い＝ポップアップに「記載なし」と出てしまう
const iconNoName = [...sprite].filter((c) => !names.has(c)).sort()
// 図式は4桁。それ以外は dm-sprite 独自の拡張コードなので分けて扱う
const fourDigit = iconNoName.filter((c) => c.length === 4)
const extended = iconNoName.filter((c) => c.length !== 4)

console.log(`\n■ アイコンがあるのに名称が無い: ${fourDigit.length} コード`)
for (const c of fourDigit) console.log(`   ${withCount(c)}`)
if (extended.length) {
  console.log(
    `\n□ 図式外の拡張コード（4桁でないもの。名称表の対象外）: ${extended.map(withCount).join(', ')}`,
  )
}

// 提供元の区画に入っているコード。ビューワは VITE_DM_PROVIDERS で指定した提供元しか引かない
const scoped = spriteEntries.filter((e) => e.provider)
if (scoped.length) {
  const byProvider = new Map()
  for (const e of scoped) {
    byProvider.set(e.provider, [...(byProvider.get(e.provider) ?? []), e.code])
  }
  console.log('\n□ 提供元の区画に入っているアイコン（既定では引かない）')
  for (const [p, cs] of byProvider) {
    console.log(`   ${p}: ${cs.map((c) => (counts.size ? `${c}（豊中 ${n(c)}件）` : c)).join(', ')}`)
  }
  console.log(
    '   ビューワで使うには VITE_DM_PROVIDERS=' +
      [...byProvider.keys()].join(',') +
      ' を指定する（README「拡張DMコードの提供元を指定する」）。',
  )
}

if (counts.size) {
  const used = [...counts.keys()].sort()
  const noName = used.filter((c) => !names.has(c))
  const noIcon = used.filter((c) => !sprite.has(c))
  const sum = (arr) => arr.reduce((a, c) => a + n(c), 0)
  const total = sum(used)
  console.log(`\n豊中サンプルでの状況（${total}件 / ${used.length}コード）`)
  console.log(`  名称あり  ${total - sum(noName)}件（${used.length - noName.length}コード）`)
  console.log(`  名称なし  ${sum(noName)}件（${noName.length}コード）: ${noName.join(' ')}`)
  console.log(`  アイコンが無いコード: ${noIcon.length}（線・面・注記を含むので参考値）`)
}

if (fourDigit.length) {
  console.log(
    '\nアイコンがあるのに名称が無いコードは、dm-converter の viewer/src/dmCodes.ts に' +
      '名称を足してから、こちらへ複製すること（図式は共通なので両方を揃える）。',
  )
  process.exit(1)
}
console.log('\n整合しています。')
