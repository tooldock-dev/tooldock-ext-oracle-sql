'use strict';
/**
 * 在 Oracle 上執行 tooldock.sql：交易、試跑、expect 檢查、型別轉換、查詢結果與截斷
 * （ToolDock docs/EXCHANGE.md〈6.4〉、〈6.7〉–〈6.10〉）。
 *
 * - 一律使用綁定變數，不把值拼接進 SQL（〈6.8〉第 7 點）。`:名稱` 會改寫成 `:p1`、`:p2`…，
 *   避免參數名稱剛好是 Oracle 保留字（例如 :date、:level）時出現 ORA-01745。
 * - 呼叫端要給一條專用連線（autoCommit 關閉），這裡負責 COMMIT / ROLLBACK。
 * - Oracle 沒有可以回復的 DDL（會隱含提交），所以接收端一律拒絕 DDL，這裡不處理 DDL。
 */
const oracledb = require('oracledb');
const { placeholders, resolveValues } = require('./sql-exchange');

const MAX_RESULT_BYTES = 10 * 1024 * 1024;
const MAX_VARCHAR = 32767;

class ExpectError extends Error {}

/** `:名稱` → `:p1`…（同名共用一個綁定變數）；去掉結尾的 `;`（Oracle 的 SQL 不接受） */
function prepare(sql, dialect) {
  const s = String(sql);
  const map = new Map();
  let out = '';
  let last = 0;
  for (const p of placeholders(s, dialect)) {
    out += s.slice(last, p.start);
    if (!map.has(p.name)) map.set(p.name, `p${map.size + 1}`);
    out += `:${map.get(p.name)}`;
    last = p.end;
  }
  out += s.slice(last);
  return { sql: out.replace(/[\s;]+$/, ''), map };
}

/** 〈6.4〉的型別 → oracledb 綁定型別（有型別的 null 也需要） */
function bindType(type, value) {
  switch (type) {
    case 'int': case 'float': case 'bool': return oracledb.DB_TYPE_NUMBER;
    case 'date': return oracledb.DB_TYPE_DATE;
    case 'datetime': return oracledb.DB_TYPE_TIMESTAMP_TZ;
    case 'binary': return value && value.length > MAX_VARCHAR ? oracledb.DB_TYPE_BLOB : oracledb.DB_TYPE_RAW;
    default: return typeof value === 'string' && value.length > MAX_VARCHAR ? oracledb.DB_TYPE_CLOB : oracledb.DB_TYPE_VARCHAR;
  }
}

/**
 * 〈6.4〉的值 → oracledb 綁定
 * - decimal / bigint 以字串綁定，由 Oracle 轉成 NUMBER，不經過 JS 浮點數（連線已設定 NLS_NUMERIC_CHARACTERS = '.,'）
 * - bool 綁定成 1 / 0（Oracle 23ai 的 BOOLEAN 欄位也接受）
 * - date 以本機時間的當天 00:00 綁定成 DATE；datetime 保留原本的時間點，綁定成 TIMESTAMP WITH TIME ZONE
 */
function toBind({ type, value }) {
  if (value === null || value === undefined) return { val: null, type: bindType(type, null) };
  switch (type) {
    case 'int': case 'float': return { val: value, type: oracledb.DB_TYPE_NUMBER };
    case 'bool': return { val: value ? 1 : 0, type: oracledb.DB_TYPE_NUMBER };
    case 'bigint': case 'decimal': return { val: String(value), type: oracledb.DB_TYPE_VARCHAR };
    case 'date': {
      const [y, m, d] = String(value).split('-').map(Number);
      return { val: new Date(y, m - 1, d), type: oracledb.DB_TYPE_DATE };
    }
    case 'datetime': return { val: new Date(value), type: oracledb.DB_TYPE_TIMESTAMP_TZ };
    case 'binary': {
      const buf = Buffer.from(value, 'base64');
      return { val: buf, type: bindType('binary', buf) };
    }
    case 'json': {
      const s = JSON.stringify(value);
      return { val: s, type: bindType('string', s) };
    }
    default: {
      const s = String(value);
      return { val: s, type: bindType('string', s) };
    }
  }
}

