// output/ で生成した PMTiles を viewer/public/ へ複製する。
// Vite の dev サーバは public/ 以下しか静的配信しないため、
// リポジトリ直下の output/ を直接は参照できない。
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'output', 'road_ledger.pmtiles');
const DSTDIR = join(HERE, '..', 'public');
const DST = join(DSTDIR, 'road_ledger.pmtiles');

if (!existsSync(SRC)) {
  console.warn(`  PMTiles が見つかりません: ${SRC}`);
  console.warn('  先に scripts/build.sh を実行してください。');
  process.exit(0);
}

mkdirSync(DSTDIR, { recursive: true });
copyFileSync(SRC, DST);
console.log(`  road_ledger.pmtiles を複製しました (${(statSync(DST).size / 1024).toFixed(1)} KB)`);
