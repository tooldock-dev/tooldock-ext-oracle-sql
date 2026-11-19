'use strict';
/**
 * tooldock.sql v1 的解析與檢查（ToolDock docs/EXCHANGE.md〈6〉），不依賴任何資料庫驅動程式。
 * 其他資料庫工具可以直接沿用這個檔案，只替換執行的部分（這裡是 exchange-exec.js）。
 * 方言為 oracle 時另外認得 Oracle 的替代引號字串 q'[…]'、nq'{…}'。
 */

const DIALECTS = ['sqlite', 'mssql', 'postgres', 'mysql', 'oracle', 'generic'];
const TRANSACTIONS = ['all', 'statement', 'none'];
const TYPES = ['string', 'int', 'bigint', 'decimal', 'float', 'bool', 'date', 'time', 'datetime', 'binary', 'json', 'null'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTEXT_KEYS = { now: 'datetime', today: 'date', user: 'string', 'package.id': 'string', 'source.extId': 'string' };
const CREDENTIAL_KEYS = /^(host|hostname|server|port|user|username|uid|password|pwd|passwd|connectionstring|connection|dsn|url|secret|token)$/i;
const MAX_STATEMENTS = 1000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ───────────────────────── 詞法分析 ───────────────────────── */

/**
 * 把 SQL 切成 token，略過字串常值、識別字引號、註解與 postgres 的 `::`（〈6.3〉）。
 * token：{ t: 'word' | 'var' | 'param' | 'str' | 'ident' | 'num' | 'punct' | 'comment', v, start, end }
 */
function lex(sql, dialect = 'generic') {
  const s = String(sql);
  const out = [];
  let i = 0;
  const n = s.length;
  const push = (t, start, end, v) => out.push({ t, v: v === undefined ? s.slice(start, end) : v, start, end });
  const closeQuote = (q, from, { backslash = false, doubled = true } = {}) => {
    let j = from;
    while (j < n) {
      const c = s[j];
      if (backslash && c === '\\') { j += 2; continue; }
      if (c === q) {
        if (doubled && s[j + 1] === q) { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return n; // 沒有結尾：視為到字串結束
  };
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && next === '-') {
      const end = s.indexOf('\n', i);
      const j = end < 0 ? n : end;
      push('comment', i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      push('comment', i, j);
      i = j;
      continue;
    }
    if (dialect === 'oracle' && /[qQ]/.test(c) && next === "'" && s[i + 2] && !/\s/.test(s[i + 2])) {
      // Oracle 替代引號：q'[…]'、q'{…}'、q'(…)'、q'<…>'，或任意字元 q'!…!'（前面可以有 N）
      const open = s[i + 2];
      const close = { '[': ']', '{': '}', '(': ')', '<': '>' }[open] || open;
      const end = s.indexOf(`${close}'`, i + 3);
      const j = end < 0 ? n : end + 2;
      push('str', i, j);
      i = j;
      continue;
    }
    if (dialect === 'oracle' && /[nN]/.test(c) && /[qQ]/.test(next || '') && s[i + 2] === "'") {
      i++; // nq'…'：略過 N，下一輪以 q'…' 處理
      continue;
    }
    if (c === "'") {
      const j = closeQuote("'", i + 1, { backslash: dialect === 'mysql' });
      push('str', i, j);
      i = j;
      continue;
    }
    if ((c === 'E' || c === 'e') && next === "'" && dialect === 'postgres') {
      const j = closeQuote("'", i + 2, { backslash: true });
      push('str', i, j);
      i = j;
      continue;
    }
    if (c === '$' && (dialect === 'postgres' || dialect === 'generic')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const end = s.indexOf(tag, i + tag.length);
        const j = end < 0 ? n : end + tag.length;
        push('str', i, j);
        i = j;
        continue;
      }
    }
    if (c === '"') { const j = closeQuote('"', i + 1); push('ident', i, j); i = j; continue; }
    if (c === '`') { const j = closeQuote('`', i + 1); push('ident', i, j); i = j; continue; }
    if (c === '[') { const j = closeQuote(']', i + 1); push('ident', i, j); i = j; continue; }
    if (c === ':' && next === ':') { push('punct', i, i + 2); i += 2; continue; }
    if (c === ':' && /[A-Za-z_]/.test(next || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++;
      push('param', i, j, s.slice(i + 1, j));
      i = j;
      continue;
    }
    if (c === '@' && /[A-Za-z_@]/.test(next || '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_@$.]/.test(s[j])) j++;
      push('var', i, j);
      i = j;
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(s[j])) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(s[j])) j++;
      push('num', i, j);
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}

/** SQL 中出現的佔位符（依出現順序，可重複） */
function placeholders(sql, dialect) {
  return lex(sql, dialect).filter((t) => t.t === 'param').map((t) => ({ name: t.v, start: t.start, end: t.end }));
}

/** 一個項目只能有一個語句：`;` 之後如果還有內容（註解除外）就是串接多個語句 */
function isMultiStatement(sql, dialect) {
  const toks = lex(sql, dialect).filter((t) => t.t !== 'comment');
  const semi = toks.findIndex((t) => t.t === 'punct' && t.v === ';');
  if (semi < 0) return false;
  return toks.slice(semi + 1).some((t) => !(t.t === 'punct' && t.v === ';'));
}

/**
 * 把 `:名稱` 轉成驅動程式的寫法（〈6.3〉）：
 *   question → `?`（sqlite / mysql）、at → `@名稱`（mssql）、dollar → `$1`（postgres）
 * 回傳 { sql, order }：order 是每個位置對應的參數名稱（at 樣式時不重複）
 */
function rewrite(sql, style = 'question', dialect = 'generic') {
  const s = String(sql);
  const params = placeholders(s, dialect);
  let out = '';
  let last = 0;
  const order = [];
  const dollar = new Map();
  for (const p of params) {
    out += s.slice(last, p.start);
    if (style === 'at') {
      out += `@${p.name}`;
      if (!order.includes(p.name)) order.push(p.name);
    } else if (style === 'dollar') {
      if (!dollar.has(p.name)) { order.push(p.name); dollar.set(p.name, order.length); }
      out += `$${dollar.get(p.name)}`;
    } else {
      out += '?';
      order.push(p.name);
    }
    last = p.end;
  }
  out += s.slice(last);
  return { sql: out.replace(/;\s*$/, ''), order };
}

/* ───────────────────────── 語句分類（〈6.5〉） ───────────────────────── */

const QUERY = ['SELECT', 'VALUES', 'SHOW', 'TABLE'];
const DML = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT'];
const DDL = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'];

/** 跳過成對括號，回傳右括號之後的位置；沒有成對時回傳 -1 */
function skipParens(toks, i) {
  if (!toks[i] || toks[i].v !== '(') return -1;
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t !== 'punct') continue;
    if (toks[j].v === '(') depth++;
    else if (toks[j].v === ')') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

/** 跳過 `WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] (…) [, …]`，回傳主要語句的位置 */
function skipWith(toks, i) {
  const kw = (k) => (toks[k] && toks[k].t === 'word' ? toks[k].v.toUpperCase() : null);
  if (kw(i) === 'RECURSIVE') i++;
  for (;;) {
    if (!toks[i] || !['word', 'ident'].includes(toks[i].t)) return -1;
    i++;
    if (toks[i] && toks[i].v === '(') { i = skipParens(toks, i); if (i < 0) return -1; }
    if (kw(i) !== 'AS') return -1;
    i++;
    if (kw(i) === 'NOT') i++;
    if (kw(i) === 'MATERIALIZED') i++;
    i = skipParens(toks, i);
    if (i < 0) return -1;
    if (toks[i] && toks[i].t === 'punct' && toks[i].v === ',') { i++; continue; }
    return i;
  }
}

/** 頂層（括號外）的 token，從 from 開始 */
function topLevel(toks, from) {
  const out = [];
  let depth = 0;
  for (let j = from; j < toks.length; j++) {
    const t = toks[j];
    if (t.t === 'punct' && t.v === '(') { depth++; continue; }
    if (t.t === 'punct' && t.v === ')') { depth--; continue; }
    if (depth === 0) out.push({ ...t, index: j });
  }
  return out;
}

/**
 * 依第一個關鍵字分類（略過註解與 WITH 前綴）。
 * @returns {{ category: 'query' | 'dml' | 'ddl' | 'other', keyword: string | null, returnsRows: boolean }}
 */
function classify(sql, dialect = 'generic') {
  const toks = lex(sql, dialect).filter((t) => t.t !== 'comment');
  const kw = (k) => (toks[k] && toks[k].t === 'word' ? toks[k].v.toUpperCase() : null);
  let i = 0;
  while (toks[i] && toks[i].t === 'punct' && toks[i].v === '(') i++; // (SELECT …)
  if (kw(i) === 'WITH') {
    i = skipWith(toks, i + 1);
    if (i < 0) return { category: 'other', keyword: 'WITH', returnsRows: false };
  }
  const first = kw(i);
  if (!first) return { category: 'other', keyword: null, returnsRows: false };
  const top = topLevel(toks, i + 1);
  const topWord = (w) => top.findIndex((t) => t.t === 'word' && t.v.toUpperCase() === w);

  if (first === 'EXPLAIN') {
    const nk = kw(i + 1);
    let analyze = nk === 'ANALYZE' || nk === 'ANALYSE';
    if (!analyze && toks[i + 1] && toks[i + 1].v === '(') {
      const end = skipParens(toks, i + 1);
      analyze = toks.slice(i + 2, end < 0 ? toks.length : end - 1).some((t) => t.t === 'word' && /^ANALY[SZ]E$/i.test(t.v));
    }
    return analyze
      ? { category: 'other', keyword: 'EXPLAIN ANALYZE', returnsRows: true }
      : { category: 'query', keyword: 'EXPLAIN', returnsRows: true };
  }
  if (first === 'SELECT') {
    const into = topWord('INTO');
    if (into >= 0) {
      const target = top[into + 1];
      const mysqlInto = target && (target.t === 'var' || (target.t === 'word' && /^(OUTFILE|DUMPFILE)$/i.test(target.v)));
      return mysqlInto
        ? { category: 'other', keyword: 'SELECT INTO', returnsRows: false }
        : { category: 'ddl', keyword: 'SELECT INTO', returnsRows: false };
    }
    return { category: 'query', keyword: first, returnsRows: true };
  }
  if (QUERY.includes(first)) return { category: 'query', keyword: first, returnsRows: true };
  if (DML.includes(first)) {
    const returning = topWord('RETURNING') >= 0;
    const output = top.some((t, k) => t.t === 'word' && t.v.toUpperCase() === 'OUTPUT'
      && top[k + 1] && top[k + 1].t === 'word' && /^(INSERTED|DELETED)$/i.test(top[k + 1].v));
    return { category: 'dml', keyword: first, returnsRows: returning || output };
  }
  if (DDL.includes(first)) return { category: 'ddl', keyword: first, returnsRows: false };
  return { category: 'other', keyword: first, returnsRows: false };
}

/* ───────────────────────── 型別與值（〈6.4〉） ───────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}(\.\d{3})?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 檢查有型別的值；回傳錯誤訊息或 null。value 為 null 時任何型別都可以（有型別的 null） */
function checkTyped(type, value) {
  if (!TYPES.includes(type)) return `不認得的型別「${type}」`;
  if (value === null) return null;
  if (value === undefined) return type === 'null' ? null : '缺少 value';
  switch (type) {
    case 'string': return typeof value === 'string' ? null : '必須是字串';
    case 'int': return Number.isSafeInteger(value) ? null : '必須是 ±2^53−1 以內的整數（超過時請用 bigint）';
    case 'bigint': return typeof value === 'string' && /^-?\d+$/.test(value) ? null : '必須是十進位整數字串';
    case 'decimal': return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? null : '必須是十進位字串，例如 "12.50"（不得用 JSON 數字）';
    case 'float': return typeof value === 'number' && Number.isFinite(value) ? null : '必須是數字';
    case 'bool': return typeof value === 'boolean' ? null : '必須是 true / false';
    case 'date': return typeof value === 'string' && validDate(value) ? null : '必須是 YYYY-MM-DD';
    case 'time': return typeof value === 'string' && TIME_RE.test(value) ? null : '必須是 HH:mm:ss 或 HH:mm:ss.SSS';
    case 'datetime': return typeof value === 'string' && DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value)) ? null : '必須是帶時區的 ISO 8601 時間';
    case 'binary': return typeof value === 'string' && BASE64_RE.test(value) ? null : '必須是 base64 字串';
    case 'json': return null;
    case 'null': return '型別為 null 時 value 只能是 null';
    default: return null;
  }
}

/** JSON 純量推斷型別（〈6.4〉）；陣列與沒有 type 的物件不支援 */
function inferTyped(value) {
  if (value === null) return { type: 'null', value: null };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'bool', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('數字必須是有限值');
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new Error('整數超過 ±2^53−1，請改用 { "type": "bigint", "value": "…" }');
      return { type: 'int', value };
    }
    return { type: 'float', value };
  }
  if (Array.isArray(value)) throw new Error('v1 不支援陣列參數，請展開成多個參數或使用 rows');
  throw new Error('物件必須寫成 { "type": …, "value": … }');
}

