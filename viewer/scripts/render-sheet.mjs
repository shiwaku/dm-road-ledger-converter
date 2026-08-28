// -----------------------------------------
// ビューワを図郭と同じ範囲・同じ縮尺・同じ方位でヘッドレス描画してPNGにする。
//
// 有無の照合（reconcile-pdf.py）も実測（measure-pdf.py）も、見ているのは
// **変換結果とスタイルの指定値**であって、画面に出た絵ではない。
// 衝突判定で間引かれるラベルや、縦書き・線幅が実際にどう出ているかは、
// 描いたものを測らないと分からない。その「描いたもの」を作るのがこのスクリプト。
//
// 範囲は fitBounds では合わない。図郭は平面直角座標の矩形で、Webメルカトルでは
// わずかに回った平行四辺形になるため、緯度経度の外接矩形に合わせると図郭より広く、
// しかも子午線収差のぶん北がずれる。中心・ズーム・方位を計算して jumpTo する
// （計算は scripts/raster-diff.py 側。ここは受け取った値をそのまま使う）。
//
// 使い方（viewer/ で。ふつうは raster-diff.py から呼ばれる）
//     node scripts/render-sheet.mjs --center 135.4696,34.7806 --zoom 17.97 --bearing -0.3 \
//       --width 1600 --height 1200 --out sheet.png
//
// Chrome は端末に入っているものを使う（ブラウザは落としてこない）。
// 場所が違う場合は CHROME_PATH で指定する。
// -----------------------------------------
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIEWER = join(HERE, '..')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

function chromePath() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p
  throw new Error(
    'Chrome が見つかりません。CHROME_PATH で指定してください。探した場所: ' +
      CHROME_CANDIDATES.join(' / '),
  )
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/** 空いているポートを1つ借りて返す。 */
function freePort() {
  return new Promise((ok, ng) => {
    const srv = createServer()
    srv.on('error', ng)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => ok(port))
    })
  })
}

/**
 * vite の dev サーバを起こし、待ち受けたURLを返す。
 *
 * vite.config が strictPort: true なので、既定のポートが埋まっていると
 * 黙って別のポートに移らず起動に失敗する。前の実行が残っていると詰まるため、
 * 空きポートをこちらで確保してから渡す。
 */
async function startVite() {
  const port = await freePort()
  return new Promise((ok, ng) => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const proc = spawn(npx, ['vite', '--port', String(port)], {
      cwd: VIEWER,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let out = ''
    // vite の出力は色付けのエスケープが数字を挟むので、落としてから読む
    const CSI = String.fromCharCode(27) + '['
    const plain = (t) =>
      t.split(CSI).map((seg, k) => (k ? seg.replace(/^[0-9;]*m/, '') : seg)).join('')
    const timer = setTimeout(() => ng(new Error('vite が起動しません: ' + out)), 60000)
    const look = () => {
      const i = out.indexOf('localhost:')
      if (i < 0) return
      const m = out.slice(i + 'localhost:'.length).match(/^[0-9]+/)
      if (!m) return
      clearTimeout(timer)
      ok({ proc, url: 'http://localhost:' + m[0] + '/' })
    }
    proc.stdout.on('data', (b) => { out += plain(b.toString()); look() })
    proc.stderr.on('data', (b) => { out += plain(b.toString()) })
    proc.on('exit', (c) => { clearTimeout(timer); ng(new Error('vite が終了しました code ' + c + ' ' + out)) })
  })
}

/**
 * vite を確実に落とす。
 *
 * Windows では shell 経由で起動するため kill() が届くのは cmd.exe までで、
 * その先の vite は生き残る。残ると strictPort のポートを掴んだままになり、
 * 次の実行が起動に失敗する。プロセスツリーごと落とす。
 */
function stopVite(proc) {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      proc.kill()
    }
  } else {
    proc.kill()
  }
}

