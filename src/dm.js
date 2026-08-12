// -----------------------------------------
// DM DATファイル読み込みクラス
// DM.py の Node.js 移植版
// -----------------------------------------
const fs = require('fs');
const iconv = require('iconv-lite');

const DATATYPE_MAP = {
  'E1': '面', 'E2': '線', 'E3': '円', 'E4': '円弧',
  'E5': '点', 'E6': '方向', 'E7': '注記', 'E8': '属性'
};

class DM {
  constructor(inDMFile) {
    this._DMFile = inDMFile;
    this._elementDict = null;
  }

  _decode(buf, start, end) {
    return iconv.decode(buf.slice(start, end), 'cp932');
  }

  // 注記文字列のデコード
  // DMの注記文字コードはデータ作成元によって異なる。
  //   Shift-JIS(cp932) : 8ビット目が立つ。余白は半角スペース(0x20)
  //   JIS X 0208(7bit) : 全バイトが 0x21-0x7E。余白は全角スペース(0x21 0x21)の連続
  // 7bitの範囲だけで構成される注記は、ASCII（幅員等の数値）とJISの区別がつかない。
  // 記号の有無などで推測すると "1?" が "運" になるような誤変換を招くため、
  // 全角スペース(0x21)埋めという明確な痕跡がある場合に限りJISとして扱う。
  _decodeText(buf, start, end) {
    const seg = buf.slice(start, end);
    if (seg.some(b => b >= 0x80)) return iconv.decode(seg, 'cp932').trimEnd();

    // 半角スペースの余白を除去
    let e = seg.length;
    while (e > 0 && seg[e - 1] === 0x20) e--;
    if (e === 0) return '';
    let body = seg.slice(0, e);

    // 全角スペース(0x21の連続)の余白を除去。境界がずれないよう長さは偶数に保つ
    let p = body.length;
    while (p > 0 && body[p - 1] === 0x21) p--;
    if (body.length - p < 4) return iconv.decode(seg, 'cp932').trimEnd();
    body = body.slice(0, p % 2 === 0 ? p : p + 1);

    if (this._looksJIS(body)) {
      // JIS X 0208(7bit) は各バイトに 0x80 を足すと EUC-JP になる
      const euc = Buffer.from(body.map(b => b + 0x80));
      const text = iconv.decode(euc, 'EUC-JP');
      if (!text.includes('�')) return text.trimEnd();
    }
    return iconv.decode(seg, 'cp932').trimEnd();
  }

  // 全角スペース埋めが確認できた注記本体に対してのみ呼ぶ
  _looksJIS(body) {
    if (body.length < 2 || body.length % 2 !== 0) return false;
    for (const b of body) {
      if (b < 0x21 || b > 0x7e) return false;
    }
    return true;
  }

