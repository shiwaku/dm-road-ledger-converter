// -----------------------------------------
// DMファイル群を種別ごとの Writer へ振り分ける変換ループ。
// 逐次実行（index.js）とワーカー（worker.js）の両方から使う。
// -----------------------------------------
const DM = require('./dm');
const { DATATYPE_MAP } = DM;

/** 出力種別。Writer の並び順とファイル名サフィックスの対応。 */
const KINDS = ['線', '面', '記号', '方向', '注記'];

/**
 * Eレコードの標高値フィールド（50〜56桁）を標高として出す分類コード。
 *
 * このフィールドは分類コードによって意味が変わる。等高線（71xx）と標高点（7311・7312）
 * では標高がミリメートルで入るが、基準点系（7301〜7306）では点番号が入る。
 * 豊中市サンプルの `7306` は DM 側が `3013400`、提供元のシェープファイル版が
 * 点番号 `30134`／標高 `26.05` を別フィールドに持っており、標高ではないと判断できる。
 *
 * 本ツールは通常、分類コードを解釈せず `Code` として素通しする。ここだけは例外で、
 * コードを見なければ標高か点番号かを区別できないため、対象を明示的に列挙している。
 * 対象外のコードでは `Elev` を空にする（値を捨てる）。
 */
const ELEV_CODES = new Set([
  '7101', '7102', '7103', '7104', // 等高線（計曲線・主曲線・補助曲線）
  '7105', '7106', '7107',         // 凹地
  '7311', '7312',                 // 標高点
]);

/** 標高点。等高線と違い、図面では標高を小数付きで描く。 */
const ELEV_POINT_CODES = new Set(['7311', '7312']);

/**
 * 標高値（メートル）。対象外のコードと値が入っていないレコードでは空文字を返す。
 * DMはミリメートルで持つため1000で割る（`27300` → `27.3`）。
 *
 * 標高点は小数1桁に揃える（`27000` → `27.0`）。割り切れると `27` になり、
 * 隣に並ぶ `26.1` と桁数が揃わず標高だと読み取りにくくなるため。
 * 桁を増やすだけで丸めはしない（`25730` は `25.73` のまま）。
 * 等高線は図面が整数で描くので何もしない。
 *
 * `0` は「未記録」として空にする。豊中市サンプルの `7311`（標石を有しない標高点）は
 * 70件すべてこのフィールドが0で、レコード中に標高値そのものが無い（提供元の
 * シェープファイル版は別途 `Z_COORD` に標高を持つが、DM側には現れない）。
 * そのまま0を出すと図面に「0」という標高が並ぶため出さない。
 * 標高0.000mの地物も落ちるが、実在するとしても海面高の等高線だけで影響は小さい。
 */
function elevOf(dat) {
  if (!ELEV_CODES.has(dat.LAYER)) return '';
  const raw = dat.ELEV;
  if (raw === undefined || raw === '') return '';
  const mm = Number(raw);
  if (!Number.isFinite(mm) || mm === 0) return '';
  const m = mm / 1000;
  if (ELEV_POINT_CODES.has(dat.LAYER) && Number.isInteger(m)) return m.toFixed(1);
  return m;
}

/**
 * 注記の文字列。`￥`（U+FFE5・JIS `216F`）は改行位置を示すマーカーなので改行に置き換える。
 *
 * 図面では実際にここで行が割れており、そのまま出すと
 * `パラツィーナ￥エスタ桜塚` のように記号として表示されてしまう。
 * 出力はGeoJSONなので改行は `\n` としてエスケープされ、
 * MapLibre の `text-field` はこれを改行として描く。
 */
function textOf(dat) {
  return (dat.TEXT || '').replace(/￥/g, '\n');
}

/** 全種別に共通する属性。 */
function setCommon(w, dat) {
  w.setPropertie('Code',       dat.LAYER       || '');
  w.setPropertie('Elno',       dat.ELNO        || '');
  w.setPropertie('Scale',      dat.SCALE       || '');
  w.setPropertie('Elev',       elevOf(dat));
  w.setPropertie('RecordType', dat.RECORD_TYPE || '');
  w.setPropertie('DataType',   dat.DATA_TYPE   || '');
  w.setPropertie('DataKind',   dat.DATA_KIND   || '');
}

/**
 * 変換対象外として読み飛ばしたレコードの集計。
 *
 * @typedef  {object} Skipped
 * @property {Object<string, number>} counts  レコード種別ごとの件数（`{ E4: 8 }`）
 * @property {string[]}               files   該当レコードを含んでいた .dm ファイル
 */

/** 空の集計。 */
function emptySkipped() {
  return { counts: {}, files: [] };
}

/** 集計を破壊的に足し合わせる。ワーカーごとの集計をまとめるのにも使う。 */
function mergeSkipped(into, add) {
  for (const [rectype, n] of Object.entries(add.counts)) {
    into.counts[rectype] = (into.counts[rectype] || 0) + n;
  }
  for (const f of add.files) {
    if (!into.files.includes(f)) into.files.push(f);
  }
  return into;
}

