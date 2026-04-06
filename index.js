// -----------------------------------------
// 道路台帳DM → GeoJSON 変換メインスクリプト
// 使用方法:
//   node index.js                                     # ../DMデータ/ を再帰検索して output/ へ出力
//   node index.js --input /path/to/dir                # 入力フォルダを直接指定
//   node index.js --epsg 6672                         # 座標系を指定（デフォルト: 6672 第4系）
// 縮尺はDMファイルのMレコードから自動取得し、Scaleプロパティとして出力する
// -----------------------------------------
const path = require('path');
const fs = require('fs');
const DMFiles = require('./dmfiles');
const DM = require('./dm');
const GeoJSONWriter = require('./geojsonWriter');

function parseArgs() {
  const args = process.argv.slice(2);
  let input = null;
  let epsg  = 6672;   // デフォルト: JGD2011 / 日本平面直角座標系 第4系（四国4県）

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[i + 1];
    }
    if (args[i] === '--epsg' && args[i + 1]) {
      epsg = parseInt(args[i + 1]);
    }
  }

  if (isNaN(epsg) || epsg <= 0) {
    console.error('--epsg に正の整数を指定してください');
    process.exit(1);
  }

  // --input 省略時は ../DMデータ/ を使用
  if (!input) {
    input = path.join(__dirname, '..', 'DMデータ');
  } else {
    input = path.resolve(input);
  }
  if (!fs.existsSync(input)) {
    console.error(`入力フォルダが見つかりません: ${input}`);
    process.exit(1);
  }

  return { dmDir: input, epsg };
}

function main() {
  const { dmDir, epsg } = parseArgs();

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const outLine = path.join(outDir, '道路台帳図_線.geojson');
  const outPoly = path.join(outDir, '道路台帳図_面.geojson');
  const outSym  = path.join(outDir, '道路台帳図_記号.geojson');
  const outTxt  = path.join(outDir, '道路台帳図_注記.geojson');

  const wLine = new GeoJSONWriter(outLine, epsg);
  const wPoly = new GeoJSONWriter(outPoly, epsg);
  const wSym  = new GeoJSONWriter(outSym,  epsg);
  const wTxt  = new GeoJSONWriter(outTxt,  epsg);

  let fileCount = 0;
  try {
    const dmfiles = new DMFiles(dmDir);
    for (const dmfile of dmfiles) {
      fileCount++;
      console.log(`[${fileCount}] ${dmfile}`);
      const dats = new DM(dmfile);

      for (const dat of dats) {
        const fig = dat.FIGTYPE || '';

        if (fig === 'E2') {
          wLine.setGeometry(1, dat.XYList);
          wLine.setPropertie('Code',       dat.LAYER       || '');
          wLine.setPropertie('Elno',       dat.ELNO        || '');
          wLine.setPropertie('Scale',      dat.SCALE       || '');
          wLine.setPropertie('RecordType', dat.RECORD_TYPE || '');
          wLine.setPropertie('DataType',   dat.DATA_TYPE   || '');
          wLine.setPropertie('DataKind',   dat.DATA_KIND   || '');
          wLine.write();

        } else if (fig === 'E1') {
          wPoly.setGeometry(2, dat.XYList);
          wPoly.setPropertie('Code',       dat.LAYER       || '');
          wPoly.setPropertie('Elno',       dat.ELNO        || '');
          wPoly.setPropertie('Scale',      dat.SCALE       || '');
          wPoly.setPropertie('RecordType', dat.RECORD_TYPE || '');
          wPoly.setPropertie('DataType',   dat.DATA_TYPE   || '');
          wPoly.setPropertie('DataKind',   dat.DATA_KIND   || '');
          wPoly.write();

        } else if (fig === 'E5') {
          wSym.setGeometry(5, dat.XYList);
          wSym.setPropertie('Code',       dat.LAYER       || '');
          wSym.setPropertie('Elno',       dat.ELNO        || '');
          wSym.setPropertie('Scale',      dat.SCALE       || '');
          wSym.setPropertie('RecordType', dat.RECORD_TYPE || '');
          wSym.setPropertie('DataType',   dat.DATA_TYPE   || '');
          wSym.setPropertie('DataKind',   dat.DATA_KIND   || '');
          wSym.write();

        } else if (fig === 'E7') {
          wTxt.setGeometry(4, dat.XYList);
          wTxt.setPropertie('Code',       dat.LAYER       || '');
          wTxt.setPropertie('Elno',       dat.ELNO        || '');
          wTxt.setPropertie('Scale',      dat.SCALE       || '');
          wTxt.setPropertie('Text',       dat.TEXT        || '');
          wTxt.setPropertie('Vnflag',     dat.VNFLAG      || '');
          wTxt.setPropertie('Angle',      dat.ANGLE !== undefined ? dat.ANGLE : '');
          wTxt.setPropertie('RecordType', dat.RECORD_TYPE || '');
          wTxt.setPropertie('DataType',   dat.DATA_TYPE   || '');
          wTxt.setPropertie('DataKind',   dat.DATA_KIND   || '');
          wTxt.write();
        }
        // E3（円）・E6（方向）は変換対象外
      }
    }
  } finally {
    wLine.close();
    wPoly.close();
    wSym.close();
    wTxt.close();
  }

  console.log(`\n処理ファイル数: ${fileCount}`);
  console.log('Done.');
  console.log(outLine);
  console.log(outPoly);
  console.log(outSym);
  console.log(outTxt);
  console.log(`DM dir: ${dmDir}`);
  console.log(`EPSG: ${epsg}`);
  console.log('縮尺はScaleプロパティに各フィーチャの値を格納');
}

main();
