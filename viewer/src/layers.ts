// -----------------------------------------
// レイヤー定義
//
// 道路台帳図の分類コードは自治体・測量ベンダーによって運用が異なり、
// 全国共通の図式として確定していない。そのため現段階では分類コードごとの
// 描き分けは行わず、DMのレコード種別（線・面・記号・方向・注記）ごとに
// 単純なスタイルを与えている。属性はポップアップで確認できる。
// -----------------------------------------
import type { LayerSpecification } from 'maplibre-gl';

export const SOURCE_ID = 'road-ledger';

/** タイル側のレイヤー名（scripts/build.sh の KINDS と対応） */
export type SourceLayer =
  | 'road_line'
  | 'road_polygon'
  | 'road_symbol'
  | 'road_direction'
  | 'road_annotation';

export interface LayerDef {
  /** 表示切替のキー */
  id: string;
  /** パネルに出す日本語名 */
  label: string;
  /** 凡例に使う色 */
  color: string;
  /** このトグルが制御するMapLibreレイヤーのID */
  mapLayers: string[];
  spec: LayerSpecification[];
}

const C = {
  line: '#3d5a80',
  polygon: '#98c1d9',
  polygonLine: '#5b8fb0',
  symbol: '#ee6c4d',
  direction: '#8e7dbe',
  annotation: '#1f2933',
  annotationHalo: '#ffffff',
};

// 記号・方向・注記はタイル生成時に ZL17 未満を除外している
// （scripts/build.sh の SYMBOL_MIN_ZOOM 等）。表示側の minzoom もそれに揃える。
const DETAIL_MINZOOM = 17;

export const LAYERS: LayerDef[] = [
  {
    id: 'polygon',
    label: '面',
    color: C.polygon,
    mapLayers: ['road-polygon-fill', 'road-polygon-line'],
    spec: [
      {
        id: 'road-polygon-fill',
        type: 'fill',
        source: SOURCE_ID,
        'source-layer': 'road_polygon',
        paint: { 'fill-color': C.polygon, 'fill-opacity': 0.35 },
      },
      {
        id: 'road-polygon-line',
        type: 'line',
        source: SOURCE_ID,
        'source-layer': 'road_polygon',
        paint: { 'line-color': C.polygonLine, 'line-width': 0.8 },
      },
    ],
  },
  {
    id: 'line',
    label: '線',
    color: C.line,
    mapLayers: ['road-line'],
    spec: [
      {
        id: 'road-line',
        type: 'line',
        source: SOURCE_ID,
        'source-layer': 'road_line',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.line,
          // 引いたときに潰れないよう、ズームに応じて細くする
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 18, 1.4],
        },
      },
    ],
  },
  {
    id: 'symbol',
    label: '記号',
    color: C.symbol,
    mapLayers: ['road-symbol'],
    spec: [
      {
        id: 'road-symbol',
        type: 'circle',
        source: SOURCE_ID,
        'source-layer': 'road_symbol',
        minzoom: DETAIL_MINZOOM,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 17, 2, 20, 4],
          'circle-color': C.symbol,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 0.6,
        },
      },
    ],
  },
  {
    id: 'direction',
    label: '方向',
    color: C.direction,
    mapLayers: ['road-direction'],
    spec: [
      {
        id: 'road-direction',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_direction',
        minzoom: DETAIL_MINZOOM,
        layout: {
          'text-field': '➤',
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 20, 16],
          // Angle は「東を0度とする反時計回り」。MapLibre の text-rotate は
          // 「北を0度とする時計回り」なので 90 - Angle で読み替える。
          'text-rotate': ['-', 90, ['to-number', ['get', 'Angle'], 0]],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': C.direction,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1,
        },
      },
    ],
  },
  {
    id: 'annotation',
    label: '注記',
    color: C.annotation,
    mapLayers: ['road-annotation'],
    spec: [
      {
        id: 'road-annotation',
        type: 'symbol',
        source: SOURCE_ID,
        'source-layer': 'road_annotation',
        minzoom: DETAIL_MINZOOM,
        layout: {
          'text-field': ['get', 'Text'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10, 20, 14],
          // 注記の Angle も方向と同じ規約
          'text-rotate': ['-', 90, ['to-number', ['get', 'Angle'], 0]],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-max-width': 20,
        },
        paint: {
          'text-color': C.annotation,
          'text-halo-color': C.annotationHalo,
          'text-halo-width': 1.4,
        },
      },
    ],
  },
];

/** ポップアップに出す属性の並び順。ここに無いものは後ろにまとめる。 */
export const PROP_ORDER = [
  'Code',
  'Text',
  'Angle',
  'Seq',
  'Elno',
  'Scale',
  'RecordType',
  'DataType',
  'DataKind',
  'Vnflag',
];
