// @ts-check
'use strict';
/**
 * Oracle SQL 工具：後端
 * 使用 node-oracledb 的 Thin 模式（純 JavaScript，不需安裝 Oracle Instant Client）。
 * 記住的密碼透過平台的 ctx.secrets（作業系統鑰匙圈保護的金鑰加密）保存；舊版平台不提供時，密碼只留在記憶體。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const oracledb = require('oracledb');
const { splitSql, statementAt, bindNames } = require('./sql-split');

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];

/** @typedef {{ id: string, name: string, host: string, port: number, serviceName: string, user: string, connectString?: string }} Profile */
/** @typedef {{ type: 'string' | 'number' | 'date' | 'null', value: string }} BindValue */
/** @typedef {{ id: string, name: string, sql: string, updatedAt: number }} Snippet */

/** @type {import('oracledb').Connection | null} */
let conn = null;
/** @type {Profile | null} */
let current = null;
let pending = false; // 有未提交的交易
let running = false;

/** @param {import('tooldock-types').ExtensionContext} ctx */
exports.activate = (ctx) => {
  /** @returns {Profile[]} */
  const profiles = () => ctx.storage.get('profiles', []);
  /** @returns {string[]} 有記住密碼的連線 id（只是旗標，密碼本身在 ctx.secrets） */
  const savedPasswordIds = () => ctx.storage.get('savedPasswords', []);
  /** @returns {Snippet[]} */
  const snippets = () => ctx.storage.get('snippets', []);
  /** @param {string} key @param {any} def */
  const setting = (key, def) => ctx.settings.get(`oracleSql.${key}`, def);
  const secretKey = (/** @type {string} */ id) => `password:${id}`;

  async function secretsAvailable() {
    try { return !!(ctx.secrets && await ctx.secrets.available()); } catch { return false; }
  }

  const state = () => ({
    connected: !!conn,
    profile: current,
    pending,
    running,
    autoCommit: !!setting('autoCommit', false),
    maxRows: Number(setting('maxRows', 500)),
  });

  const emit = () => {
    ctx.ui.emit('state', state());
    ctx.window.setStatus(conn && current
      ? { text: `🛢 ${current.user}@${current.serviceName || current.host}${pending ? ' ●' : ''}`, tooltip: pending ? 'Oracle：有未提交的交易' : 'Oracle：已連線', command: 'oracleSql.open' }
      : { text: '' }).catch(() => {});
  };

  /** @param {Profile} p */
  const connectString = (p) => (p.connectString && p.connectString.trim()) || `${p.host}:${p.port || 1521}/${p.serviceName}`;

  async function disconnect({ commit = false } = {}) {
    if (!conn) return;
    const c = conn;
    conn = null;
    try {
      if (pending) { if (commit) await c.commit(); else await c.rollback(); }
      await c.close();
    } catch (err) {
      ctx.log.warn(`中斷連線時發生錯誤：${err instanceof Error ? err.message : err}`);
    }
    pending = false;
    current = null;
    emit();
  }

  /** @param {any} v */
  function cell(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      /** @param {number} n */
      const p = (n) => String(n).padStart(2, '0');
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
    }
    if (Buffer.isBuffer(v)) return v.length <= 32 ? `0x${v.toString('hex').toUpperCase()}` : `<BLOB ${v.length} bytes>`;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  /** 讀取 DBMS_OUTPUT 緩衝區 */
  async function readDbmsOutput() {
    if (!conn) return [];
    const lines = [];
    for (let i = 0; i < 10000; i++) {
      const r = /** @type {any} */ (await conn.execute(
        'BEGIN DBMS_OUTPUT.GET_LINE(:ln, :st); END;',
        { ln: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 }, st: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
      ));
      if (r.outBinds.st !== 0) break;
      lines.push(r.outBinds.ln ?? '');
    }
    return lines;
  }

  /* ───────── 綁定變數 ───────── */

  /**
   * 把畫面輸入的值轉成 oracledb 的綁定參數
   * @param {string} name @param {BindValue} b
   */
  function toBind(name, b) {
    const t = b && b.type ? b.type : 'string';
    const raw = b && b.value != null ? String(b.value) : '';
    if (t === 'null') return { val: null, type: oracledb.STRING };
    if (t === 'number') {
      const n = Number(raw.replace(/,/g, '').trim());
      if (raw.trim() === '' || Number.isNaN(n)) throw new Error(`參數 :${name} 不是有效的數字：「${raw}」`);
      return { val: n, type: oracledb.NUMBER };
    }
    if (t === 'date') {
      const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (!m) throw new Error(`參數 :${name} 的日期格式應為 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]：「${raw}」`);
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
      return { val: d, type: oracledb.DB_TYPE_DATE };
    }
    return { val: raw, type: oracledb.STRING };
  }

  /** @param {string} sql @param {Record<string, BindValue>} values */
  function bindsFor(sql, values) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const name of bindNames(sql)) {
      const v = values[name.toUpperCase()];
      if (!v) throw new Error(`缺少參數 :${name}`);
      out[name] = toBind(name, v);
    }
    return out;
  }

  /**
   * @param {{ sql: string, plsql: boolean }} stmt
   * @param {{ maxRows: number, autoCommit: boolean }} opt
   * @param {Record<string, BindValue>} values
   */
  async function runOne(stmt, opt, values) {
    if (!conn) throw new Error('尚未連線');
    const t0 = Date.now();
    const keyword = ((stmt.sql.match(/^\s*(\w+)/) || [])[1] || '').toUpperCase();
    try {
      const binds = bindsFor(stmt.sql, values);
      const r = /** @type {any} */ (await conn.execute(stmt.sql, binds, {
        maxRows: opt.maxRows + 1,
        autoCommit: opt.autoCommit,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
      }));
      const ms = Date.now() - t0;
      const output = await readDbmsOutput();
      const bound = Object.keys(binds).map((k) => ({ name: k, value: cell(binds[k].val) }));
      if (r.metaData) {
        const truncated = r.rows.length > opt.maxRows;
        const rows = (truncated ? r.rows.slice(0, opt.maxRows) : r.rows).map((/** @type {any[]} */ row) => row.map(cell));
        return { ok: true, kind: 'query', sql: stmt.sql, ms, columns: r.metaData.map((/** @type {any} */ m) => ({ name: m.name, type: m.dbTypeName || '' })), rows, truncated, output, bound };
      }
      const dml = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(keyword);
      if (dml && !opt.autoCommit) pending = true;
      else if (['COMMIT', 'ROLLBACK'].includes(keyword)) pending = false;
      else if (['BEGIN', 'DECLARE'].includes(keyword)) { if (!opt.autoCommit) pending = true; } // 匿名區塊可能含 DML
      else if (!['SAVEPOINT', 'SET', 'LOCK'].includes(keyword)) pending = false; // DDL（含 CREATE PROCEDURE 等）會隱含提交
      return { ok: true, kind: dml ? 'dml' : stmt.plsql ? 'plsql' : 'other', sql: stmt.sql, ms, rowsAffected: r.rowsAffected ?? null, output, bound };
    } catch (e) {
      const err = /** @type {any} */ (e);
      return { ok: false, sql: stmt.sql, ms: Date.now() - t0, error: err.message, code: err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : err.code || null };
    }
  }

  /* ───────── 連線設定 ───────── */

  ctx.ui.handle('state', async () => ({
    ...state(),
    profiles: profiles(),
    savedPasswords: savedPasswordIds(),
    secretsAvailable: await secretsAvailable(),
    history: ctx.storage.get('history', []),
    snippets: snippets(),
  }));

  ctx.ui.handle('saveProfile', (/** @type {Profile} */ p) => {
    const clean = {
      id: p.id || crypto.randomUUID(),
      name: String(p.name || '').trim() || `${p.user}@${p.serviceName || p.host}`,
      host: String(p.host || '').trim(),
      port: Number(p.port) || 1521,
      serviceName: String(p.serviceName || '').trim(),
      user: String(p.user || '').trim(),
      connectString: String(p.connectString || '').trim(),
    };
    if (!clean.user) throw new Error('請輸入使用者名稱');
    if (!clean.connectString && (!clean.host || !clean.serviceName)) throw new Error('請輸入主機與服務名稱，或填寫連線字串');
    ctx.storage.set('profiles', [...profiles().filter((x) => x.id !== clean.id), clean]);
    return clean;
  });

  async function forgetPassword(/** @type {string} */ id) {
    if (ctx.secrets) await ctx.secrets.delete(secretKey(id)).catch(() => {});
    ctx.storage.set('savedPasswords', savedPasswordIds().filter((x) => x !== id));
  }

  ctx.ui.handle('removeProfile', async (id) => {
    await forgetPassword(id);
    ctx.storage.set('profiles', profiles().filter((x) => x.id !== id));
    return profiles();
  });

  ctx.ui.handle('forgetPassword', async (id) => { await forgetPassword(id); return savedPasswordIds(); });

  /* ───────── 連線 ───────── */

  /**
   * password 為 null 時使用記住的密碼；沒有記住的密碼則回傳 { needPassword: true }。
   * remember：true = 連線成功後記住，false = 清除已記住的，undefined = 不變。
   */
  ctx.ui.handle('connect', async (id, password, opts) => {
    const p = profiles().find((x) => x.id === id);
    if (!p) throw new Error('找不到連線設定');
    const remember = opts ? opts.remember : undefined;
    let pw = password;
    let fromSaved = false;
    if (pw == null) {
      pw = ctx.secrets && savedPasswordIds().includes(id) ? await ctx.secrets.get(secretKey(id)).catch(() => null) : null;
      if (pw == null) return { needPassword: true };
      fromSaved = true;
    }
    await disconnect();
    const t0 = Date.now();
    let c;
    try {
      c = await oracledb.getConnection({ user: p.user, password: String(pw), connectString: connectString(p) });
    } catch (e) {
      const err = /** @type {any} */ (e);
      // 記住的密碼已失效（例如已變更），請使用者重新輸入
      if (fromSaved && err.errorNum === 1017) return { needPassword: true, reason: '記住的密碼已無法登入，請重新輸入' };
      throw err;
    }
    c.callTimeout = Math.max(1, Number(setting('callTimeoutSeconds', 60))) * 1000;
    await c.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
    const info = /** @type {any} */ (await c.execute("SELECT SYS_CONTEXT('USERENV','DB_NAME'), SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL"));
    conn = c;
    current = p;
    pending = false;

    if (remember === true && !fromSaved) {
      if (!(await secretsAvailable())) throw new Error('這個平台版本或作業系統不支援安全儲存，無法記住密碼');
      await /** @type {any} */ (ctx.secrets).set(secretKey(id), String(pw));
      ctx.storage.set('savedPasswords', [...new Set([...savedPasswordIds(), id])]);
    } else if (remember === false) {
      await forgetPassword(id);
    }

    ctx.log.info(`已連線 ${p.user}@${connectString(p)}（${Date.now() - t0}ms${fromSaved ? '，使用記住的密碼' : ''}）`);
    emit();
    return { ...state(), serverVersion: c.oracleServerVersionString, dbName: info.rows[0][0], schema: info.rows[0][1], savedPasswords: savedPasswordIds() };
  });

  ctx.ui.handle('disconnect', async (opts) => { await disconnect(opts || {}); return state(); });

  /* ───────── 執行 ───────── */

  /**
   * binds 未提供而 SQL 含 :參數 時，回傳 { needBinds: [{ name, last }] } 讓畫面詢問；
   * 提供 binds（以大寫名稱為 key）時直接執行，並記住這次的值。
   */
  ctx.ui.handle('execute', async ({ text, cursor, mode, binds }) => {
    if (!conn) throw new Error('尚未連線');
    if (running) throw new Error('上一個指令還在執行中');
    const list = /** @type {any[]} */ (mode === 'all' || mode === 'selection'
      ? splitSql(text)
      : [statementAt(text, Number(cursor) || 0)].filter(Boolean));
    if (!list.length) throw new Error('沒有可執行的 SQL');

    const names = [];
    const seen = new Set();
    for (const s of list) for (const n of bindNames(s.sql)) if (!seen.has(n.toUpperCase())) { seen.add(n.toUpperCase()); names.push(n); }
    /** @type {Record<string, BindValue>} */
    const remembered = ctx.storage.get('bindValues', {});
    if (names.length && !binds) {
      return { needBinds: names.map((n) => ({ name: n, last: remembered[n.toUpperCase()] || null })), range: list.length === 1 ? { start: list[0].start, end: list[0].end } : null };
    }
    /** @type {Record<string, BindValue>} */
    const values = {};
    for (const [k, v] of Object.entries(binds || {})) values[k.toUpperCase()] = /** @type {BindValue} */ (v);
    if (names.length) ctx.storage.set('bindValues', { ...remembered, ...values });

    const opt = { maxRows: Math.max(1, Number(setting('maxRows', 500))), autoCommit: !!setting('autoCommit', false) };
    running = true;
    emit();
    const results = [];
    try {
      for (const stmt of list) {
        const r = await runOne(stmt, opt, values);
        results.push(r);
        if (!r.ok) break; // 腳本遇到錯誤即停止
      }
    } finally {
      running = false;
      const entry = list.map((s) => s.sql).join(';\n');
      ctx.storage.set('history', [entry, ...ctx.storage.get('history', []).filter((/** @type {string} */ h) => h !== entry)].slice(0, 50));
      emit();
    }
    return { results, state: state(), executed: results.length, total: list.length, range: list.length === 1 ? { start: list[0].start, end: list[0].end } : null };
  });

  ctx.ui.handle('cancel', async () => {
    if (conn && running) await conn.break();
    return true;
  });

  ctx.ui.handle('commit', async () => { if (!conn) throw new Error('尚未連線'); await conn.commit(); pending = false; emit(); return state(); });
  ctx.ui.handle('rollback', async () => { if (!conn) throw new Error('尚未連線'); await conn.rollback(); pending = false; emit(); return state(); });
  ctx.ui.handle('setAutoCommit', async (on) => { await ctx.settings.update('oracleSql.autoCommit', !!on); emit(); return state(); });

  /* ───────── 資料表瀏覽 ───────── */

  /** @param {string} sql @param {Record<string, any>} [binds] */
  async function meta(sql, binds = {}) {
    if (!conn) throw new Error('尚未連線');
    if (running) throw new Error('指令執行中，請稍後再試');
    const r = /** @type {any} */ (await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 5000 }));
    return r.rows;
  }

  ctx.ui.handle('listSchemas', async () => {
    const own = /** @type {any} */ (current) ? (await meta("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL"))[0].S : null;
    let rows = [];
    try {
      rows = await meta("SELECT DISTINCT owner AS S FROM all_objects WHERE object_type IN ('TABLE','VIEW') AND owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N') ORDER BY 1");
    } catch {
      rows = []; // 舊版資料庫沒有 oracle_maintained 欄位
    }
    const list = rows.map((/** @type {any} */ r) => r.S);
    return { current: own, schemas: [...new Set([own, ...list].filter(Boolean))] };
  });

  ctx.ui.handle('listObjects', async ({ owner }) => meta(`
    SELECT o.object_name AS name, o.object_type AS type, t.num_rows AS num_rows, c.comments AS comments
    FROM all_objects o
    LEFT JOIN all_tables t ON t.owner = o.owner AND t.table_name = o.object_name
    LEFT JOIN all_tab_comments c ON c.owner = o.owner AND c.table_name = o.object_name
    WHERE o.owner = :owner AND o.object_type IN ('TABLE', 'VIEW') AND o.object_name NOT LIKE 'BIN$%'
    ORDER BY o.object_type, o.object_name`, { owner: String(owner || '').toUpperCase() }));

  ctx.ui.handle('describe', async ({ owner, name }) => {
    const rows = await meta(`
      SELECT c.column_id AS pos, c.column_name AS name, c.data_type AS type, c.data_length AS len, c.char_length AS char_len,
             c.data_precision AS prec, c.data_scale AS scale, c.nullable AS nullable, cc.comments AS comments,
             (SELECT 'Y' FROM all_cons_columns k JOIN all_constraints n ON n.owner = k.owner AND n.constraint_name = k.constraint_name
               WHERE n.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name AND k.column_name = c.column_name AND ROWNUM = 1) AS pk
      FROM all_tab_columns c
      LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
      WHERE c.owner = :owner AND c.table_name = :name
      ORDER BY c.column_id`, { owner: String(owner).toUpperCase(), name: String(name) });
    return rows.map((/** @type {any} */ r) => {
      let type = r.TYPE;
      if (/CHAR/.test(type)) type += `(${r.CHAR_LEN || r.LEN})`;
      else if (type === 'NUMBER' && r.PREC != null) type += r.SCALE ? `(${r.PREC},${r.SCALE})` : `(${r.PREC})`;
      else if (type === 'RAW') type += `(${r.LEN})`;
      return { pos: r.POS, name: r.NAME, type, nullable: r.NULLABLE === 'Y', pk: r.PK === 'Y', comments: r.COMMENTS || '' };
    });
  });

  /* ───────── SQL 保存 ───────── */

  ctx.ui.handle('saveSnippet', ({ id, name, sql }) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('請輸入名稱');
    if (!String(sql || '').trim()) throw new Error('沒有可儲存的 SQL');
    const list = snippets();
    const existing = id ? list.find((x) => x.id === id) : list.find((x) => x.name === n);
    const item = { id: existing ? existing.id : crypto.randomUUID(), name: n, sql: String(sql), updatedAt: Date.now() };
    ctx.storage.set('snippets', [item, ...list.filter((x) => x.id !== item.id)]);
    return snippets();
  });

  ctx.ui.handle('removeSnippet', (id) => {
    ctx.storage.set('snippets', snippets().filter((x) => x.id !== id));
    return snippets();
  });

  ctx.ui.handle('openSqlFile', async () => {
    const r = await ctx.window.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('檔案超過 5 MB');
    return { path: file, name: path.basename(file), sql: fs.readFileSync(file, 'utf8').replace(/^﻿/, '') };
  });

  ctx.ui.handle('saveSqlFile', async ({ sql, name }) => {
    const r = await ctx.window.showSaveDialog({ defaultPath: `${String(name || 'query').replace(/[\\/:*?"<>|]/g, '_')}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, String(sql), 'utf8');
    return r.filePath;
  });

  ctx.ui.handle('exportCsv', async ({ columns, rows }) => {
    const r = await ctx.window.showSaveDialog({ defaultPath: `query-${Date.now()}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    /** @param {any} v */
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [columns.map((/** @type {any} */ c) => esc(c.name)).join(','), ...rows.map((/** @type {any[]} */ row) => row.map(esc).join(','))].join('\r\n');
    fs.writeFileSync(r.filePath, `﻿${body}\r\n`, 'utf8'); // BOM 讓 Excel 正確顯示中文
    return r.filePath;
  });

  ctx.subscriptions.push(
    ctx.commands.register('oracleSql.open', () => ctx.window.openView('oracleSql.main')),
    ctx.commands.register('oracleSql.disconnect', () => disconnect()),
    ctx.settings.onDidChange(() => emit()),
  );
};

/**
 * 平台結束前：回滾未提交的交易並關閉連線
 * @param {import('tooldock-types').ExtensionContext} ctx
 */
exports.onBeforeQuit = async (ctx) => {
  if (!conn) return;
  try {
    if (pending) { await conn.rollback(); ctx.log.warn('平台結束：未提交的交易已回滾'); }
    await conn.close();
  } catch { /* 忽略 */ }
  conn = null;
};

exports.deactivate = async () => {
  if (conn) { try { await conn.rollback(); await conn.close(); } catch { /* 忽略 */ } }
  conn = null;
};
