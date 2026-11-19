'use strict';
/**
 * tooldock.sql 解析與型別轉換的單元測試（不需要資料庫）：npm test
 * 連到真正的 Oracle 測試見 oracle.test.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sx = require('../backend/sql-exchange');
const { prepare, toBind, normalizeDecimal, isoLocal, enforceSize } = require('../backend/exchange-exec');
const oracledb = require('oracledb');

test('參數解析略過字串、識別字引號、註解與 ::', () => {
  const sql = "SELECT ':a', \"b:c\", [d:e], `f:g`, x::int -- :h\n/* :i */ FROM t WHERE y = :real AND z = :r2 OR w = :real";
  assert.deepEqual(sx.placeholders(sql, 'postgres').map((p) => p.name), ['real', 'r2', 'real']);
  assert.ok(sx.isMultiStatement('SELECT 1; DROP TABLE t'));
  assert.ok(!sx.isMultiStatement("SELECT ';' ; -- x"));
});

test("Oracle 替代引號 q'[…]'、nq'{…}' 裡的 :名稱 與 ; 不算", () => {
  const sql = "SELECT q'[it's :x; ]', nq'{:y}', Q'!a'b!' FROM dual WHERE a = :real";
  assert.deepEqual(sx.placeholders(sql, 'oracle').map((p) => p.name), ['real']);
  assert.ok(!sx.isMultiStatement(sql, 'oracle'));
  // 其他方言沒有替代引號：'[it' 是一般字串，後面的 :x 才是參數
  assert.ok(sx.placeholders("SELECT q'[it's :x]' FROM dual", 'generic').some((p) => p.name === 'x'));
  assert.ok(!sx.placeholders("SELECT q'[it's :x]' FROM dual", 'oracle').some((p) => p.name === 'x'));
});

test(':名稱 改寫成 :p1…（同名共用），去掉結尾的 ;', () => {
  const { sql, map } = prepare('UPDATE t SET date_col = :date, b = :level WHERE c = :date;  ', 'oracle');
  assert.equal(sql, 'UPDATE t SET date_col = :p1, b = :p2 WHERE c = :p1');
  assert.deepEqual([...map], [['date', 'p1'], ['level', 'p2']]);
});

test('型別轉換與檢查（decimal 字串、datetime 帶時區、int 範圍、陣列參數）', () => {
  const ok = [['decimal', '12.50'], ['bigint', '9007199254740993'], ['datetime', '2026-11-19T09:30:00+08:00'], ['date', '2026-02-28'], ['time', '09:30:00.123'], ['binary', 'AP8='], ['json', { a: 1 }], ['decimal', null]];
  const bad = [['decimal', 12.5], ['datetime', '2026-11-19T09:30:00'], ['int', 2 ** 53], ['date', '2026-02-30'], ['time', '9:30'], ['bool', 'true']];
  for (const [t, v] of ok) assert.equal(sx.checkTyped(t, v), null, `${t} ${JSON.stringify(v)} 應通過`);
  for (const [t, v] of bad) assert.notEqual(sx.checkTyped(t, v), null, `${t} ${JSON.stringify(v)} 應失敗`);
  assert.equal(sx.inferTyped(3).type, 'int');
  assert.equal(sx.inferTyped(1.5).type, 'float');
  assert.throws(() => sx.parseValue([1, 2]), /陣列/);
  const a = sx.analyze({ dialect: 'oracle', target: { name: 'x', password: 'p' }, statements: [{ sql: 'SELECT :missing FROM dual' }], params: { unused: 1 } });
  assert.ok(a.errors.some((e) => /password/.test(e)));
  assert.ok(a.errors.some((e) => /:missing/.test(e)));
  assert.ok(a.warnings.some((w) => /:unused/.test(w)));
  const r = sx.analyze({ dialect: 'oracle', target: { name: 'x' }, statements: [{ sql: 'INSERT INTO t VALUES (:a)', rows: [{ a: { from: 'prompt', label: 'x' } }] }] });
  assert.ok(r.errors.some((e) => /prompt/.test(e)), 'rows 不應允許 prompt');
});

test('語句分類（WITH…UPDATE、MERGE、DDL、PL/SQL、RETURNING）', () => {
  const cases = [
    ['WITH x AS (SELECT 1 FROM dual) SELECT * FROM x', 'query'],
    ['MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.v = s.v', 'dml'],
    ['-- 註解\n/* 區塊 */ select 1 from dual', 'query'],
    ['TRUNCATE TABLE t', 'ddl'],
    ['CREATE TABLE t (a NUMBER)', 'ddl'],
    ['BEGIN dbms_output.put_line(1); END;', 'other'],
    ['CALL p()', 'other'],
    ['GRANT SELECT ON t TO u', 'other'],
  ];
  for (const [sql, cat] of cases) assert.equal(sx.classify(sql, 'oracle').category, cat, sql);
  const ret = sx.classify('INSERT INTO t (a) VALUES (1) RETURNING id INTO :id', 'oracle');
  assert.ok(ret.category === 'dml' && ret.returnsRows);
});

test('綁定：decimal / bigint 以字串、bool 以 1/0、date 是本機當天、datetime 保留時間點、有型別的 null', () => {
  assert.deepEqual(toBind({ type: 'decimal', value: '12.50' }), { val: '12.50', type: oracledb.DB_TYPE_VARCHAR });
  assert.deepEqual(toBind({ type: 'bool', value: true }), { val: 1, type: oracledb.DB_TYPE_NUMBER });
  const d = toBind({ type: 'date', value: '2026-02-28' });
  assert.equal(d.type, oracledb.DB_TYPE_DATE);
  assert.deepEqual([d.val.getFullYear(), d.val.getMonth(), d.val.getDate(), d.val.getHours()], [2026, 1, 28, 0]);
  const dt = toBind({ type: 'datetime', value: '2026-11-19T09:30:00+08:00' });
  assert.equal(dt.val.toISOString(), '2026-11-19T01:30:00.000Z');
  assert.deepEqual(toBind({ type: 'decimal', value: null }), { val: null, type: oracledb.DB_TYPE_VARCHAR });
  assert.deepEqual(toBind({ type: 'int', value: null }), { val: null, type: oracledb.DB_TYPE_NUMBER });
  assert.equal(toBind({ type: 'json', value: { a: [1] } }).val, '{"a":[1]}');
  assert.ok(Buffer.isBuffer(toBind({ type: 'binary', value: 'AP8=' }).val));
});

test('結果值：Oracle 省略的 0、帶時區的時間', () => {
  assert.equal(normalizeDecimal('.5'), '0.5');
  assert.equal(normalizeDecimal('-.25'), '-0.25');
  assert.equal(normalizeDecimal('12.5'), '12.5');
  assert.match(isoLocal(new Date(2026, 10, 19, 9, 30, 0)), /^2026-11-19T09:30:00[+-]\d{2}:\d{2}$/);
});

test('ImportResult.data 超過上限時從最後一個結果截斷', () => {
  const big = (n) => ({ columns: [{ name: 'a', type: 'string' }], rows: Array.from({ length: n }, (_, i) => [`row-${i}-${'x'.repeat(40)}`]), rowCount: n, truncated: false });
  const data = { statements: [{ id: 'a', results: [big(50)] }, { id: 'b', results: [big(50)] }] };
  assert.ok(enforceSize(data, 3000));
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 3000);
  assert.equal(data.statements[1].results[0].truncated, true);
  assert.equal(data.statements[1].results[0].rowCount, data.statements[1].results[0].rows.length);
});
