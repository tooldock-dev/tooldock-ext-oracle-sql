// @ts-check
'use strict';
/**
 * Oracle SQL 工具：後端
 * 使用 node-oracledb 的 Thin 模式（純 JavaScript，不需安裝 Oracle Instant Client）。
 * 密碼只保存在記憶體中，不寫入磁碟。
 */
const fs = require('fs');
const crypto = require('crypto');
const oracledb = require('oracledb');
const { splitSql, statementAt } = require('./sql-split');

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];

/** @typedef {{ id: string, name: string, host: string, port: number, serviceName: string, user: string, connectString?: string }} Profile */

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
  /** @param {string} key @param {any} def */
  const setting = (key, def) => ctx.settings.get(`oracleSql.${key}`, def);

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

  /**
   * @param {{ sql: string, plsql: boolean }} stmt
   * @param {{ maxRows: number, autoCommit: boolean }} opt
   */
  async function runOne(stmt, opt) {
    if (!conn) throw new Error('尚未連線');
    const t0 = Date.now();
    const keyword = ((stmt.sql.match(/^\s*(\w+)/) || [])[1] || '').toUpperCase();
    try {
      const r = /** @type {any} */ (await conn.execute(stmt.sql, [], {
        maxRows: opt.maxRows + 1,
        autoCommit: opt.autoCommit,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
      }));
      const ms = Date.now() - t0;
      const output = await readDbmsOutput();
      if (r.metaData) {
        const truncated = r.rows.length > opt.maxRows;
        const rows = (truncated ? r.rows.slice(0, opt.maxRows) : r.rows).map((/** @type {any[]} */ row) => row.map(cell));
        return { ok: true, kind: 'query', sql: stmt.sql, ms, columns: r.metaData.map((/** @type {any} */ m) => ({ name: m.name, type: m.dbTypeName || '' })), rows, truncated, output };
      }
      const dml = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(keyword);
      if (dml && !opt.autoCommit) pending = true;
      else if (['COMMIT', 'ROLLBACK'].includes(keyword)) pending = false;
      else if (['BEGIN', 'DECLARE'].includes(keyword)) { if (!opt.autoCommit) pending = true; } // 匿名區塊可能含 DML
      else if (!['SAVEPOINT', 'SET', 'LOCK'].includes(keyword)) pending = false; // DDL（含 CREATE PROCEDURE 等）會隱含提交
      return { ok: true, kind: dml ? 'dml' : stmt.plsql ? 'plsql' : 'other', sql: stmt.sql, ms, rowsAffected: r.rowsAffected ?? null, output };
    } catch (e) {
      const err = /** @type {any} */ (e);
      return { ok: false, sql: stmt.sql, ms: Date.now() - t0, error: err.message, code: err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : err.code || null };
    }
  }

  // ── 連線設定 ──
  ctx.ui.handle('state', () => ({ ...state(), profiles: profiles(), history: ctx.storage.get('history', []) }));

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

  ctx.ui.handle('removeProfile', (id) => {
    ctx.storage.set('profiles', profiles().filter((x) => x.id !== id));
    return profiles();
  });

  // ── 連線 ──
  ctx.ui.handle('connect', async (id, password) => {
    const p = profiles().find((x) => x.id === id);
    if (!p) throw new Error('找不到連線設定');
    await disconnect();
    const t0 = Date.now();
    const c = await oracledb.getConnection({ user: p.user, password: String(password || ''), connectString: connectString(p) });
    c.callTimeout = Math.max(1, Number(setting('callTimeoutSeconds', 60))) * 1000;
    await c.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
    const info = /** @type {any} */ (await c.execute("SELECT SYS_CONTEXT('USERENV','DB_NAME'), SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL"));
    conn = c;
    current = p;
    pending = false;
    ctx.log.info(`已連線 ${p.user}@${connectString(p)}（${Date.now() - t0}ms）`);
    emit();
    return { ...state(), serverVersion: c.oracleServerVersionString, dbName: info.rows[0][0], schema: info.rows[0][1] };
  });

  ctx.ui.handle('disconnect', async (opts) => { await disconnect(opts || {}); return state(); });

  // ── 執行 ──
  ctx.ui.handle('execute', async ({ text, cursor, mode }) => {
    if (!conn) throw new Error('尚未連線');
    if (running) throw new Error('上一個指令還在執行中');
    const list = mode === 'all' || mode === 'selection'
      ? splitSql(text)
      : [statementAt(text, Number(cursor) || 0)].filter(Boolean);
    if (!list.length) throw new Error('沒有可執行的 SQL');
    const opt = { maxRows: Math.max(1, Number(setting('maxRows', 500))), autoCommit: !!setting('autoCommit', false) };
    running = true;
    emit();
    const results = [];
    try {
      for (const stmt of list) {
        const r = await runOne(/** @type {any} */ (stmt), opt);
        results.push(r);
        if (!r.ok) break; // 腳本遇到錯誤即停止
      }
    } finally {
      running = false;
      const entry = list.map((s) => /** @type {any} */ (s).sql).join(';\n');
      ctx.storage.set('history', [entry, ...ctx.storage.get('history', []).filter((/** @type {string} */ h) => h !== entry)].slice(0, 50));
      emit();
    }
    const one = /** @type {any} */ (list[0]);
    return { results, state: state(), executed: results.length, total: list.length, range: list.length === 1 ? { start: one.start, end: one.end } : null };
  });

  ctx.ui.handle('cancel', async () => {
    if (conn && running) await conn.break();
    return true;
  });

  ctx.ui.handle('commit', async () => { if (!conn) throw new Error('尚未連線'); await conn.commit(); pending = false; emit(); return state(); });
  ctx.ui.handle('rollback', async () => { if (!conn) throw new Error('尚未連線'); await conn.rollback(); pending = false; emit(); return state(); });
  ctx.ui.handle('setAutoCommit', async (on) => { await ctx.settings.update('oracleSql.autoCommit', !!on); emit(); return state(); });

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