/**
 * 読み飛ばしたレコードがあれば警告として出す。無ければ何も出さない。
 *
 * 終了コードは変えない。円弧を使うDMも属性レコードを持つDMも正常なデータであり、
 * 「変換できない」のではなく「本ツールが出力しない」だけだから。
 * 利用者が図面との食い違いを追えるように、件数とファイルを見せるところまでを担う。
 */
function reportSkipped(skipped, log = console.warn) {
  const entries = Object.entries(skipped.counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return;

  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  log('');
  log(`警告: 変換対象外のレコードを ${total} 件読み飛ばしました（出力には現れません）`);

  // 件数の多い順。同数のときはレコード種別順にして、実行ごとに並びが変わらないようにする
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [rectype, n] of entries) {
    log(`  ${rectype} ${DATATYPE_MAP[rectype] || '不明'}: ${n}件`);
  }

  // 図面との食い違いを追えるようにファイル名を出す。多いときは頭だけにして流れ去らせない
  const SHOW = 10;
  log(`  該当ファイル: ${skipped.files.length}件`);
  for (const f of skipped.files.slice(0, SHOW)) log(`    ${f}`);
  if (skipped.files.length > SHOW) log(`    ほか ${skipped.files.length - SHOW}件`);
}

/**
 * @param {string[]} files    .dm ファイルのパス
 * @param {object}   writers  { 線, 面, 記号, 方向, 注記 } の GeoJSONWriter
 * @param {function} onFile   1ファイル処理するたびに呼ばれる（進捗表示用）
 * @returns {Skipped} 読み飛ばしたレコードの集計
 */
function convertFiles(files, writers, onFile) {
  const skipped = emptySkipped();

  for (const dmfile of files) {
    if (onFile) onFile(dmfile);
    const dats = new DM(dmfile);

    for (const dat of dats) {
      const fig = dat.FIGTYPE || '';

      if (fig === 'E2') {
        const w = writers['線'];
        w.setGeometry(1, dat.XYList);
        setCommon(w, dat);
        w.write();

      } else if (fig === 'E1') {
        const w = writers['面'];
        w.setGeometry(2, dat.XYList);
        setCommon(w, dat);
        w.write();

      } else if (fig === 'E5') {
        const w = writers['記号'];
        w.setGeometry(5, dat.XYList);
        setCommon(w, dat);
        w.write();

      } else if (fig === 'E6') {
        const w = writers['方向'];
        w.setGeometry(5, dat.XYList);
        w.setPropertie('Code',  dat.LAYER || '');
        w.setPropertie('Elno',  dat.ELNO  || '');
        // 1つのE6要素から複数本の方向が出るため、要素内の通し番号で区別する
        w.setPropertie('Seq',   dat.SEQ !== undefined ? dat.SEQ : '');
        w.setPropertie('Scale', dat.SCALE || '');
        // 標高点（7311・7312）はこの方向要素として記録されることがある。
        // その場合、標高値は注記（E7）ではなくEレコードの標高値フィールドに入っている。
        w.setPropertie('Elev',  elevOf(dat));
        w.setPropertie('Angle', dat.ANGLE !== undefined ? dat.ANGLE : '');
        w.setPropertie('RecordType', dat.RECORD_TYPE || '');
        w.setPropertie('DataType',   dat.DATA_TYPE   || '');
        w.setPropertie('DataKind',   dat.DATA_KIND   || '');
        w.write();

      } else if (fig === 'E7') {
        const w = writers['注記'];
        w.setGeometry(4, dat.XYList);
        w.setPropertie('Code',   dat.LAYER || '');
        w.setPropertie('Elno',   dat.ELNO  || '');
        w.setPropertie('Scale',  dat.SCALE || '');
        w.setPropertie('Text',   textOf(dat));
        w.setPropertie('Vnflag', dat.VNFLAG || '');
        w.setPropertie('Angle',  dat.ANGLE !== undefined ? dat.ANGLE : '');
        w.setPropertie('RecordType', dat.RECORD_TYPE || '');
        w.setPropertie('DataType',   dat.DATA_TYPE   || '');
        w.setPropertie('DataKind',   dat.DATA_KIND   || '');
        w.write();
      }
      // 円（E3）・円弧（E4）・属性（E8）は変換対象外。件数だけ数えて呼び出し側に返す
    }

    // skipped は要素の走査後に確定する（getter が解析を済ませる）
    const counts = dats.skipped;
    if (Object.keys(counts).length > 0) {
      mergeSkipped(skipped, { counts, files: [dmfile] });
    }
  }

  return skipped;
}

module.exports = { KINDS, DATATYPE_MAP, convertFiles, emptySkipped, mergeSkipped, reportSkipped };