/* ───────────────────────── 查詢結果（〈6.10〉） ───────────────────────── */

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** JS Date → 帶本機時區的 ISO 8601（〈6.4〉datetime 一律帶時區） */
function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const ms = d.getMilliseconds();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Oracle 以字串取回的 NUMBER：補上省略的 0（".5" → "0.5"）；指數寫法交給 JS 轉換 */
function normalizeDecimal(s) {
  let v = String(s).trim();
  if (/e/i.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : v;
  }
  if (v.startsWith('.')) v = `0${v}`;
  else if (v.startsWith('-.')) v = `-0${v.slice(1)}`;
  return v;
}

const NUMBER_TYPES = () => [oracledb.DB_TYPE_NUMBER];
const STRING_TYPES = () => [oracledb.DB_TYPE_VARCHAR, oracledb.DB_TYPE_NVARCHAR, oracledb.DB_TYPE_CHAR, oracledb.DB_TYPE_NCHAR,
  oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB, oracledb.DB_TYPE_LONG, oracledb.DB_TYPE_ROWID, oracledb.DB_TYPE_UROWID].filter(Boolean);
const DATE_TYPES = () => [oracledb.DB_TYPE_DATE, oracledb.DB_TYPE_TIMESTAMP, oracledb.DB_TYPE_TIMESTAMP_TZ, oracledb.DB_TYPE_TIMESTAMP_LTZ];
const BINARY_TYPES = () => [oracledb.DB_TYPE_RAW, oracledb.DB_TYPE_BLOB, oracledb.DB_TYPE_LONG_RAW].filter(Boolean);

/** NUMBER 一律以字串取回，decimal 才不會失去精度；LOB 直接取值 */
function fetchTypeHandler(meta) {
  if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING };
  if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
  if (meta.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
  return undefined;
}

/** 驅動程式回報的欄位型別 → 〈6.4〉 */
function columnType(meta, rows, ci) {
  const t = meta.dbType;
  if (NUMBER_TYPES().includes(t)) {
    const { precision = 0, scale = 0 } = meta;
    if (precision > 0 && scale === 0 && precision <= 15) return 'int';
    if (precision === 0 && (scale === -127 || scale === 0)) {
      // 沒有宣告精度（例如 COUNT(*)、運算結果）：全部是安全範圍內的整數才當成 int
      const ints = rows.every((r) => r[ci] === null || (/^-?\d+$/.test(String(r[ci])) && Number.isSafeInteger(Number(r[ci]))));
      return ints ? 'int' : 'decimal';
    }
    return 'decimal';
  }
  if (t === oracledb.DB_TYPE_BINARY_FLOAT || t === oracledb.DB_TYPE_BINARY_DOUBLE) return 'float';
  if (oracledb.DB_TYPE_BOOLEAN && t === oracledb.DB_TYPE_BOOLEAN) return 'bool';
  if (oracledb.DB_TYPE_JSON && t === oracledb.DB_TYPE_JSON) return 'json';
  if (DATE_TYPES().includes(t)) return 'datetime';
  if (BINARY_TYPES().includes(t)) return 'binary';
  return 'string';
}

function jsonValue(v, type) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'int': return Number(v);
    case 'decimal': return normalizeDecimal(v);
    case 'float': return Number(v);
    case 'bool': return !!v;
    case 'json': return v;
    case 'datetime': return v instanceof Date ? isoLocal(v) : String(v);
    case 'binary': return Buffer.isBuffer(v) ? v.toString('base64') : String(v);
    default:
      if (v instanceof Date) return isoLocal(v);
      if (Buffer.isBuffer(v)) return v.toString('base64');
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function buildResult(metaData, rows, truncated) {
  const columns = metaData.map((m, ci) => ({ name: m.name, type: columnType(m, rows, ci) }));
  return {
    columns,
    rows: rows.map((r) => r.map((v, i) => jsonValue(v, columns[i].type))),
    rowCount: rows.length,
    truncated,
  };
}

