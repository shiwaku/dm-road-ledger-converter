// 公共測量標準図式の分類コード表を読む。標準か拡張かの判定はここを通す。
//
// 根拠は dm-sprite の `data/standard-codes.csv`（453コード）。標準か拡張かの機械判定の
// ために起こされた表で、**判定に使えるのはこれだけ**。`viewer/src/dmCodes.ts`（435件）と
// dm-sprite の `data/symbols.csv`（372件）はどちらも欠けがあり、とくに symbols.csv で
// 判定すると注記（81xx・82xx）を拡張と誤判定する（dm-sprite#28・#29）。
//
// 「4桁かどうか」や「スプライトのキーに区画が挟まるか」で代用してもいけない。
// 区画は意匠が提供元ごとに違うことを表すだけで、標準か拡張かとは別の軸。
//
// scripts/check-extended-codes.mjs と viewer/scripts/check-codes.mjs の両方から使う。
// 判定の根拠が2箇所に分かれると片方だけ古くなるため、読み口をここに1つ持つ。
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const STANDARD_CSV_URL =
  'https://raw.githubusercontent.com/shiwaku/dm-sprite/main/data/standard-codes.csv'
/** ネットワークが使えないときに見にいく、隣に並べたクローン。 */
export const STANDARD_CSV_LOCAL = join(ROOT, '..', 'dm-sprite', 'data', 'standard-codes.csv')

/** `コード,名称,レイヤ,レイヤ名` の1列目と2列目を拾う。 */
function parse(text) {
  const map = new Map()
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [code, name] = line.split(',')
    if (code && /^\d+$/.test(code.trim())) map.set(code.trim(), (name ?? '').trim())
  }
  return map
}

/**
 * 標準コード表を読む。明示指定 → ネットワーク → 隣のクローン、の順に探す。
 *
 * @param given 明示指定するパス（`--codes=` や環境変数）。読めなければ他を見にいかない
 * @returns `{ codes, source }`、または読めなければ `{ codes: null, error, tried }`
 */
export async function loadStandardCodes(given) {
  if (typeof given === 'string' && given) {
    try {
      return { codes: parse(readFileSync(given, 'utf8')), source: given }
    } catch (e) {
      // 指定されたものが読めないときは黙って別を見にいかない。
      // 差し替えたつもりの表と違う表で判定されるほうが困る
      return { codes: null, error: e, tried: given }
    }
  }
  try {
    const res = await fetch(STANDARD_CSV_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { codes: parse(await res.text()), source: STANDARD_CSV_URL }
  } catch (e) {
    if (existsSync(STANDARD_CSV_LOCAL)) {
      return {
        codes: parse(readFileSync(STANDARD_CSV_LOCAL, 'utf8')),
        source: `${STANDARD_CSV_LOCAL}（ネットワーク不通のためクローンを使用。古い可能性があります）`,
      }
    }
    return { codes: null, error: e, tried: STANDARD_CSV_URL }
  }
}
