'use strict';
/**
 * 連到真正的 Oracle 執行 tooldock.sql（交易、試跑、expect、maxRows、型別）。
 * 需要一個可以建立資料表的測試帳號，沒有設定時整個檔案略過：
 *
 *   ORACLE_TEST_CONNECT=localhost:1521/FREEPDB1 ORACLE_TEST_USER=… ORACLE_TEST_PASSWORD=… npm test
 *
 * 測試會建立名稱以 TDX_T_ 開頭的暫時資料表，結束時刪除。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const oracledb = require('oracledb');
const { analyze, contextValues } = require('../backend/sql-exchange');
const { execute } = require('../backend/exchange-exec');

const { ORACLE_TEST_CONNECT: connectString, ORACLE_TEST_USER: user, ORACLE_TEST_PASSWORD: password } = process.env;
const skip = !(connectString && user && password) && '沒有設定 ORACLE_TEST_CONNECT / ORACLE_TEST_USER / ORACLE_TEST_PASSWORD';

test('Oracle 執行 tooldock.sql', { skip }, async (t) => {
  const conn = await oracledb.getConnection({ user, password, connectString });
  const table = `TDX_T_${Date.now().toString(36).toUpperCase()}`;
  const ctx = contextValues({ id: 'test', source: { extId: 'test' } }, new Date(), 'tester');
  const run = (payload, opts = {}) => execute(conn, analyze({ dialect: 'oracle', target: { name: 'x' }, ...payload }), { context: ctx, ...opts });
  const count = async (where = '1 = 1') => Number((await conn.execute(`SELECT COUNT(*) FROM ${table} WHERE ${where}`)).rows[0][0]);
  await conn.execute(`CREATE TABLE ${table} (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v VARCHAR2(20), amt NUMBER(12,2), d DATE, ts TIMESTAMP WITH TIME ZONE)`);
  await conn.execute(`INSERT INTO ${table} (v, amt) VALUES ('a', 1.5)`);
  await conn.execute(`INSERT INTO ${table} (v, amt) VALUES ('b', 2)`);
  await conn.execute(`INSERT INTO ${table} (v, amt) VALUES ('c', 3.25)`);
  await conn.commit();

  try {
    await t.test('同一交易讀得到寫入（讀回新的流水號），decimal 精確、datetime 帶時區', async () => {
      const data = await run({
        statements: [
          { id: 'ins', sql: `INSERT INTO ${table} (v, amt, d, ts) VALUES (:v, :amt, :d, :ts)`, params: { v: 'd', amt: { type: 'decimal', value: '1234567890.12' }, d: { type: 'date', value: '2026-02-28' }, ts: { type: 'datetime', value: '2026-11-19T09:30:00+08:00' } } },
          { id: 'q', sql: `SELECT MAX(id) AS id, MAX(amt) AS amt FROM ${table}` },
          { id: 'row', sql: `SELECT v, amt, d, ts FROM ${table} WHERE v = 'd'` },
        ],
      });
      assert.ok(data.committed, data.error);
      assert.equal(data.statements[1].results[0].rows[0][0], 4);
      assert.equal(data.statements[1].results[0].rows[0][1], '1234567890.12');
      const [v, amt, d, ts] = data.statements[2].results[0].rows[0];
      assert.equal(v, 'd');
      assert.equal(amt, '1234567890.12');
      assert.match(d, /^2026-02-28T00:00:00[+-]\d{2}:\d{2}$/);
      assert.equal(new Date(ts).toISOString(), '2026-11-19T01:30:00.000Z');
    });

    await t.test('超過 maxAffectedRows：回復，而且不回傳查詢結果', async () => {
      const data = await run({ statements: [{ id: 'up', sql: `UPDATE ${table} SET v = 'z'`, expect: { maxAffectedRows: 2 } }, { id: 'q', sql: `SELECT * FROM ${table}` }] });
      assert.ok(!data.committed && /超過上限/.test(data.error));
      assert.ok(!data.statements.some((s) => s.results));
      assert.equal(await count("v = 'z'"), 0);
    });

    await t.test('試跑：執行後 ROLLBACK，影響筆數照算', async () => {
      const data = await run({ statements: [{ id: 'up', sql: `UPDATE ${table} SET amt = amt + 1 WHERE v IN (:a, :b)`, params: { a: 'a', b: 'b' } }] }, { dryRun: true });
      assert.ok(data.dryRun && !data.committed && data.totalAffectedRows === 2);
      assert.equal(await count('amt = 2.5'), 0);
    });

    await t.test('maxRows 截斷；rows 逐筆執行', async () => {
      const q = await run({ statements: [{ id: 'q', sql: `SELECT * FROM ${table} ORDER BY id`, maxRows: 2 }] });
      const res = q.statements[0].results[0];
      assert.ok(res.rowCount === 2 && res.truncated);
      const rows = await run({ statements: [{ id: 'u', sql: `UPDATE ${table} SET amt = :amt WHERE v = :v`, rows: [{ v: 'a', amt: { type: 'decimal', value: '10' } }, { v: 'b', amt: { type: 'decimal', value: '20' } }, { v: 'nope', amt: 1 }] }] });
      assert.deepEqual(rows.statements[0].affectedRows, [1, 1, 0]);
    });

    await t.test('transaction statement：失敗的語句回復，前面的已提交', async () => {
      const data = await run({ transaction: 'statement', statements: [{ id: 'ok', sql: `UPDATE ${table} SET v = 'A' WHERE v = 'a'` }, { id: 'bad', sql: `UPDATE ${table} SET amt = 'not a number' WHERE v = 'b'` }] });
      assert.ok(!data.committed && /前 1 個語句已各自提交/.test(data.error), data.error);
      assert.equal(await count("v = 'A'"), 1);
    });

    await t.test('參數名稱是保留字（:date、:level）也能綁定', async () => {
      const data = await run({ statements: [{ id: 'q', sql: `SELECT COUNT(*) AS n FROM ${table} WHERE d = :date OR :level = 1`, params: { date: { type: 'date', value: '2026-02-28' }, level: 0 } }] });
      assert.equal(data.statements[0].results[0].rows[0][0], 1, data.error);
    });
  } finally {
    await conn.execute(`DROP TABLE ${table} PURGE`).catch(() => {});
    await conn.close();
  }
});
