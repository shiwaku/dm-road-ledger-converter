// -----------------------------------------
// 道路台帳DM → GeoJSON 変換メインスクリプト
// 使用方法:
//   node src/index.js                                 # ../DMデータ/ を再帰検索して output/ へ出力
//   node src/index.js --input /path/to/dir            # 入力フォルダを直接指定
//   node src/index.js --epsg 6672                     # 座標系を指定（デフォルト: 6672 第4系）
//   node src/index.js --jobs 4                        # 並列数を指定（既定: CPUコア数-1）
//   node src/index.js --jobs 1                        # 逐次実行
// 縮尺はDMファイルのMレコードから自動取得し、Scaleプロパティとして出力する
// -----------------------------------------
const path = require('path');
const fs = require('fs');
const DMFiles = require('./dmfiles');
const GeoJSONWriter = require('./geojsonWriter');
const { KINDS, convertFiles } = require('./convert');
const { convertParallel, defaultJobs } = require('./parallel');

// output/ はリポジトリルート直下（src/ の1つ上）
const ROOT = path.join(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  let input = null;
  let epsg  = 6672;   // デフォルト: JGD2011 / 日本平面直角座標系 第4系（四国4県）
  let jobs  = defaultJobs();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[i + 1];
    }
    if (args[i] === '--epsg' && args[i + 1]) {
      epsg = parseInt(args[i + 1]);
    }
    if (args[i] === '--jobs' && args[i + 1]) {
      jobs = parseInt(args[i + 1]);
    }
  }

  if (isNaN(epsg) || epsg <= 0) {
    console.error('--epsg に正の整数を指定してください');
    process.exit(1);
  }
  if (isNaN(jobs) || jobs <= 0) {
    console.error('--jobs に正の整数を指定してください');
    process.exit(1);
  }

  // --input 省略時は ../DMデータ/ を使用
  if (!input) {
    input = path.join(ROOT, '..', 'DMデータ');
  } else {
    input = path.resolve(input);
  }
  if (!fs.existsSync(input)) {
    console.error(`入力フォルダが見つかりません: ${input}`);
    process.exit(1);
  }

  return { dmDir: input, epsg, jobs };
}

/** 逐次実行。ファイルが1つだけの場合や --jobs 1 のときに使う。 */
function runSequential(files, epsg, outDir) {
  const writers = {};
  for (const kind of KINDS) {
    writers[kind] = new GeoJSONWriter(path.join(outDir, `道路台帳図_${kind}.geojson`), epsg);
  }
  let n = 0;
  try {
    convertFiles(files, writers, (f) => console.log(`[${++n}/${files.length}] ${f}`));
  } finally {
    for (const kind of KINDS) writers[kind].close();
  }
}

async function main() {
  const { dmDir, epsg, jobs } = parseArgs();

  const outDir = path.join(ROOT, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const files = [...new DMFiles(dmDir)];

  // ファイルが1つも無い場合も、空の GeoJSON を出して正常終了する。
  const workers = Math.min(jobs, files.length);
  if (workers > 1) {
    console.log(`並列変換: ${workers} ワーカー / ${files.length} ファイル`);
    await convertParallel(files, epsg, outDir, workers);
  } else {
    runSequential(files, epsg, outDir);
  }

  console.log(`\n処理ファイル数: ${files.length}`);
  console.log('Done.');
  for (const kind of KINDS) {
    console.log(path.join(outDir, `道路台帳図_${kind}.geojson`));
  }
  console.log(`DM dir: ${dmDir}`);
  console.log(`EPSG: ${epsg}`);
  console.log('縮尺はScaleプロパティに各フィーチャの値を格納');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
