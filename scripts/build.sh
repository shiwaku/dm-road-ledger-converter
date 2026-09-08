#!/usr/bin/env bash
#
# DM → GeoJSON → GeoParquet / PMTiles を一括で生成する。
#
# GeoJSON だけ作り直して GeoParquet や PMTiles が古いまま残ると、
# 配信データと変換結果が食い違う。ここでまとめて焼き直す。
#
# 使い方:
#   scripts/build.sh                         # ../DMデータ/ を変換
#   scripts/build.sh /path/to/dm_dir         # 入力フォルダを指定
#
# 環境変数:
#   EPSG=6674        入力データの座標参照系（既定: src/index.js の既定値 6674）
#   JOBS=4           並列数（既定: src/index.js の既定値 = CPUコア数-1）
#   MAXZOOM=18       タイルの最大ズーム（既定: 18 = 地図情報レベル500）
#   MINZOOM=15       タイルの最小ズーム（既定: 15）
#   SKIP_CONVERT=1   DM→GeoJSON を飛ばし、既存の GeoJSON から後段だけ作り直す
#   SKIP_CHECK=1     分類コードの点検を飛ばす（ネットワークが要るため）
#   SKIP_PARQUET=1   GeoParquet を作らない
#   SKIP_TILES=1     MBTiles / PMTiles を作らない
#
#   VITE_DM_PROVIDERS=...  点検で使う拡張DMの提供元（既定はビューワと同じ）
#   ATTRIBUTION="..."      タイルのメタデータに入れる帰属・承認の文言（tippecanoe -A）。
#                          測量成果の使用承認で明示を求められる文言を、承認書の指定どおりに
#                          書く。未指定なら入れず、最後に注意を出す（ビューワの表示は
#                          viewer の VITE_DM_ATTRIBUTION が別に持つ）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/output"
INPUT="${1:-}"

# 地物種別。GeoJSON のファイル名サフィックスと、タイルのレイヤー名の対応。
KINDS=(線:line 面:polygon 記号:symbol 方向:direction 注記:annotation)

# 地図情報レベル500の許容誤差は 500 × 図上0.1mm = 0.05m。
# 分解能 = 40,075,016.686m ÷ (2^ZL × 4,096) がこれを下回る最小のZLは18（0.037m）。
# ZL17 は 0.075m で許容誤差を超える。1/1,000 のデータを扱う場合は17で足りる。
ZMAX="${MAXZOOM:-18}"
# 1/500 のデータを引いて見ても読めないため、低ズームのタイルは作らない。
ZMIN="${MINZOOM:-15}"

# 記号・方向・注記はこのZL未満では描いても読めないので、タイルに入れない。
SYMBOL_MIN_ZOOM=17
DIRECTION_MIN_ZOOM=17
ANNOTATION_MIN_ZOOM=17

# タイルに残す属性。描画に必要なものだけに絞る。
# Elno はフィーチャごとにユニークな文字列で、タイル内の文字列辞書を最も膨らませる。
# RecordType / DataType / DataKind / Scale / Vnflag はポップアップ表示専用のため落とす。
# Seq はビューワが電柱の向き（複数ペアのE6）を要素につき1個のアイコンで描くのに使う。
TILE_ATTRS=(Code Text Angle Elev Seq)

have() { command -v "$1" >/dev/null 2>&1; }
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---- Parquet ドライバを持つ ogr2ogr を探す ----
# GDAL は Parquet ドライバを含まないビルドが多い（conda 版・Debian 版とも既定では未収録）。
# WSL 環境では OSGeo4W の Windows 版に収録されているため、そちらへフォールバックする。
# それも無ければ geopandas を使う。
OGR=""
OGR_WIN=0

# ドライバ一覧はパイプで grep せず変数に取ってから判定する。
# `cmd | grep -q` は grep が先に終了すると cmd が SIGPIPE で落ち、
# pipefail 下ではパイプライン全体が失敗扱いになる（タイミング依存で再現する）。
has_parquet() {
  local out
  out="$("$1" --formats 2>/dev/null || true)"
  case "$out" in *[Pp]arquet*) return 0 ;; *) return 1 ;; esac
}

find_ogr2ogr() {
  if have ogr2ogr && has_parquet ogr2ogr; then
    OGR="ogr2ogr"; return 0
  fi
  for exe in /mnt/c/OSGeo4W/bin/ogr2ogr.exe /mnt/c/OSGeo4W64/bin/ogr2ogr.exe; do
    if [ -x "$exe" ] && has_parquet "$exe"; then
      OGR="$exe"; OGR_WIN=1; return 0
    fi
  done
  return 1
}

# OSGeo4W の Windows 版を使う場合は Windows 形式のパスを渡す必要がある。
ogr_path() {
  if [ "$OGR_WIN" = "1" ]; then wslpath -w "$1"; else printf '%s' "$1"; fi
}

has_geopandas() {
  have python && python -c "import geopandas" >/dev/null 2>&1
}

# レイヤーごと閾値未満のズームで落とす条件。
keep_from_zoom() {
  printf '[">=", "$zoom", %s]' "$1"
}

# tippecanoe の --feature-filter 式（レイヤー名 → 残す条件）を組み立てる。
tile_filter() {
  printf '{'
  printf '"road_symbol": %s, '     "$(keep_from_zoom "$SYMBOL_MIN_ZOOM")"
  printf '"road_direction": %s, '  "$(keep_from_zoom "$DIRECTION_MIN_ZOOM")"
  printf '"road_annotation": %s'   "$(keep_from_zoom "$ANNOTATION_MIN_ZOOM")"
  printf '}'
}