/** 整個 ImportResult.data 不得超過 10 MB：從最後一個結果開始截斷（〈6.10〉） */
function enforceSize(data, limit = MAX_RESULT_BYTES) {
  const size = () => Buffer.byteLength(JSON.stringify(data), 'utf8');
  let total = size();
  if (total <= limit) return false;
  const results = [];
  for (const s of data.statements) for (const r of s.results || []) results.push(r);
  for (let k = results.length - 1; k >= 0 && total > limit; k--) {
    const r = results[k];
    let over = total - limit;
    while (r.rows.length && over > 0) over -= Buffer.byteLength(JSON.stringify(r.rows.pop()), 'utf8') + 1;
    r.rowCount = r.rows.length;
    r.truncated = true;
    total = size();
  }
  return true;
}

/* ───────────────────────── 執行 ───────────────────────── */

/** 執行一個語句的所有列，回傳 { affectedRows?: number[], results?: object[] } */
async function runStatement(conn, analysis, stmt, { prompts, context, maxRows, sampleRows, autoCommit }) {
  const { sql, map } = prepare(stmt.sql, analysis.dialect);
  const execs = stmt.rows ? stmt.rows : [null];
  const out = {};
  if (stmt.category === 'dml') out.affectedRows = [];
  if (stmt.returnsRows) out.results = [];
  const limit = sampleRows ? Math.min(sampleRows, maxRows) : maxRows;
  for (const row of execs) {
    const values = resolveValues(analysis, stmt, row, { prompts, context });
    const binds = {};
    for (const [name, b] of map) binds[b] = toBind(values[name]);
    const r = await conn.execute(sql, binds, {
      autoCommit,
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      ...(stmt.returnsRows ? { maxRows: limit + 1, fetchTypeHandler } : {}),
    });
    if (out.affectedRows) out.affectedRows.push(r.rowsAffected || 0);
    if (out.results) {
      const rows = r.rows || [];
      out.results.push(buildResult(r.metaData || [], rows.slice(0, limit), rows.length > limit));
    }
  }
  return out;
}

const sum = (a) => (a || []).reduce((s, x) => s + x, 0);

function checkExpect(expect, affected, label) {
  if (!expect) return;
  if (expect.maxAffectedRows !== undefined && affected > expect.maxAffectedRows) {
    throw new ExpectError(`${label}影響 ${affected} 筆，超過上限 ${expect.maxAffectedRows} 筆`);
  }
  if (expect.affectedRows !== undefined && affected !== expect.affectedRows) {
    throw new ExpectError(`${label}影響 ${affected} 筆，預期必須剛好 ${expect.affectedRows} 筆`);
  }
}

const oraMessage = (err) => String(err && err.message ? err.message : err).split('\n')[0];

/**
 * 執行整包。conn 必須是專用連線（autoCommit 關閉）。
 *  - dryRun：在交易中執行後一律 ROLLBACK（〈6.8〉第 4 點），查詢結果只取前 sampleRows 列給預覽用
 *  - transaction all：全部成功才 COMMIT；statement：每個語句各自 COMMIT；none：每次執行都自動提交
 * 交易回復時 committed = false，而且不回傳任何查詢結果（〈6.10〉）。
 * @returns {Promise<object>} ImportResult.data（〈6.9〉）
 */