/** 參數值：純量或 { type, value } */
function parseValue(raw) {
  if (isPlainObject(raw) && 'type' in raw) {
    const err = checkTyped(raw.type, raw.value === undefined ? undefined : raw.value);
    if (err) throw new Error(`${raw.type}：${err}`);
    return { type: raw.type, value: raw.value === undefined ? null : raw.value };
  }
  return inferTyped(raw);
}

/**
 * 參數定義（payload.params / statements[].params）：value（預設）、prompt、context（〈6.3〉）
 * @returns {{ from: 'value' | 'prompt' | 'context', type: string, value?: any, label?, required?, default?, options?, description?, key? }}
 */
function parseParamDef(name, raw) {
  if (!NAME_RE.test(name)) throw new Error(`參數名稱「${name}」不合法`);
  if (!isPlainObject(raw) || !('from' in raw)) {
    // 純量、{ type, value }，或省略 type 的 { value }
    if (isPlainObject(raw) && !('type' in raw) && 'value' in raw) return { from: 'value', ...inferTyped(raw.value) };
    return { from: 'value', ...parseValue(raw) };
  }
  const from = raw.from;
  if (from === 'value') return { from, ...parseValue('type' in raw ? { type: raw.type, value: raw.value } : raw.value) };
  if (from === 'prompt') {
    if (typeof raw.label !== 'string' || !raw.label) throw new Error('prompt 參數必須有 label');
    const type = raw.type || 'string';
    if (!TYPES.includes(type) || type === 'null') throw new Error(`不支援的 prompt 型別「${type}」`);
    const options = raw.options === undefined ? undefined : raw.options;
    if (options !== undefined && !Array.isArray(options)) throw new Error('options 必須是陣列');
    const opts = options && options.map((o) => (isPlainObject(o) ? { value: o.value, label: String(o.label ?? o.value) } : { value: o, label: String(o) }));
    if (opts) for (const o of opts) { const e = checkTyped(type, o.value); if (e) throw new Error(`options 的值 ${JSON.stringify(o.value)}：${e}`); }
    if (raw.default !== undefined && raw.default !== null) { const e = checkTyped(type, raw.default); if (e) throw new Error(`default：${e}`); }
    return {
      from, type, label: raw.label, required: !!raw.required,
      ...(raw.default !== undefined ? { default: raw.default } : {}),
      ...(opts ? { options: opts } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    };
  }
  if (from === 'context') {
    if (!(raw.key in CONTEXT_KEYS)) throw new Error(`不認得的 context key「${raw.key}」（可用 ${Object.keys(CONTEXT_KEYS).join('、')}）`);
    return { from, key: raw.key, type: CONTEXT_KEYS[raw.key] };
  }
  throw new Error(`不認得的參數來源 from「${from}」`);
}

/** 使用者在預覽畫面輸入的 prompt 值（字串或 checkbox）轉成參數型別 */
function coercePrompt(def, raw) {
  const empty = raw === undefined || raw === null || raw === '';
  if (empty) {
    if (def.required) throw new Error(`請填寫「${def.label}」`);
    return { type: def.type, value: null };
  }
  let value = raw;
  switch (def.type) {
    case 'int': value = typeof raw === 'number' ? raw : Number(String(raw).trim()); break;
    case 'float': value = typeof raw === 'number' ? raw : Number(String(raw).trim()); break;
    case 'bool': value = raw === true || raw === 'true' || raw === '1'; break;
    case 'json':
      if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { throw new Error(`「${def.label}」不是有效的 JSON`); } }
      break;
    case 'datetime':
      // <input type="datetime-local"> 沒有時區：補上本機時區
      if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) value = withLocalOffset(raw);
      break;
    case 'time':
      if (typeof raw === 'string' && /^\d{2}:\d{2}$/.test(raw)) value = `${raw}:00`;
      break;
    default: value = typeof raw === 'string' ? raw.trim() : raw;
  }
  const err = checkTyped(def.type, value);
  if (err) throw new Error(`「${def.label}」${err}`);
  if (def.options && !def.options.some((o) => o.value === value)) throw new Error(`「${def.label}」必須是選項之一`);
  return { type: def.type, value };
}