# ---- 1. DM → GeoJSON ----
if [ "${SKIP_CONVERT:-}" = "1" ]; then
  echo "DM→GeoJSON をスキップ"
else
  log "DM → GeoJSON"
  ARGS=()
  [ -n "$INPUT" ] && ARGS+=(--input "$INPUT")
  [ -n "${EPSG:-}" ] && ARGS+=(--epsg "$EPSG")
  [ -n "${JOBS:-}" ] && ARGS+=(--jobs "$JOBS")
  node "$ROOT/src/index.js" "${ARGS[@]}"
fi

# 以降は生成された GeoJSON が対象
for kv in "${KINDS[@]}"; do
  if [ ! -f "$OUT/道路台帳図_${kv%%:*}.geojson" ]; then
    echo "GeoJSON が揃っていないため後段をスキップ"
    exit 0
  fi
done

# ---- 2. 分類コードの点検 ----
# 道路台帳図には標準図式に無い自治体固有のコードが混ざる（豊中サンプルで28コード・860件）。
# 混ざること自体は普通のことなのでビルドは止めない。ただし、拡張DMのアイコンを
# 持っているのに提供元を指定していない場合は**エラーにならないまま丸に落ちる**ので、
# 最後にまとめて注意を出す。
CHECK_RC=0
if [ "${SKIP_CHECK:-}" = "1" ]; then
  echo "分類コードの点検をスキップ"
else
  log "分類コードの点検"
  node "$ROOT/scripts/check-extended-codes.mjs" || CHECK_RC=$?
fi

# ---- 3. GeoJSON → GeoParquet ----
if [ "${SKIP_PARQUET:-}" = "1" ]; then
  echo "GeoParquet をスキップ"
elif find_ogr2ogr; then
  log "GeoParquet 生成  [$OGR]"
  for kv in "${KINDS[@]}"; do
    SRC="$OUT/道路台帳図_${kv%%:*}.geojson"
    DST="${SRC%.geojson}.parquet"
    rm -f "$DST"
    if "$OGR" -f Parquet "$(ogr_path "$DST")" "$(ogr_path "$SRC")"; then
      echo "  $(basename "$DST")"
    else
      echo "  !! $(basename "$DST") の生成に失敗"
    fi
  done
elif has_geopandas; then
  log "GeoParquet 生成  [geopandas]"
  SRCS=()
  for kv in "${KINDS[@]}"; do SRCS+=("$OUT/道路台帳図_${kv%%:*}.geojson"); done
  python "$ROOT/scripts/geojson2parquet.py" "${SRCS[@]}"
else
  echo "Parquet ドライバを持つ ogr2ogr も geopandas も無いため GeoParquet をスキップ"
  echo "（OSGeo4W を入れるか、pip install geopandas pyarrow してください）"
fi

# 点検の結果はビルドの成否と別なので、途中で抜ける経路でも必ず出す。
report_check() {
  [ "$CHECK_RC" = "1" ] && printf '\n\033[1m!! 拡張DMコードの提供元が指定から漏れています（上の点検を参照）\033[0m\n'
  return 0
}
trap report_check EXIT

# ---- 4. GeoJSON → MBTiles → PMTiles ----
if [ "${SKIP_TILES:-}" = "1" ]; then
  echo "タイル生成をスキップ"
  exit 0
fi
if ! have tippecanoe || ! have pmtiles; then
  echo "tippecanoe / pmtiles が見つからないためタイル生成をスキップ"
  exit 0
fi

log "ベクトルタイル生成 (Z$ZMIN-z$ZMAX)"
LAYER_ARGS=()
for kv in "${KINDS[@]}"; do
  LAYER_ARGS+=(-L "road_${kv##*:}:$OUT/道路台帳図_${kv%%:*}.geojson")
done
# -y は「この属性だけ残す」の意味。
ATTR_ARGS=()
for attr in "${TILE_ATTRS[@]}"; do ATTR_ARGS+=(-y "$attr"); done

# タイルのメタデータ。name は既定だと mbtiles のフルパスになり、配布物に
# ローカルのパスが残るので固定する。attribution は承認書の文言をそのまま入れる。
# タイルは単体で QGIS 等に読まれることがあり、ビューワの表示とは別に持たせる必要がある。
META_ARGS=(-n "道路台帳平面図（DM）")
if [ -n "${ATTRIBUTION:-}" ]; then
  META_ARGS+=(-A "$ATTRIBUTION")
fi

tippecanoe \
  -o "$OUT/road_ledger.mbtiles" \
  -Z "$ZMIN" -z "$ZMAX" \
  -r1 \
  --no-feature-limit \
  --no-tile-size-limit \
  --force \
  "${META_ARGS[@]}" \
  "${ATTR_ARGS[@]}" \
  -j "$(tile_filter)" \
  "${LAYER_ARGS[@]}"

pmtiles convert "$OUT/road_ledger.mbtiles" "$OUT/road_ledger.pmtiles"
echo "  road_ledger.pmtiles"
if [ -z "${ATTRIBUTION:-}" ]; then
  printf '\n\033[1m!! タイルに帰属・承認の文言が入っていません（ATTRIBUTION 未指定）\033[0m\n'
  echo "   測量成果の使用承認で明示を求められている場合は、承認書の文言をそのまま指定してください。"
  echo "   例: ATTRIBUTION='測量法に基づく豊中市長承認（使用）R8 豊基管第304号' scripts/build.sh ..."
fi

log "完了"
ls -la "$OUT" | awk 'NR>3 {printf "  %10d  %s\n", $5, $9}'