async function execute(conn, analysis, { prompts = {}, context = {}, dryRun = false, maxRowsDefault = 10000, maxRowsCap = 100000, sampleRows = 20 } = {}) {
  const t0 = Date.now();
  const mode = dryRun ? 'all' : analysis.transaction;
  const statements = analysis.statements.map((s) => ({ id: s.id != null ? s.id : `#${s.index + 1}` }));
  const maxRowsOf = (s) => Math.max(1, Math.min(s.maxRows || maxRowsDefault, maxRowsCap));
  const opts = (s) => ({ prompts, context, maxRows: maxRowsOf(s), sampleRows: dryRun ? sampleRows : 0, autoCommit: mode === 'none' });
  let total = 0;
  let error = null;
  let failedAt = null;
  let committed = false;
  const dropResults = (from = 0) => { for (let k = from; k < statements.length; k++) delete statements[k].results; };
  const rollback = async () => { try { await conn.rollback(); } catch { /* 連線可能已中斷 */ } };

  if (mode === 'all') {
    try {
      for (const [k, s] of analysis.statements.entries()) {
        failedAt = k;
        Object.assign(statements[k], await runStatement(conn, analysis, s, opts(s)));
        const affected = sum(statements[k].affectedRows);
        total += affected;
        checkExpect(s.expect, affected, s.label);
      }
      failedAt = null;
      checkExpect(analysis.expect, total, '整包');
      if (dryRun) await rollback();
      else { await conn.commit(); committed = true; }
    } catch (err) {
      await rollback();
      error = err instanceof ExpectError
        ? `${err.message}，已回復`
        : `${failedAt !== null ? analysis.statements[failedAt].label : ''}執行失敗：${oraMessage(err)}，已回復`;
      if (!dryRun) dropResults();
    }
  } else if (mode === 'statement') {
    committed = true;
    for (const [k, s] of analysis.statements.entries()) {
      try {
        Object.assign(statements[k], await runStatement(conn, analysis, s, opts(s)));
        const affected = sum(statements[k].affectedRows);
        checkExpect(s.expect, affected, s.label);
        const e = analysis.expect || {};
        if (e.maxAffectedRows !== undefined && total + affected > e.maxAffectedRows) {
          throw new ExpectError(`整包影響 ${total + affected} 筆，超過上限 ${e.maxAffectedRows} 筆`);
        }
        if (k === analysis.statements.length - 1 && e.affectedRows !== undefined && total + affected !== e.affectedRows) {
          throw new ExpectError(`整包影響 ${total + affected} 筆，預期必須剛好 ${e.affectedRows} 筆`);
        }
        await conn.commit();
        total += affected;
      } catch (err) {
        await rollback();
        committed = false;
        failedAt = k;
        delete statements[k].affectedRows;
        dropResults(k);
        const done = k ? `；前 ${k} 個語句已各自提交，無法回復` : '';
        error = `${err instanceof ExpectError ? err.message : `${s.label}執行失敗：${oraMessage(err)}`}，這個語句已回復${done}`;
        break;
      }
    }
  } else {
    committed = true;
    for (const [k, s] of analysis.statements.entries()) {
      try {
        Object.assign(statements[k], await runStatement(conn, analysis, s, opts(s)));
        const affected = sum(statements[k].affectedRows);
        total += affected;
        checkExpect(s.expect, affected, s.label);
      } catch (err) {
        committed = false;
        failedAt = k;
        error = `${err instanceof ExpectError ? err.message : `${s.label}執行失敗：${oraMessage(err)}`}；未使用交易，已執行的部分不會回復`;
        break;
      }
    }
    if (committed) {
      try { checkExpect(analysis.expect, total, '整包'); } catch (err) {
        committed = false;
        error = `${err.message}；未使用交易，已執行的部分不會回復`;
      }
    }
  }

  const data = {
    committed: dryRun ? false : committed,
    totalAffectedRows: total,
    durationMs: Date.now() - t0,
    statements,
    ...(dryRun ? { dryRun: true } : {}),
    ...(error ? { error, failedStatement: failedAt !== null ? statements[failedAt].id : null } : {}),
  };
  enforceSize(data);
  return data;
}

module.exports = { execute, prepare, toBind, columnType, isoLocal, normalizeDecimal, enforceSize, ExpectError };
