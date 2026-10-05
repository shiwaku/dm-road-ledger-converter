// dm-converter（本家）への追従状況を確認する。
//
// このリポジトリは dm-converter の派生で、変換処理もビューワも向こうに揃えてある。
// 向こうの更新を取り込み忘れないよう、最後に取り込んだコミットを scripts/upstream.json に
// 記録しておき、それ以降の変更を一覧にする。
//
//   node scripts/check-upstream.mjs            # 未取り込みのコミットと複製ファイルのずれを出す
//   node scripts/check-upstream.mjs --no-fetch # git fetch を省く（オフライン時）
//   node scripts/check-upstream.mjs --mark     # 取り込み終えたら、記録を本家の最新に進める
//
// 本家の作業コピーは ../dm-converter を使う（DM_CONVERTER_DIR で変えられる）。
//
// 見るものは2つ。
//   1. 記録したコミット以降に本家で入ったコミットのうち、watch のパスに触れたもの。
//      変換処理（src/）やビューワ（viewer/）は道路台帳向けに手を入れてあるので、
//      機械的にはマージできない。差分を読んで、こちらにも要るかを判断する
//   2. copies に挙げた「そのまま複製している」ファイルが本家の最新と一致するか。
//      こちらは一致していなければ単純に写せばよい（from があればその行以降だけ比べる）
//
// どちらかに該当があれば終了コード1。取り込み終えたら --mark で記録を進める。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONFIG = join(HERE, 'upstream.json')
const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const args = new Set(process.argv.slice(2))

const UP = resolve(process.env.DM_CONVERTER_DIR || join(ROOT, '..', 'dm-converter'))
if (!existsSync(join(UP, '.git'))) {
  console.error(`本家の作業コピーが見つかりません: ${UP}`)
  console.error(`git clone ${config.repo} ${UP} するか、DM_CONVERTER_DIR で場所を指定してください。`)
  process.exit(2)
}

const git = (...a) => execFileSync('git', ['-C', UP, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
const ref = `origin/${config.branch}`

if (!args.has('--no-fetch')) {
  try {
    git('fetch', '--quiet', 'origin', config.branch)
  } catch {
    console.warn('git fetch に失敗しました。手元にある本家の情報で確認します。')
  }
}
const head = git('rev-parse', ref).trim()

if (args.has('--mark')) {
  config.syncedCommit = head
  config.syncedAt = new Date().toISOString().slice(0, 10)
  writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n')
  console.log(`記録を ${head.slice(0, 7)}（${config.syncedAt}）に進めました: scripts/upstream.json`)
  process.exit(0)
}

let pending = 0

// 1. 未取り込みのコミット
console.log(`本家: ${UP}（${ref} = ${head.slice(0, 7)}）`)
console.log(`取り込み済み: ${config.syncedCommit.slice(0, 7)}（${config.syncedAt}）\n`)
const log = git('log', '--no-merges', '--reverse', '--format=%x01%h %ad %s', '--date=short',
  '--name-only', `${config.syncedCommit}..${ref}`)
const commits = log.split('\x01').filter(Boolean).map(block => {
  const [title, ...files] = block.trim().split('\n').filter(Boolean)
  return { title, files }
})
const watched = (f) => config.watch.some(w => f === w || f.startsWith(w))
const relevant = commits.filter(c => c.files.some(watched))
const others = commits.filter(c => !c.files.some(watched))

if (relevant.length === 0) {
  console.log('未取り込みのコミット: なし')
} else {
  pending += relevant.length
  console.log(`未取り込みのコミット: ${relevant.length}件（差分を読んで、こちらにも要るか判断する）`)
  for (const c of relevant) {
    console.log(`  ${c.title}`)
    for (const f of c.files.filter(watched)) {
      const mark = existsSync(join(ROOT, f)) ? '' : '  （こちらに無いファイル）'
      console.log(`      ${f}${mark}`)
    }
  }
  console.log(`  差分: git -C ${UP} diff ${config.syncedCommit.slice(0, 7)}..${ref} -- ${config.watch.join(' ')}`)
}
if (others.length > 0) {
  console.log(`\n参考（ドキュメント等のみのコミット）: ${others.length}件`)
  for (const c of others) console.log(`  ${c.title}`)
}

// 2. 複製しているファイル
console.log('\n複製しているファイル:')
const norm = (s, from) => {
  let t = s.replace(/\r\n/g, '\n')
  if (from) {
    const m = t.match(new RegExp(from, 'm'))
    if (m) t = t.slice(m.index)
  }
  return t
}
for (const { path, from } of config.copies) {
  let theirs
  try {
    theirs = git('show', `${ref}:${path}`)
  } catch {
    console.log(`  ${path}: 本家から消えています`)
    pending++
    continue
  }
  const mine = existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : null
  if (mine !== null && norm(mine, from) === norm(theirs, from)) {
    console.log(`  ${path}: 一致`)
  } else {
    console.log(`  ${path}: **本家と違う**（写し直す）`)
    pending++
  }
}

console.log('')
if (pending === 0) {
  console.log('本家に追従できています。')
} else {
  console.log('取り込み終えたら node scripts/check-upstream.mjs --mark で記録を進めてください。')
  process.exit(1)
}