  _parse() {
    if (this._elementDict !== null) return;
    this._elementDict = {};

    const buf = fs.readFileSync(this._DMFile);

    // バイナリモードで行分割（Python の readlines() 相当）
    const lines = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) { // \n
        lines.push(buf.slice(start, i + 1));
        start = i + 1;
      }
    }
    if (start < buf.length) {
      lines.push(buf.slice(start));
    }

    const decode = (b, s, e) => this._decode(b, s, e);
    let dictSeqno = 0;
    let recno = 0;
    let unitcode = '';
    let ldx = 0, ldy = 0;
    let scale = 0;

    while (recno < lines.length) {
      const record = lines[recno];
      const rectype = decode(record, 0, 2);

      if (rectype[0] === 'M') {
        // 図郭レコード(a)
        unitcode = decode(record, 2, 10).trimEnd();
        const scaleStr = decode(record, 30, 35).trim();
        scale = scaleStr ? parseInt(scaleStr) : 0;
        const editcnt = parseInt(decode(record, 65, 67));
        recno++;
        // 図郭レコード(b)
        const recB = lines[recno];
        if (!recB) break;   // 途中で終端しているファイル
        ldx = parseFloat(decode(recB, 0, 7));
        ldy = parseFloat(decode(recB, 7, 14));
        // 図郭レコード(d)までシーク
        recno += 2;
        let cnt = 0;
        while (cnt < editcnt + 1) {
          const recD = lines[recno];
          if (!recD) break;
          const reccnt = parseInt(decode(recD, 9, 10));
          recno += reccnt + 2;
          cnt++;
        }

      } else if (rectype[0] === 'E') {
        const layercode = decode(record, 2, 6);
        const elementno = parseInt(decode(record, 12, 16));
        const recordcnt = parseInt(decode(record, 31, 35));
        const datakind = decode(record, 20, 21);
        const datacnt = parseInt(decode(record, 27, 31));
        // 標高値フィールド（50〜56桁）。単位はミリメートル。
        // 等高線・標高点では標高が入るが、基準点系では点番号が入る（DM 3013400 に対し
        // 提供元のシェープファイル版は点番号 30134 と標高 26.05 を別に持つ）。
        // コードごとの解釈は convert.js 側で行い、ここでは生の値を渡す。
        const elev = decode(record, 49, 56).trim();
        let curRectype = rectype;
        let datatype = DATATYPE_MAP[rectype] || '';
        const elno = `${unitcode}-${layercode}-${String(elementno).padStart(4, '0')}`;

        if (curRectype === 'E1' || curRectype === 'E2') {
          // 線（E2）と面（E1）
          // 実データ区分が3・6（三次元）の場合、1点は X,Y,Z の21バイトで1レコードに4点。
          // 2（二次元）の場合は X,Y の14バイトで1レコードに6点。Z値は使用しない。
          // 6を14バイトとして読むと座標がずれるため、データ数とレコード数の関係で確認している
          // （kind=6 の要素はいずれも ceil(データ数/4)=レコード数 が成立する）。
          const stride = (datakind === '3' || datakind === '6') ? 21 : 14;
          const perRecord = Math.floor(84 / stride);
          let pointcnt = 0;
          const xy = [];
          let rec = null;
          let truncated = false;
          while (pointcnt < datacnt) {
            if (pointcnt % perRecord === 0) {
              recno++;
              rec = lines[recno];
              if (!rec) { truncated = true; break; }
            }
            const s = (pointcnt % perRecord) * stride;
            // 座標オフセット（ミリメートルからメートルに変換）
            const xVal = parseFloat(decode(rec, s, s + 7)) / 1000;
            const yVal = parseFloat(decode(rec, s + 7, s + 14)) / 1000;
            xy.push([ldy + yVal, ldx + xVal]);
            pointcnt++;
          }
          if (truncated) break;
          // 始終点が一致していれば面化する
          if (xy[0][0] === xy[xy.length - 1][0] && xy[0][1] === xy[xy.length - 1][1]) {
            curRectype = 'E1';
            datatype = DATATYPE_MAP['E1'];
          }
          this._elementDict[dictSeqno] = {
            FIGTYPE: curRectype,
            LAYER: layercode,
            ELNO: elno,
            XYList: xy,
            ELEV: elev,
            RECORD_TYPE: curRectype,
            DATA_KIND: datakind,
            DATA_TYPE: datatype,
            SCALE: scale
          };
          dictSeqno++;
          recno++;

        } else if (curRectype === 'E5') {
          // 点（E5）
          // 代表点座標（ミリメートルからメートルに変換）
          const px = parseFloat(decode(record, 35, 42)) / 1000;
          const py = parseFloat(decode(record, 42, 49)) / 1000;
          this._elementDict[dictSeqno] = {
            FIGTYPE: curRectype,
            LAYER: layercode,
            ELNO: elno,
            XYList: [ldy + py, ldx + px],
            ELEV: elev,
            RECORD_TYPE: curRectype,
            DATA_KIND: datakind,
            DATA_TYPE: datatype,
            SCALE: scale
          };
          dictSeqno++;
          recno += recordcnt + 1;

        } else if (curRectype === 'E6') {
          // 方向（E6）
          // 起点と方向点の2点で1本。第1点が地物の位置、第1点→第2点が向きを表す。
          // 2点間の距離は図上の記号長に相当する定型値であり実長ではないため、
          // 線としては出力せず、起点のみを点として持ち角度に変換する。
          //
          // 1要素に複数のペアが入ることがある（豊中の実データで要素の8.4%、最大20点＝10本）。
          // 先頭ペアだけを見ると方向記号を取りこぼすため、ペアごとに1件として出す。
          // 同一要素から出た複数件はELNOが同じになるので、SEQ（1始まり）で区別する。
          const hdr = recno;
          const stride = (datakind === '3' || datakind === '6') ? 21 : 14;
          const perRecord = Math.floor(84 / stride);
          const pts = [];
          for (let p = 0; p < datacnt; p++) {
            const rec = lines[hdr + 1 + Math.floor(p / perRecord)];
            if (!rec) break;
            const s = (p % perRecord) * stride;
            // 座標オフセット（ミリメートルからメートルに変換）
            pts.push([
              parseFloat(decode(rec, s, s + 7)) / 1000,
              parseFloat(decode(rec, s + 7, s + 14)) / 1000
            ]);
          }
          for (let k = 0; k + 1 < pts.length; k += 2) {
            const [x1, y1] = pts[k];
            const [x2, y2] = pts[k + 1];
            // DMのXは北方向、Yは東方向。水平右（東）を0度とする反時計回りの度数に直す。
            // E7（注記）のANGLEと同じ規約に揃えてあるため、描画側は同じ変換で扱える。
            const angle = Math.round(Math.atan2(x2 - x1, y2 - y1) * 180 / Math.PI);
            this._elementDict[dictSeqno] = {
              FIGTYPE: curRectype,
              LAYER: layercode,
              ELNO: elno,
              SEQ: k / 2 + 1,
              XYList: [ldy + y1, ldx + x1],
              ANGLE: angle,
              ELEV: elev,
              RECORD_TYPE: curRectype,
              DATA_KIND: datakind,
              DATA_TYPE: datatype,
              SCALE: scale
            };
            dictSeqno++;
          }
          recno = hdr + recordcnt + 1;

        } else if (curRectype === 'E7') {
          // 注記（E7）
          // 代表点座標（ミリメートルからメートルに変換）
          const px = parseFloat(decode(record, 35, 42)) / 1000;
          const py = parseFloat(decode(record, 42, 49)) / 1000;
          const rec2 = lines[recno + 1];
          if (!rec2) break;
          const vnflag = decode(rec2, 0, 1);
          const angle = parseInt(decode(rec2, 1, 8));
          const text = this._decodeText(rec2, 20, 84);
          this._elementDict[dictSeqno] = {
            FIGTYPE: curRectype,
            LAYER: layercode,
            ELNO: elno,
            XYList: [ldy + py, ldx + px],
            ANGLE: angle,
            VNFLAG: vnflag,
            TEXT: text,
            RECORD_TYPE: curRectype,
            DATA_KIND: datakind,
            DATA_TYPE: datatype,
            SCALE: scale
          };
          dictSeqno++;
          recno += recordcnt + 1;

        } else {
          recno += recordcnt + 1;
        }

      } else if (rectype[0] === 'H') {
        // グループヘッダレコード
        recno++;
      } else if (rectype[0] === 'G' || rectype[0] === 'T') {
        // グリッドヘッダ、TINレコード
        const recordcnt = parseInt(decode(record, 31, 35));
        recno += recordcnt + 1;
      } else {
        recno++;
      }
    }
  }

  [Symbol.iterator]() {
    this._parse();
    const dict = this._elementDict;
    const len = Object.keys(dict).length;
    let i = 0;
    return {
      next() {
        if (i >= len) return { done: true };
        return { value: dict[i++], done: false };
      }
    };
  }
}

module.exports = DM;
