// -----------------------------------------
// クリックの当たり判定を実際に拾わせて、何がどれだけ離れていたかを出す。
//
// ポップアップに「近くの地物」が混ざる原因は絵からは分からない。
// queryRenderedFeatures が返した地物と、クリック地点からの実距離を並べて見る。
//
// 使い方（viewer/ で）
//     node scripts/probe-hit.mjs --center 135.469108,34.781642 --zoom 19
//     node scripts/probe-hit.mjs --center ... --zoom 19 --offset 40,0
//
// --offset は画面中心からのクリック位置のずれ（px）。
// -----------------------------------------
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  throw new Error('Chrome が見つかりません。CHROME_PATH で指定してください。')
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

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
    proc.on('exit', (c) => { clearTimeout(timer); ng(new Error('vite 終了 code ' + c + ' ' + out)) })
  })
}

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
const zoom = Number(arg('zoom', '19'))
const offset = arg('offset', '0,0').split(',').map(Number)
const width = 900
const height = 900

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
  await page.goto(url + '?debug', { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction('window.__dmMap', { timeout: 60000 })
  await page.click('button[data-base="blank"]')
  await page.waitForFunction(
    () => {
      const m = window.__dmMap
      return m && m.isStyleLoaded() && m.getSource('road-ledger') &&
        m.getStyle().layers.some((l) => l.id.startsWith('road_'))
    },
    { timeout: 120000, polling: 250 },
  )
  // jumpTo のあとは **idle を待つ**。記号の当たり判定は配置計算（placement）の結果を
  // 使うため、タイル読み込みだけを待つと前の表示位置の当たり判定を拾う
  // （実際に120m離れた地物が返った）。
  await page.evaluate((v) => {
    const m = window.__dmMap
    window.__idle = false
    m.once('idle', () => { window.__idle = true })
    m.jumpTo({ center: v.center, zoom: v.zoom, bearing: 0, pitch: 0 })
  }, { center, zoom })
  await page.waitForFunction(
    () => window.__idle && window.__dmMap.areTilesLoaded() && window.__dmMap.isStyleLoaded(),
    { timeout: 60000, polling: 200 },
  )

  const res = await page.evaluate((v) => {
    const m = window.__dmMap
    const R = 4 // main.ts の HIT_RADIUS_PX
    const pt = { x: v.width / 2 + v.offset[0], y: v.height / 2 + v.offset[1] }
    const box = [[pt.x - R, pt.y - R], [pt.x + R, pt.y + R]]
    const ids = m.getStyle().layers
      .map((l) => l.id)
      .filter((id) => id.startsWith('road_'))
      .filter((id) => !id.endsWith('_outline') && !id.endsWith('_elev'))
      .filter((id) => m.getLayoutProperty(id, 'visibility') !== 'none')
    const click = m.unproject(pt)
    const feats = m.queryRenderedFeatures(box, { layers: ids })

    // 画面px → メートル（この緯度・ズームでの目安）
    const p0 = m.project(click)
    const p1 = { x: p0.x + 100, y: p0.y }
    const mPerPx = click.distanceTo(m.unproject(p1)) / 100

    // ビューワと同じ絞り込みを再現する（main.ts の withinIcon）。
    // 当たり半径は window.__dmHit が生えていればそれを使う。
    const hitOf = window.__dmHit
    const out = []
    for (const f of feats) {
      const g = f.geometry
      let dpx = null
      let dm = null
      let coord = null
      let reach = null
      let kept = true
      if (g.type === 'Point') {
        coord = g.coordinates
        const q = m.project({ lng: coord[0], lat: coord[1] })
        dpx = Math.hypot(q.x - pt.x, q.y - pt.y)
        dm = click.distanceTo({ lng: coord[0], lat: coord[1] })
      }
      if (hitOf) {
        kept = hitOf(f, pt)
        if (g.type === 'Point') reach = hitOf.reach(f, m.getZoom())
      }
      out.push({
        layer: f.layer.id,
        code: f.properties && f.properties.Code,
        text: f.properties && f.properties.Text,
        gtype: g.type,
        dpx,
        dm,
        coord,
        reach,
        kept,
      })
    }
    // ポップアップに実際に並ぶ項目（絞り込み＋重複の畳み込みまで通したもの）
    const items = hitOf && hitOf.items
      ? hitOf.items(pt).map((it) => `${it.groupName} ${it.props.Code ?? ''}` +
          (it.props.Seq ? ` Seq=${it.props.Seq}` : '') +
          (it.props.Text ? ` ${it.props.Text}` : ''))
      : null
    return {
      out, items, mPerPx, zoom: m.getZoom(), ids,
      click: { lng: click.lng, lat: click.lat },
      mapCenter: m.getCenter(),
      canvas: { w: m.getCanvas().clientWidth, h: m.getCanvas().clientHeight },
    }
  }, { width, height, offset })

  const mpp = res.mPerPx
  console.log(`zoom ${res.zoom.toFixed(2)}  1px = ${mpp.toFixed(4)}m  ` +
    `クリック位置 中心から ${offset[0]},${offset[1]}px`)
  console.log(`当たり判定 9x9px（HIT_RADIUS_PX=4）= 地上 ${(9 * mpp).toFixed(2)}m 角`)
  console.log(`拾ったレイヤー ${res.ids.length} / 返った地物 ${res.out.length} 件`)
  console.log('')
  console.log(`地図中心 ${res.mapCenter.lng.toFixed(6)},${res.mapCenter.lat.toFixed(6)}  ` +
    `クリック ${res.click.lng.toFixed(6)},${res.click.lat.toFixed(6)}  ` +
    `キャンバス ${res.canvas.w}x${res.canvas.h}`)
  console.log('')
  const kept = res.out.filter((r) => r.kept)
  console.log(`絞り込み後 ${kept.length} 件（落とした ${res.out.length - kept.length} 件）`)
  console.log('')
  console.log('  採否 レイヤー                     コード  距離      当たり半径')
  for (const r of res.out) {
    const d = r.dpx == null ? '（点でない）' : `${(r.dpx * mpp).toFixed(2)}m`
    const rc = r.reach == null ? '' : `${(r.reach * mpp).toFixed(2)}m`
    console.log(`  ${r.kept ? '○' : '×'}    ${String(r.layer).padEnd(28)} ` +
      `${String(r.code ?? '').padEnd(7)} ${d.padStart(9)} ${rc.padStart(11)}` +
      `${r.text ? '  ' + r.text : ''}`)
  }
  if (res.items) {
    console.log('')
    console.log(`ポップアップに並ぶ項目 ${res.items.length} 件`)
    for (const t of res.items) console.log(`  ・${t}`)
  }
} finally {
  await browser.close()
  stopVite(proc)
  process.exit(0)
}
