// -----------------------------------------
// DMファイルリスト管理クラス（再帰検索版）
// 道路台帳DMデータ用：サブフォルダを再帰的に検索する
// -----------------------------------------
const fs = require('fs');
const path = require('path');

function collectDMFiles(dir, result) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDMFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dm')) {
      result.push(fullPath);
    }
  }
}

class DMFiles {
  constructor(inPath) {
    this._MAPList = [];
    if (fs.existsSync(inPath)) {
      collectDMFiles(inPath, this._MAPList);
      this._MAPList.sort();
    }
  }

  [Symbol.iterator]() {
    const list = this._MAPList;
    let i = 0;
    return {
      next() {
        if (i >= list.length) return { done: true };
        return { value: list[i++], done: false };
      }
    };
  }
}

module.exports = DMFiles;
