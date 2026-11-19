'use strict';
/**
 * 編輯器查詢結果 → tooldock.table（〈6.4〉型別）。
 *
 * 編輯器的結果是給人看的格式（backend/index.js 的 cell()）：日期為本機時間「YYYY-MM-DD HH:MM:SS」、
 * 二進位為 0x… 或 <BLOB n bytes>、物件為 JSON 字串。分享前依欄位的 xtype（執行時由 columnType 判斷）轉回：
 * - int / float：數字；decimal：十進位字串
 * - datetime：帶本機時區的 ISO 8601
 * - json：解析回物件（解析失敗時維持字串）
 * - binary：畫面上已不是原始資料，改當成 string
 */
const { isoLocal, normalizeDecimal } = require('./exchange-exec');

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** @param {string | undefined} xtype */
const tableType = (xtype) => (!xtype || xtype === 'binary' ? 'string' : xtype);

/** @param {any} v @param {string} type */
function toValue(v, type) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'int':
    case 'float': {
      const n = Number(v);
      return Number.isFinite(n) ? n : String(v);
    }
    case 'decimal': return normalizeDecimal(String(v));
    case 'bool': return v === true || v === 1 || v === '1' || String(v).toUpperCase() === 'TRUE';
    case 'datetime': {
      const m = LOCAL_DATETIME.exec(String(v));
      if (!m) return String(v);
      return isoLocal(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    }
    case 'json':
      try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return String(v); }
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

/**
 * @param {{ name: string, xtype?: string }[]} columns
 * @param {any[][]} rows
 * @returns {{ columns: { name: string, type: string }[], rows: any[][] }}
 */
function toTable(columns, rows) {
  const types = columns.map((c) => tableType(c.xtype));
  return {
    columns: columns.map((c, i) => ({ name: String(c.name), type: types[i] })),
    rows: rows.map((row) => types.map((t, i) => toValue(row[i], t))),
  };
}

module.exports = { toTable };
