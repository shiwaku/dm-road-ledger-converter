// -----------------------------------------
// 道路台帳DM → GeoJSON 変換（並列処理版）
// worker_threads で複数コアを活用
// 使用方法:
//   node index_parallel.js
//   node index_parallel.js --workers 8 --input /path/to/dir --epsg 6672
// -----------------------------------------
const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ---- ワーカースレッド処理 ----
if (!isMainThread) {
  const { files, epsg, outDir, workerId } = workerData;
  const DM = require('./dm');

  // ワーカーは各要素タイプを配列に収集し、NDJSONで返す
  const outLine = path.join(outDir, `_tmp_${workerId}_線.ndjson`);
  const outPoly = path.join(outDir, `_tmp_${workerId}_面.ndjson`);
  const outSym  = path.join(outDir, `_tmp_${workerId}_記号.ndjson`);
  const outTxt  = path.join(outDir, `_tmp_${workerId}_注記.ndjson`);

  const BUFSZ = 64 * 1024;
  function makeBufWriter(filePath) {
    const fd = fs.openSync(filePath, 'w');
    let buf = Buffer.allocUnsafe(BUFSZ);
    let pos = 0;
    function flush() {
      if (pos > 0) { fs.writeSync(fd, buf, 0, pos); pos = 0; }
    }
    function write(str) {
      const b = Buffer.from(str + '\n', 'utf8');
      if (pos + b.length > BUFSZ) flush();
      if (b.length >= BUFSZ) { fs.writeSync(fd, b); }
      else { b.copy(buf, pos); pos += b.length; }
    }
    function close() { flush(); fs.closeSync(fd); }
    return { write, close };
  }

  const wLine = makeBufWriter(outLine);
  const wPoly = makeBufWriter(outPoly);
  const wSym  = makeBufWriter(outSym);
  const wTxt  = makeBufWriter(outTxt);

  let fileCount = 0;
  for (const dmfile of files) {
    fileCount++;
    try {
      const dats = new DM(dmfile);
      for (const dat of dats) {
        const fig = dat.FIGTYPE || '';
        const base = JSON.stringify({
          Code: dat.LAYER || '',
          Elno: dat.ELNO || '',
          RecordType: dat.RECORD_TYPE || '',
          DataType: dat.DATA_TYPE || '',
          DataKind: dat.DATA_KIND || ''
        });

        if (fig === 'E2') {
          wLine.write(JSON.stringify({ xy: dat.XYList, props: JSON.parse(base) }));
        } else if (fig === 'E1') {
          wPoly.write(JSON.stringify({ xy: dat.XYList, props: JSON.parse(base) }));
        } else if (fig === 'E5') {
          wSym.write(JSON.stringify({ xy: dat.XYList, props: JSON.parse(base) }));
        } else if (fig === 'E7') {
          const txtProps = Object.assign(JSON.parse(base), {
            Text: dat.TEXT || '',
            Vnflag: dat.VNFLAG || '',
            Angle: dat.ANGLE !== undefined ? dat.ANGLE : ''
          });
          wTxt.write(JSON.stringify({ xy: dat.XYList, props: txtProps }));
        }
      }
    } catch (e) {
      // パースエラーは無視して続行
    }
  }

  wLine.close();
  wPoly.close();
  wSym.close();
  wTxt.close();

  parentPort.postMessage({ workerId, fileCount });
  process.exit(0);
}

// ---- メインスレッド処理 ----
const proj4 = require('proj4');
const EPSG_DEFS = require('./epsgDefs');
const DMFiles = require('./dmfiles');

function parseArgs() {
  const args = process.argv.slice(2);
  let scale = 500, input = null, epsg = 6672, numWorkers = 8;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scale'   && args[i+1]) scale      = parseInt(args[i+1]);
    if (args[i] === '--input'   && args[i+1]) input      = args[i+1];
    if (args[i] === '--epsg'    && args[i+1]) epsg       = parseInt(args[i+1]);
    if (args[i] === '--workers' && args[i+1]) numWorkers = parseInt(args[i+1]);
  }
  if (!input) input = path.join(__dirname, '..', 'DMデータ');
  else         input = path.resolve(input);

  if (!fs.existsSync(input)) {
    console.error(`入力フォルダが見つかりません: ${input}`); process.exit(1);
  }
  return { scale, dmDir: input, epsg, numWorkers };
}

function fmt(n) { return parseFloat(n.toFixed(7)).toString(); }

