'use strict';
/** SQL 排版（src-ui/sql-format.mjs） */
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindNames } = require('../backend/sql-split.js');

/** @type {typeof import('../src-ui/sql-format.mjs').formatSql} */
let formatSql;
test.before(async () => { ({ formatSql } = await import('../src-ui/sql-format.mjs')); });

/** 去掉空白並轉大寫：排版前後應該相同（只改空白與關鍵字大小寫） */
const tokens = (/** @type {string} */ s) => s.replace(/\s+/g, '').toUpperCase();

test('SQL 指令排版，關鍵字轉大寫', () => {
  const r = formatSql('select a, b from t where x = 1;');
  assert.equal(r.text, 'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1;');
  assert.equal(r.formatted, 1);
});

test('排版只改空白與大小寫，綁定變數不被拆開', () => {
  const src = "select e.id, nvl(e.name,'無名') as \"Name\" from emp e where e.dept = :dept and e.id = :1 and e.code = 'a;b:c';";
  const r = formatSql(src);
  assert.equal(tokens(r.text), tokens(src));
  assert.deepEqual(bindNames(r.text), bindNames(src));
  assert.match(r.text, /= :dept\b/);
  assert.match(r.text, /= :1\b/);
  assert.match(r.text, /"Name"/);
  assert.match(r.text, /'無名'/);
});

test('指令之間的註解、空行保留（區塊註解屬於下一句，緊貼該句）', () => {
  const r = formatSql('-- 開頭\nselect 1 from dual;\n\n\n/* 區塊註解 */\n\nselect 2 from dual;\n');
  assert.equal(r.text, '-- 開頭\nSELECT\n  1\nFROM\n  dual;\n\n\n/* 區塊註解 */\nSELECT\n  2\nFROM\n  dual;\n');
  assert.equal(r.formatted, 2);
});

test('PL/SQL 區塊與 / 原樣保留', () => {
  const block = 'DECLARE\n  v NUMBER := 0;\nBEGIN\n  select count(*) into v from dual;\nEND;\n/\n';
  const r = formatSql(`${block}select 1 from dual;\n`);
  assert.ok(r.text.startsWith(block));
  assert.equal(r.skippedPlsql, 1);
  assert.equal(r.formatted, 1);
  assert.ok(r.text.endsWith('SELECT\n  1\nFROM\n  dual;\n'));
});

test('沒有分號的指令不會被加上分號', () => {
  assert.equal(formatSql('select sysdate from dual').text, 'SELECT\n  sysdate\nFROM\n  dual');
});

test('無法解析的指令原樣保留並回報', () => {
  const src = 'select ((( from;\nselect 1 from dual;\n';
  const r = formatSql(src);
  assert.ok(r.text.startsWith('select ((( from;\n'));
  assert.equal(r.failed.length, 1);
  assert.equal(r.formatted, 1);
});

test('Oracle 語法：q 引號、CONNECT BY、MERGE', () => {
  const src = "select q'[it's]' from dual;\nselect a from t connect by prior id = parent_id start with parent_id is null;\n"
    + 'merge into t using s on (t.id = s.id) when matched then update set t.v = s.v;\n';
  const r = formatSql(src);
  assert.equal(r.failed.length, 0);
  assert.equal(tokens(r.text), tokens(src));
  assert.match(r.text, /q'\[it's\]'/);
});

test('重複排版結果不變', () => {
  const src = "-- x\nselect a,b from t where c = :c order by 1;\nupdate t set a = 1 where b in (select b from u);\n";
  const once = formatSql(src).text;
  assert.equal(formatSql(once).text, once);
});

test('空白內容', () => {
  assert.deepEqual(formatSql('  \n'), { text: '  \n', formatted: 0, skippedPlsql: 0, failed: [] });
});
