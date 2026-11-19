// @ts-check
'use strict';
/**
 * Oracle SQL 工具：後端
 * 使用 node-oracledb 的 Thin 模式（純 JavaScript，不需安裝 Oracle Instant Client）。
 * 記住的密碼透過平台的 ctx.secrets（作業系統鑰匙圈保護的金鑰加密）保存；舊版平台不提供時，密碼只留在記憶體。
 * 可同時開啟多條連線（每組連線設定一條，最多 MAX_SESSIONS 條），各自有獨立的交易狀態，畫面以連線 id（= 連線設定 id）指定要操作哪一條。
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

/**
 * @typedef {{
 *   id: string, profile: Profile, conn: import('oracledb').Connection,
 *   pending: boolean, running: boolean,
 *   dbName: string, schema: string, serverVersion: string, connectedAt: number
 * }} Session
 */

const MAX_SESSIONS = 5;
/** @type {Map<string, Session>} 連線 id（= 連線設定 id）→ 連線 */
const sessions = new Map();
/** @type {Set<string>} 正在建立中的連線，計入上限，避免同時按多次超過 */
const connecting = new Set();

/** 關閉一條連線：pending 時依 commit 決定提交或回滾 @param {Session} s @param {boolean} [commit] */
async function closeSession(s, commit = false) {
  sessions.delete(s.id);
  if (s.pending) { if (commit) await s.conn.commit(); else await s.conn.rollback(); }
  await s.conn.close();
}

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

  /** @param {Session} s */
  const publicSession = (s) => ({
    id: s.id, profile: s.profile, pending: s.pending, running: s.running,
    dbName: s.dbName, schema: s.schema, serverVersion: s.serverVersion, connectedAt: s.connectedAt,
  });

  const state = () => ({
    sessions: [...sessions.values()].map(publicSession),
    maxSessions: MAX_SESSIONS,
    autoCommit: !!setting('autoCommit', false),
    maxRows: Number(setting('maxRows', 500)),
  });

  /** @param {Profile} p */
  const label = (p) => `${p.user}@${p.serviceName || p.host}`;

  const emit = () => {
    ctx.ui.emit('state', state());
    const list = [...sessions.values()];
    const pendingAny = list.some((s) => s.pending);
    const status = !list.length
      ? { text: '' }
      : {
        text: `🛢 ${list.length === 1 ? label(list[0].profile) : `${list.length} 條連線`}${pendingAny ? ' ●' : ''}`,
        tooltip: list.map((s) => `${s.profile.name}（${label(s.profile)}）${s.pending ? '：有未提交的交易' : ''}`).join('\n'),
        command: 'oracleSql.open',
      };
    ctx.window.setStatus(status).catch(() => {});
  };

  /** @param {Profile} p */
  const connectString = (p) => (p.connectString && p.connectString.trim()) || `${p.host}:${p.port || 1521}/${p.serviceName}`;

  /** @param {any} sid @returns {Session} */
  function session(sid) {
    const s = sessions.get(String(sid || ''));
    if (!s) throw new Error('這條連線已中斷，請重新連線');
    return s;
  }

  /** @param {string} sid @param {{ commit?: boolean }} [opts] */
  async function disconnect(sid, { commit = false } = {}) {
    const s = sessions.get(sid);
    if (!s) return;
    try {
      await closeSession(s, commit);
    } catch (err) {
      ctx.log.warn(`中斷連線 ${s.profile.name} 時發生錯誤：${err instanceof Error ? err.message : err}`);
    }
    ctx.log.info(`已中斷連線 ${label(s.profile)}`);
    emit();
  }

  async function disconnectAll() {
    for (const id of [...sessions.keys()]) await disconnect(id);
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

  /** 讀取 DBMS_OUTPUT 緩衝區 @param {import('oracledb').Connection} conn */
  async function readDbmsOutput(conn) {
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
   * @param {Session} s
   * @param {{ sql: string, plsql: boolean }} stmt
   * @param {{ maxRows: number, autoCommit: boolean }} opt
   * @param {Record<string, BindValue>} values
   */
  async function runOne(s, stmt, opt, values) {
    const { conn } = s;
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
      const output = await readDbmsOutput(conn);
      const bound = Object.keys(binds).map((k) => ({ name: k, value: cell(binds[k].val) }));
      if (r.metaData) {
        const truncated = r.rows.length > opt.maxRows;
        const rows = (truncated ? r.rows.slice(0, opt.maxRows) : r.rows).map((/** @type {any[]} */ row) => row.map(cell));
        return { ok: true, kind: 'query', sql: stmt.sql, ms, columns: r.metaData.map((/** @type {any} */ m) => ({ name: m.name, type: m.dbTypeName || '' })), rows, truncated, output, bound };
      }
      const dml = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(keyword);
      if (dml && !opt.autoCommit) s.pending = true;
      else if (['COMMIT', 'ROLLBACK'].includes(keyword)) s.pending = false;
      else if (['BEGIN', 'DECLARE'].includes(keyword)) { if (!opt.autoCommit) s.pending = true; } // 匿名區塊可能含 DML
      else if (!['SAVEPOINT', 'SET', 'LOCK'].includes(keyword)) s.pending = false; // DDL（含 CREATE PROCEDURE 等）會隱含提交
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
    await disconnect(id);
    await forgetPassword(id);
    ctx.storage.set('profiles', profiles().filter((x) => x.id !== id));
    return profiles();
  });

  ctx.ui.handle('forgetPassword', async (id) => { await forgetPassword(id); return savedPasswordIds(); });

  /* ───────── 連線 ───────── */

  /**
   * 以連線設定開啟一條連線，連線 id 等於連線設定 id；已連線時直接回傳（畫面切換過去即可）。
   * password 為 null 時使用記住的密碼；沒有記住的密碼則回傳 { needPassword: true }。
   * remember：true = 連線成功後記住，false = 清除已記住的，undefined = 不變。
   */
  ctx.ui.handle('connect', async (id, password, opts) => {
    const p = profiles().find((x) => x.id === id);
    if (!p) throw new Error('找不到連線設定');
    const existing = sessions.get(id);
    if (existing) return { ...state(), session: publicSession(existing), savedPasswords: savedPasswordIds(), already: true };
    if (connecting.has(id)) throw new Error(`「${p.name}」正在連線中`);
    if (sessions.size + connecting.size >= MAX_SESSIONS) {
      throw new Error(`最多同時開啟 ${MAX_SESSIONS} 條連線，請先中斷其中一條`);
    }
    connecting.add(id);
    try {
      return await openSession(p, password, opts);
    } finally {
      connecting.delete(id);
    }
  });

  /** @param {Profile} p @param {any} password @param {any} opts */
  async function openSession(p, password, opts) {
    const id = p.id;
    const remember = opts ? opts.remember : undefined;
    let pw = password;
    let fromSaved = false;
    if (pw == null) {
      pw = ctx.secrets && savedPasswordIds().includes(id) ? await ctx.secrets.get(secretKey(id)).catch(() => null) : null;
      if (pw == null) return { needPassword: true };
      fromSaved = true;
    }
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
    /** @type {any} */
    let info;
    try {
      c.callTimeout = Math.max(1, Number(setting('callTimeoutSeconds', 60))) * 1000;
      await c.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
      info = await c.execute("SELECT SYS_CONTEXT('USERENV','DB_NAME'), SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
    } catch (err) {
      await c.close().catch(() => {});
      throw err;
    }
    /** @type {Session} */
    const s = {
      id, profile: p, conn: c, pending: false, running: false,
      dbName: info.rows[0][0], schema: info.rows[0][1], serverVersion: c.oracleServerVersionString, connectedAt: Date.now(),
    };
    sessions.set(id, s);

    // 連線已建立：記住密碼失敗只提示，不影響連線
    let rememberError = null;
    try {
      if (remember === true && !fromSaved) {
        if (!(await secretsAvailable())) throw new Error('這個平台版本或作業系統不支援安全儲存，無法記住密碼');
        await /** @type {any} */ (ctx.secrets).set(secretKey(id), String(pw));
        ctx.storage.set('savedPasswords', [...new Set([...savedPasswordIds(), id])]);
      } else if (remember === false) {
        await forgetPassword(id);
      }
    } catch (err) {
      rememberError = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`無法記住密碼：${rememberError}`);
    }

    ctx.log.info(`已連線 ${p.user}@${connectString(p)}（${Date.now() - t0}ms${fromSaved ? '，使用記住的密碼' : ''}，目前 ${sessions.size} 條連線）`);
    emit();
    return { ...state(), session: publicSession(s), savedPasswords: savedPasswordIds(), rememberError };
  }

  ctx.ui.handle('disconnect', async (sid, opts) => { await disconnect(String(sid || ''), opts || {}); return state(); });

  /* ───────── 執行 ───────── */

  /**
   * binds 未提供而 SQL 含 :參數 時，回傳 { needBinds: [{ name, last }] } 讓畫面詢問；
   * 提供 binds（以大寫名稱為 key）時直接執行，並記住這次的值。
   */
  ctx.ui.handle('execute', async ({ sid, text, cursor, mode, binds }) => {
    const s = session(sid);
    if (s.running) throw new Error('這條連線上一個指令還在執行中');
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
    s.running = true;
    emit();
    const results = [];
    try {
      for (const stmt of list) {
        const r = await runOne(s, stmt, opt, values);
        results.push(r);
        if (!r.ok) break; // 腳本遇到錯誤即停止
      }
    } finally {
      s.running = false;
      const entry = list.map((s) => s.sql).join(';\n');
      ctx.storage.set('history', [entry, ...ctx.storage.get('history', []).filter((/** @type {string} */ h) => h !== entry)].slice(0, 50));
      emit();
    }
    return { results, state: state(), executed: results.length, total: list.length, range: list.length === 1 ? { start: list[0].start, end: list[0].end } : null };
  });

  ctx.ui.handle('cancel', async (sid) => {
    const s = sessions.get(String(sid || ''));
    if (s && s.running) await s.conn.break();
    return true;
  });

  ctx.ui.handle('commit', async (sid) => { const s = session(sid); await s.conn.commit(); s.pending = false; emit(); return state(); });
  ctx.ui.handle('rollback', async (sid) => { const s = session(sid); await s.conn.rollback(); s.pending = false; emit(); return state(); });
  ctx.ui.handle('setAutoCommit', async (on) => { await ctx.settings.update('oracleSql.autoCommit', !!on); emit(); return state(); });

  /* ───────── 資料表瀏覽 ───────── */

  /** @param {any} sid @param {string} sql @param {Record<string, any>} [binds] */
  async function meta(sid, sql, binds = {}) {
    const s = session(sid);
    if (s.running) throw new Error('指令執行中，請稍後再試');
    const r = /** @type {any} */ (await s.conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 5000 }));
    return r.rows;
  }

  ctx.ui.handle('listSchemas', async ({ sid }) => {
    const own = (await meta(sid, "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL"))[0].S;
    let rows = [];
    try {
      rows = await meta(sid, "SELECT DISTINCT owner AS S FROM all_objects WHERE object_type IN ('TABLE','VIEW') AND owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N') ORDER BY 1");
    } catch {
      rows = []; // 舊版資料庫沒有 oracle_maintained 欄位
    }
    const list = rows.map((/** @type {any} */ r) => r.S);
    return { current: own, schemas: [...new Set([own, ...list].filter(Boolean))] };
  });

  ctx.ui.handle('listObjects', async ({ sid, owner }) => meta(sid, `
    SELECT o.object_name AS name, o.object_type AS type, t.num_rows AS num_rows, c.comments AS comments
    FROM all_objects o
    LEFT JOIN all_tables t ON t.owner = o.owner AND t.table_name = o.object_name
    LEFT JOIN all_tab_comments c ON c.owner = o.owner AND c.table_name = o.object_name
    WHERE o.owner = :owner AND o.object_type IN ('TABLE', 'VIEW') AND o.object_name NOT LIKE 'BIN$%'
    ORDER BY o.object_type, o.object_name`, { owner: String(owner || '').toUpperCase() }));

  ctx.ui.handle('describe', async ({ sid, owner, name }) => {
    const rows = await meta(sid, `
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
    ctx.commands.register('oracleSql.disconnect', () => disconnectAll()),
    ctx.settings.onDidChange(() => emit()),
  );
};

/**
 * 平台結束前：回滾未提交的交易並關閉連線
 * @param {import('tooldock-types').ExtensionContext} ctx
 */
exports.onBeforeQuit = async (ctx) => {
  for (const s of [...sessions.values()]) {
    if (s.pending) ctx.log.warn(`平台結束：「${s.profile.name}」未提交的交易已回滾`);
    try { await closeSession(s, false); } catch { /* 忽略 */ }
  }
};

exports.deactivate = async () => {
  await Promise.all([...sessions.values()].map((s) => closeSession({ ...s, pending: true }, false).catch(() => {})));
  sessions.clear();
};