function mergeNDJSON(types, numWorkers, outDir, scale, epsg) {
  proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
  const epsgDef = EPSG_DEFS[epsg];
  if (!epsgDef) { console.error(`未対応EPSG: ${epsg}`); process.exit(1); }
  proj4.defs(`EPSG:${epsg}`, epsgDef);
  const tr = proj4(`EPSG:${epsg}`, 'EPSG:4326').forward;

  const typeInfo = {
    '線': { figtype: 1 },
    '面': { figtype: 2 },
    '記号': { figtype: 5 },
    '注記': { figtype: 4 }
  };

  for (const [typeName, info] of Object.entries(typeInfo)) {
    const outPath = path.join(outDir, `道路台帳図_${scale}_${typeName}.geojson`);
    const fd = fs.openSync(outPath, 'w');
    const BUFSZ = 64 * 1024;
    let buf = Buffer.allocUnsafe(BUFSZ), pos = 0;
    function flush() { if (pos > 0) { fs.writeSync(fd, buf, 0, pos); pos = 0; } }
    function wrt(str) {
      const b = Buffer.from(str, 'utf8');
      if (pos + b.length > BUFSZ) flush();
      if (b.length >= BUFSZ) fs.writeSync(fd, b);
      else { b.copy(buf, pos); pos += b.length; }
    }

    wrt('{"type":"FeatureCollection","features":[\n');
    let first = true;

    for (let w = 0; w < numWorkers; w++) {
      const tmpPath = path.join(outDir, `_tmp_${w}_${typeName}.ndjson`);
      if (!fs.existsSync(tmpPath)) continue;

      const lines = fs.readFileSync(tmpPath, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        const { xy, props } = JSON.parse(line);
        let geom = '';

        if (info.figtype === 1) {
          // LineString
          const coords = xy.map(p => { const [lon,lat] = tr([p[0],p[1]]); return `[${fmt(lon)},${fmt(lat)}]`; }).join(',');
          geom = `\t{"type":"Feature",\n\t"geometry":{"type":"LineString","coordinates":[${coords}]}`;
        } else if (info.figtype === 2) {
          // Polygon
          const rev = [...xy].reverse(); rev.push([...rev[0]]);
          const coords = rev.map(p => { const [lon,lat] = tr([p[0],p[1]]); return `[${fmt(lon)},${fmt(lat)}]`; }).join(',');
          geom = `\t{"type":"Feature",\n\t"geometry":{"type":"Polygon","coordinates":[[${coords}]]}`;
        } else {
          // Point
          const [lon, lat] = tr([xy[0], xy[1]]);
          geom = `\t{"type":"Feature",\n\t"geometry":{"type":"Point","coordinates":[${fmt(lon)},${fmt(lat)}]}`;
        }

        const propsStr = Object.entries(props).map(([k,v]) => `"${k}":"${String(v)}"`).join(',');
        if (!first) wrt(',\n'); first = false;
        wrt(geom + `,\n\t"properties":{${propsStr}}}`);
      }
      fs.unlinkSync(tmpPath);
    }

    wrt('\n]}');
    flush();
    fs.closeSync(fd);
    console.log(`  → ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

async function main() {
  const { scale, dmDir, epsg, numWorkers } = parseArgs();
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  // 全DMファイルを収集
  const dmfiles = [];
  for (const f of new DMFiles(dmDir)) dmfiles.push(f);
  console.log(`変換対象: ${dmfiles.length} ファイル、ワーカー数: ${numWorkers}`);

  // ファイルをワーカーに均等分配
  const chunks = Array.from({ length: numWorkers }, () => []);
  dmfiles.forEach((f, i) => chunks[i % numWorkers].push(f));

  const startTime = Date.now();

  // ワーカーを起動
  await new Promise((resolve, reject) => {
    let done = 0;
    let totalFiles = 0;
    for (let w = 0; w < numWorkers; w++) {
      if (chunks[w].length === 0) { done++; if (done === numWorkers) resolve(); continue; }
      const worker = new Worker(__filename, {
        workerData: { files: chunks[w], epsg, outDir, workerId: w }
      });
      worker.on('message', ({ workerId, fileCount }) => {
        totalFiles += fileCount;
        process.stdout.write(`  Worker ${workerId}: ${fileCount}ファイル完了\n`);
        done++;
        if (done === numWorkers) { console.log(`\n変換完了: 計${totalFiles}ファイル`); resolve(); }
      });
      worker.on('error', reject);
    }
  });

  console.log('\nGeoJSON出力中...');
  mergeNDJSON(['線','面','記号','注記'], numWorkers, outDir, scale, epsg);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n完了（${elapsed}秒）`);
  console.log(`EPSG: ${epsg}、縮尺: ${scale}`);
}

main().catch(e => { console.error(e); process.exit(1); });
