/**
 * SQL 排版：用 backend/sql-split.js 切成一句一句，SQL 指令交給 sql-formatter（PL/SQL 方言）排版。
 * - 指令之間的註解、空行、單獨一行的 `/` 原樣保留
 * - PL/SQL 區塊（BEGIN / DECLARE / CREATE PROCEDURE…）不排版，原樣保留
 * - 排版失敗（語法無法解析）的指令原樣保留
 * - `:名稱`、`:1` 綁定變數不會被拆開
 *
 * 畫面端由 src-ui/sql-editor.js 打包使用；test/sql-format.test.js 直接在 Node 測試。
 */
// 只匯入 PL/SQL 方言，打包時其他方言會被去掉
import { formatDialect, plsql } from 'sql-formatter';
import { splitSql } from '../backend/sql-split.js';

/** @type {import('sql-formatter').FormatOptionsWithDialect} */
const OPTIONS = {
  dialect: plsql,
  tabWidth: 2,
  keywordCase: 'upper',
  dataTypeCase: 'upper',
  functionCase: 'upper',
  identifierCase: 'preserve',
  linesBetweenQueries: 1,
  paramTypes: { named: [':'], numbered: [':'] },
};

/**
 * @param {string} text
 * @returns {{ text: string, formatted: number, skippedPlsql: number, failed: { sql: string, error: string }[] }}
 */
export function formatSql(text) {
  const src = String(text);
  const result = { text: src, formatted: 0, skippedPlsql: 0, failed: /** @type {{ sql: string, error: string }[]} */ ([]) };
  let out = '';
  let pos = 0;
  for (const st of splitSql(src)) {
    out += src.slice(pos, st.start);
    const original = src.slice(st.start, st.end);
    pos = st.end;
    if (st.plsql) {
      result.skippedPlsql++;
      out += original;
      continue;
    }
    try {
      // 保留原本的結尾分號：有就加回，沒有就不加
      const hasSemi = /;\s*(--[^\n]*)?$/.test(original.trimEnd());
      let f = formatDialect(original, OPTIONS).trimEnd();
      if (!hasSemi) f = f.replace(/;$/, '');
      out += f;
      result.formatted++;
    } catch (err) {
      out += original;
      result.failed.push({ sql: st.sql, error: err instanceof Error ? err.message : String(err) });
    }
  }
  out += src.slice(pos);
  result.text = out;
  return result;
}
