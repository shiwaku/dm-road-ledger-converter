import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { LAYERS, PROP_ORDER, SOURCE_ID } from './layers';

// PMTiles を pmtiles:// スキームで読めるようにする
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const TILES = `pmtiles://${location.origin}${import.meta.env.BASE_URL}road_ledger.pmtiles`;

// 背景は地理院タイル（淡色）。ラスタなのでスタイルJSONを別途用意しなくてよい。
const map = new maplibregl.Map({
  container: 'map',
  hash: true,
  minZoom: 4,
  maxZoom: 21,
  style: {
    version: 8,
    // 注記の描画にフォントグリフが要る。地理院の配信を借りる。
    glyphs: 'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf',
    sources: {
      pale: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
      },
    },
    layers: [{ id: 'pale', type: 'raster', source: 'pale', paint: { 'raster-opacity': 0.75 } }],
  },
  center: [135.4696, 34.7805],
  zoom: 17,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }));
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), 'top-right');

const statusEl = document.getElementById('status') as HTMLElement;
const setStatus = (msg: string, isError = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle('is-error', isError);
  statusEl.classList.toggle('is-hidden', msg === '');
};

map.on('load', async () => {
  try {
    // 中身を確認してから追加する。タイルが無いときに白画面のまま黙るのを避ける。
    const res = await fetch(`${import.meta.env.BASE_URL}road_ledger.pmtiles`, { method: 'HEAD' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    setStatus(
      'road_ledger.pmtiles を読み込めませんでした。リポジトリ直下で scripts/build.sh を実行してから npm run dev し直してください。',
      true,
    );
    return;
  }

  map.addSource(SOURCE_ID, { type: 'vector', url: TILES });

  for (const def of LAYERS) {
    for (const spec of def.spec) map.addLayer(spec);
  }

  buildLayerToggles();
  setStatus('');

  // タイルの範囲へ寄せる
  const src = map.getSource(SOURCE_ID) as maplibregl.VectorTileSource | undefined;
  const bounds = src?.bounds;
  if (bounds && bounds.length === 4) {
    map.fitBounds(bounds as [number, number, number, number], { padding: 40, duration: 0 });
  }
});

map.on('error', (e) => {
  // タイル1枚の失敗で常時エラー表示にはしない
  if (e?.error?.message) console.warn(e.error.message);
});

// ---- レイヤー切替 ----
function buildLayerToggles() {
  const box = document.getElementById('layers') as HTMLElement;
  box.innerHTML = '';

  for (const def of LAYERS) {
    const id = `toggle-${def.id}`;
    const row = document.createElement('label');
    row.className = 'toggle';
    row.innerHTML = `
      <input type="checkbox" id="${id}" checked />
      <span class="swatch" style="background:${def.color}"></span>
      <span class="toggle-label">${def.label}</span>`;
    const input = row.querySelector('input') as HTMLInputElement;
    input.addEventListener('change', () => {
      for (const l of def.mapLayers) {
        if (map.getLayer(l)) {
          map.setLayoutProperty(l, 'visibility', input.checked ? 'visible' : 'none');
        }
      }
    });
    box.appendChild(row);
  }

  const setAll = (on: boolean) => {
    for (const def of LAYERS) {
      const input = document.getElementById(`toggle-${def.id}`) as HTMLInputElement;
      input.checked = on;
      input.dispatchEvent(new Event('change'));
    }
  };
  (document.getElementById('all-on') as HTMLElement).onclick = () => setAll(true);
  (document.getElementById('all-off') as HTMLElement).onclick = () => setAll(false);
}

// ---- ポップアップ ----
const ALL_MAP_LAYERS = LAYERS.flatMap((d) => d.mapLayers);

map.on('click', (e) => {
  const layers = ALL_MAP_LAYERS.filter((l) => map.getLayer(l));
  if (layers.length === 0) return;

  // クリック地点そのものだと点を取りこぼすので、少し広げて拾う
  const r = 4;
  const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
    [e.point.x - r, e.point.y - r],
    [e.point.x + r, e.point.y + r],
  ];
  const feats = map.queryRenderedFeatures(bbox, { layers });
  if (feats.length === 0) return;

  const html = feats
    .slice(0, 10)
    .map((f) => {
      const props = f.properties ?? {};
      const keys = Object.keys(props).sort((a, b) => {
        const ia = PROP_ORDER.indexOf(a);
        const ib = PROP_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      const rows = keys
        .map(
          (k) =>
            `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(props[k]))}</td></tr>`,
        )
        .join('');
      return `<div class="pop-item"><div class="pop-head">${escapeHtml(
        String(f.sourceLayer ?? ''),
      )}</div><table>${rows}</table></div>`;
    })
    .join('');

  new maplibregl.Popup({ maxWidth: '320px' })
    .setLngLat(e.lngLat)
    .setHTML(`<div class="pop">${html}${feats.length > 10 ? '<p class="pop-more">ほか ' + (feats.length - 10) + ' 件</p>' : ''}</div>`)
    .addTo(map);
});

map.on('mousemove', (e) => {
  const layers = ALL_MAP_LAYERS.filter((l) => map.getLayer(l));
  if (layers.length === 0) return;
  const hit = map.queryRenderedFeatures(e.point, { layers }).length > 0;
  map.getCanvas().style.cursor = hit ? 'pointer' : '';
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string;
  });
}

// ---- パネル開閉 ----
const panelBody = document.getElementById('panel-body') as HTMLElement;
const collapseBtn = document.getElementById('collapse-btn') as HTMLButtonElement;
collapseBtn.addEventListener('click', () => {
  const hidden = panelBody.classList.toggle('is-hidden');
  collapseBtn.textContent = hidden ? '▾' : '▴';
});
collapseBtn.textContent = '▴';
