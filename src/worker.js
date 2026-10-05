// -----------------------------------------
// 並列変換のワーカー。割り当てられた .dm ファイル群を変換し、
// 種別ごとの断片ファイル（FeatureCollection の外枠なし）を書き出す。
// 断片はメインプロセスが元のファイル順に連結する。
// -----------------------------------------
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const GeoJSONWriter = require('./geojsonWriter');
const { KINDS, convertFiles, emptySkipped } = require('./convert');

const { files, epsgByFile, tmpDir, index } = workerData;

const writers = {};
for (const kind of KINDS) {
  writers[kind] = new GeoJSONWriter(path.join(tmpDir, `${kind}.${index}.part`), epsgByFile[files[0]], { fragment: true });
}

// 変換対象外として読み飛ばしたレコードの集計。メインプロセスがワーカー分をまとめて出す
let skipped = emptySkipped();
try {
  skipped = convertFiles(files, writers, (f) => parentPort.postMessage({ type: 'file', file: f }), epsgByFile);
} finally {
  for (const kind of KINDS) writers[kind].close();
}

parentPort.postMessage({ type: 'done', index, skipped });