function withLocalOffset(local, date = new Date(local)) {
  const off = -date.getTimezoneOffset();
  const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  return `${local.length === 16 ? `${local}:00` : local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

/* ───────────────────────── 整包分析 ───────────────────────── */

/**
 * 驗證 payload 並分析每個語句（〈6.2〉、〈6.3〉、〈6.5〉）。
 * errors 有內容時整包拒絕；warnings 只顯示。
 */
function analyze(payload, { allowDDL = false, allowOther = false } = {}) {
  const errors = [];
  const warnings = [];
  const p = isPlainObject(payload) ? payload : {};
  if (!isPlainObject(payload)) errors.push('payload 必須是物件');

  const dialect = p.dialect;
  if (!DIALECTS.includes(dialect)) errors.push(`dialect 必須是 ${DIALECTS.join(' / ')}`);
  const target = isPlainObject(p.target) ? p.target : null;
  if (!target || typeof target.name !== 'string' || !target.name.trim()) errors.push('target.name 必填');
  if (target) {
    const bad = Object.keys(target).filter((k) => CREDENTIAL_KEYS.test(k));
    if (bad.length) errors.push(`target 不得包含主機、帳號、密碼或連線字串（${bad.join('、')}）`);
  }
  const transaction = p.transaction === undefined ? 'all' : p.transaction;
  if (!TRANSACTIONS.includes(transaction)) errors.push(`transaction 必須是 ${TRANSACTIONS.join(' / ')}`);
  const options = isPlainObject(p.options) ? p.options : {};
  if (p.options !== undefined && !isPlainObject(p.options)) errors.push('options 必須是物件');
  const checkExpect = (e, where) => {
    if (e === undefined) return null;
    if (!isPlainObject(e)) { errors.push(`${where} expect 必須是物件`); return null; }
    for (const k of ['maxAffectedRows', 'affectedRows']) {
      if (e[k] !== undefined && !(Number.isInteger(e[k]) && e[k] >= 0)) errors.push(`${where} expect.${k} 必須是非負整數`);
    }
    return { ...(e.maxAffectedRows !== undefined ? { maxAffectedRows: e.maxAffectedRows } : {}), ...(e.affectedRows !== undefined ? { affectedRows: e.affectedRows } : {}) };
  };
  const expect = checkExpect(p.expect, '整包');

  const parseDefs = (raw, where) => {
    const defs = {};
    if (raw === undefined) return defs;
    if (!isPlainObject(raw)) { errors.push(`${where} params 必須是物件`); return defs; }
    for (const [name, def] of Object.entries(raw)) {
      try { defs[name] = parseParamDef(name, def); } catch (err) { errors.push(`${where}參數 :${name}：${err.message}`); }
    }
    return defs;
  };
  const shared = parseDefs(p.params, '');
  const used = new Set();

  const list = Array.isArray(p.statements) ? p.statements : [];
  if (!Array.isArray(p.statements) || !list.length) errors.push('statements 至少要有 1 個語句');
  if (list.length > MAX_STATEMENTS) errors.push(`statements 最多 ${MAX_STATEMENTS} 個`);

  const statements = list.slice(0, MAX_STATEMENTS).map((st, index) => {
    const label = st && st.id ? `語句「${st.id}」` : `第 ${index + 1} 個語句`;
    const sql = st && typeof st.sql === 'string' ? st.sql : '';
    if (!isPlainObject(st)) { errors.push(`${label}必須是物件`); }
    if (!sql.trim()) errors.push(`${label}缺少 sql`);
    if (sql && isMultiStatement(sql, dialect)) errors.push(`${label}以 ; 串接了多個語句，一個項目只能有一個語句`);
    const own = parseDefs(st && st.params, `${label}的`);
    const names = [...new Set(placeholders(sql, dialect).map((x) => x.name))];
    const cls = sql ? classify(sql, dialect) : { category: 'other', keyword: null, returnsRows: false };

    let rows = null;
    if (st && st.rows !== undefined) {
      if (!Array.isArray(st.rows)) errors.push(`${label}的 rows 必須是陣列`);
      else {
        rows = [];
        st.rows.forEach((row, ri) => {
          if (!isPlainObject(row)) { errors.push(`${label}的 rows[${ri}] 必須是物件`); rows.push({}); return; }
          const parsed = {};
          for (const [name, v] of Object.entries(row)) {
            if (isPlainObject(v) && 'from' in v) { errors.push(`${label}的 rows[${ri}].${name}：rows 裡不能使用 prompt / context`); continue; }
            try { parsed[name] = parseValue(v); } catch (err) { errors.push(`${label}的 rows[${ri}].${name}：${err.message}`); }
          }
          rows.push(parsed);
        });
      }
    }

    // 參數查找順序：rows[i] → statements[].params → payload.params（〈6.3〉）
    for (const name of names) {
      const inDefs = name in own || name in shared;
      if (rows) {
        const missingAt = rows.findIndex((r) => !(name in r) && !inDefs);
        if (missingAt >= 0) errors.push(`${label}使用的參數 :${name} 在 rows[${missingAt}] 找不到值`);
      } else if (!inDefs) {
        errors.push(`${label}使用的參數 :${name} 找不到值`);
      }
      if (name in own) used.add(`s${index}:${name}`);
      else if (name in shared) used.add(`p:${name}`);
    }
    for (const name of Object.keys(own)) if (!names.includes(name)) warnings.push(`${label}定義了參數 :${name} 但沒有使用`);
    if (rows) {
      const extra = new Set();
      rows.forEach((r) => Object.keys(r).forEach((k) => { if (!names.includes(k)) extra.add(k); }));
      if (extra.size) warnings.push(`${label}的 rows 有沒有使用的欄位：${[...extra].join('、')}`);
    }

    const maxRows = st && st.maxRows;
    if (maxRows !== undefined && !(Number.isInteger(maxRows) && maxRows >= 1)) errors.push(`${label}的 maxRows 必須是正整數`);
    const stExpect = checkExpect(st && st.expect, label);

    let allowed = true;
    let reason = null;
    if (cls.category === 'ddl' && !(allowDDL && options.allowDDL === true)) {
      allowed = false;
      reason = allowDDL ? 'DDL 需要交換包的 options.allowDDL 請求' : 'DDL 預設拒絕（設定「允許 DDL」才會開放）';
    } else if (cls.category === 'other' && !allowOther) {
      allowed = false;
      reason = `「${cls.keyword || '無法判斷'}」屬於其他類別，預設拒絕（設定「允許其他語句」才會開放）`;
    }
    if (!allowed) errors.push(`${label}不允許執行：${reason}`);

    return {
      index,
      id: st && st.id != null ? String(st.id) : null,
      label,
      sql,
      ...cls,
      allowed,
      reason,
      params: own,
      names,
      rows,
      rowsCount: rows ? rows.length : null,
      maxRows: maxRows === undefined ? null : maxRows,
      expect: stExpect,
    };
  });

  for (const name of Object.keys(shared)) {
    if (!used.has(`p:${name}`) && !statements.some((s) => s.names.includes(name))) warnings.push(`定義了參數 :${name} 但沒有使用`);
  }

  const prompts = [];
  const pushPrompt = (name, def, scope) => { if (def.from === 'prompt') prompts.push({ name, scope, ...def }); };
  Object.entries(shared).forEach(([n, d]) => pushPrompt(n, d, null));
  statements.forEach((s) => Object.entries(s.params).forEach(([n, d]) => pushPrompt(n, d, s.index)));

  const hasDML = statements.some((s) => s.category === 'dml' || s.category === 'ddl' || s.category === 'other');
  const hasQuery = statements.some((s) => s.returnsRows);
  return {
    errors,
    warnings,
    dialect,
    target,
    transaction,
    options,
    expect,
    params: shared,
    statements,
    prompts,
    hasDML,
    hasQuery,
    queryOnly: !hasDML,
  };
}

/** prompt 參數的鍵：共用參數用名稱，語句專用參數加上語句索引 */
const promptKey = (p) => (p.scope === null ? p.name : `${p.scope}:${p.name}`);

/**
 * 解析單次執行要綁定的值（rows[i] → statements[].params → payload.params）
 * @returns {Record<string, { type, value }>}
 */
function resolveValues(analysis, stmt, row, { prompts = {}, context = {} } = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  const fromDef = (def, name, scope) => {
    if (def.from === 'value') return { type: def.type, value: def.value };
    if (def.from === 'context') return { type: def.type, value: context[def.key] };
    const key = scope === null ? name : `${scope}:${name}`;
    return coercePrompt(def, key in prompts ? prompts[key] : def.default);
  };
  for (const name of stmt.names) {
    if (row && name in row) out[name] = row[name];
    else if (name in stmt.params) out[name] = fromDef(stmt.params[name], name, stmt.index);
    else if (name in analysis.params) out[name] = fromDef(analysis.params[name], name, null);
    else throw new Error(`${stmt.label}的參數 :${name} 找不到值`);
  }
  return out;
}

/** 檢查所有 prompt 都填好（required、型別、選項） */
function checkPrompts(analysis, prompts = {}) {
  const errors = [];
  for (const p of analysis.prompts) {
    const key = promptKey(p);
    try { coercePrompt(p, key in prompts ? prompts[key] : p.default); } catch (err) { errors.push(err.message); }
  }
  return errors;
}

/** 執行時的 context 值：同一包內所有語句共用 */
function contextValues(pkg, date = new Date(), user = '') {
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const local = `${today}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return {
    now: withLocalOffset(local, date),
    today,
    user,
    'package.id': pkg.id,
    'source.extId': pkg.source && pkg.source.extId != null ? String(pkg.source.extId) : '',
  };
}

module.exports = {
  DIALECTS,
  TYPES,
  CONTEXT_KEYS,
  lex,
  placeholders,
  isMultiStatement,
  rewrite,
  classify,
  checkTyped,
  inferTyped,
  parseValue,
  parseParamDef,
  coercePrompt,
  analyze,
  promptKey,
  resolveValues,
  checkPrompts,
  contextValues,
};