const center = arg('center', '').split(',').map(Number)
if (center.length !== 2 || center.some(Number.isNaN)) {
  console.error('--center 経度,緯度 を指定してください')
  process.exit(1)
}
const zoom = Number(arg('zoom', ''))
const bearing = Number(arg('bearing', '0'))
if (Number.isNaN(zoom)) {
  console.error('--zoom を指定してください')
  process.exit(1)
}
const width = Number(arg('width', 1600))
const height = Number(arg('height', 1200))
const out = resolve(arg('out', join(VIEWER, 'sheet.png')))
const base = arg('base', 'blank')

const { proc, url } = await startVite()
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--hide-scrollbars'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error('  [page error]', e.message))

  // ?debug で window.__dmMap が生え、WebGLの描画結果が読み戻せるようになる。
  // preserveDrawingBuffer が既定の false のままだと、撮った絵が真っ白になる
  await page.goto(url + '?debug', { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction('window.__dmMap', { timeout: 60000 })

  // 背景を消す（白図）。setStyle が走り、データレイヤーは次の idle で貼り直される。
  // その idle を「描画完了」と取ると、データが乗る前の絵を撮ってしまう
  await page.click('button[data-base="' + base + '"]')
  await page.waitForFunction(
    () => {
      const m = window.__dmMap
      if (!m || !m.isStyleLoaded()) return false
      if (!m.getSource('road-ledger')) return false
      return m.getStyle().layers.some((l) => l.id.startsWith('road_'))
    },
    { timeout: 120000, polling: 250 },
  )

  // 背景を切り替えてからUIと診断HUDを消す。先に消すとボタンが押せない
  await page.addStyleTag({
    content:
      '.maplibregl-control-container, #panel, #status, #diag-hud { display: none !important; }',
  })

  await page.evaluate((v) => {
    window.__dmMap.jumpTo({ center: v.center, zoom: v.zoom, bearing: v.bearing, pitch: 0 })
  }, { center, zoom, bearing })

  // タイルとスプライトが出そろうまで待つ。地物が1つも描かれていない状態で
  // 「完了」と見なさないよう、実際に描かれた数も条件に入れる
  await page.waitForFunction(
    () => {
      const m = window.__dmMap
      if (!m.loaded() || !m.areTilesLoaded()) return false
      const ids = m.getStyle().layers.map((l) => l.id).filter((i) => i.startsWith('road_'))
      return m.queryRenderedFeatures({ layers: ids }).length > 0
    },
    { timeout: 180000, polling: 250 },
  )
  await new Promise((r) => setTimeout(r, 2000))   // ラベルの配置が落ち着くのを待つ

  const got = await page.evaluate(() => {
    const m = window.__dmMap
    const c = m.getCenter()
    const ids = m.getStyle().layers.map((l) => l.id).filter((i) => i.startsWith('road_'))
    return {
      lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(),
      features: m.queryRenderedFeatures({ layers: ids }).length, layers: ids.length,
    }
  })
  // ページのスクリーンショットではなく、WebGLキャンバスから直に読み出す。
  // 合成経由だと地図が真っ白で返ることがあり、UIが重なる余地も残る。
  // ここで読めるのは canvasContextAttributes.preserveDrawingBuffer が真のときだけ
  const dataUrl = await page.evaluate(() => window.__dmMap.getCanvas().toDataURL('image/png'))
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const buf = Buffer.from(b64, 'base64')
  if (buf.length < 1024) throw new Error('キャンバスが読み出せませんでした（' + buf.length + 'バイト）')
  writeFileSync(out, buf)

  // 実際に描かれた状態を返す。指定と食い違ったまま差分を取ると全部ずれる
  console.log(JSON.stringify({ out, width, height, ...got }))
} finally {
  await browser.close()
  stopVite(proc)
  // vite を落としても pipe が残って event loop が終わらないことがある。
  // ここまで来れば用は済んでいるので明示的に終える
  process.exit(0)
}
