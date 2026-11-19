'use strict';
/**
 * 把 SQL 腳本切成一條條可執行的指令（SQL*Plus 慣例）：
 * - 一般 SQL：以行尾的 `;` 結束（忽略字串與註解中的 `;`）
 * - PL/SQL（BEGIN / DECLARE / CREATE [OR REPLACE] FUNCTION|PROCEDURE|PACKAGE|TRIGGER|TYPE）：以單獨一行的 `/` 結束
 * 回傳 [{ sql, start, end, plsql }]，start / end 為原文中的字元位置（供「執行游標所在指令」使用）。
 */

const PLSQL_START = /^\s*(DECLARE\b|BEGIN\b|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(FUNCTION|PROCEDURE|PACKAGE|TRIGGER|TYPE|LIBRARY)\b)/i;

/** 去掉註解與字串內容後，判斷這一行在程式碼層面是否以 ; 結束；同時回報字串 / 區塊註解是否跨行 */
function scanLine(line, state) {
  let code = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (state.block) {
      if (c === '*' && n === '/') { state.block = false; i++; }
      continue;
    }
    if (state.quote) {
      if (c === "'") {
        if (n === "'") { i++; continue; }
        state.quote = false;
      }
      continue;
    }
    if (c === '-' && n === '-') break;
    if (c === '/' && n === '*') { state.block = true; i++; continue; }
    if (c === "'") { state.quote = true; code += "''"; continue; }
    code += c;
  }
  return code;
}

function splitSql(text) {
  const out = [];
  const lines = String(text).split('\n');
  let pos = 0;
  let cur = null; // { start, lines: [], plsql }
  const state = { quote: false, block: false };

  const finish = (endPos, stripSemicolon) => {
    let sql = cur.lines.join('\n').trim();
    if (stripSemicolon) sql = sql.replace(/;\s*$/, '');
    if (sql) out.push({ sql, start: cur.start, end: endPos, plsql: cur.plsql });
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const lineStart = pos;
    pos += raw.length + 1;
    const insideLiteral = state.quote || state.block;

    if (!cur) {
      if (!insideLiteral && (!line.trim() || /^\s*--/.test(line))) continue;
      if (!insideLiteral && /^\s*\/\s*$/.test(line)) continue;
      cur = { start: lineStart, lines: [], plsql: PLSQL_START.test(line) };
    }

    if (cur.plsql) {
      if (!insideLiteral && /^\s*\/\s*$/.test(line)) { finish(lineStart, false); continue; }
      cur.lines.push(line);
      scanLine(line, state);
      continue;
    }

    cur.lines.push(line);
    const code = scanLine(line, state);
    if (!state.quote && !state.block && /;\s*$/.test(code)) finish(pos - 1, true);
  }
  if (cur) finish(pos - 1, !cur.plsql);
  return out;
}

/** 找出游標所在（或游標之前最近）的指令 */
function statementAt(text, cursor) {
  const list = splitSql(text);
  if (!list.length) return null;
  const hit = list.find((s) => cursor >= s.start && cursor <= s.end + 1);
  if (hit) return hit;
  const before = list.filter((s) => s.end < cursor);
  return before.length ? before[before.length - 1] : list[0];
}

module.exports = { splitSql, statementAt };
