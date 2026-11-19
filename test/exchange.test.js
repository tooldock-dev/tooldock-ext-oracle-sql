'use strict';
/**
 * 接收端往返測試：產生端分享 tooldock.sql → Oracle SQL 工具（backend/exchange.js）處理 → 產生端拿到的 ImportResult。
 * 用假的 ctx 呼叫 importSql 與畫面方法（exchange.detail / dryRun / execute / reject / shareResult），不需要啟動 ToolDock。
 *
 * 不需要資料庫：拒絕、取消、擴充停止、不允許的語句、未試跑、缺密碼。
 * 需要資料庫（設定 ORACLE_TEST_CONNECT / ORACLE_TEST_USER / ORACLE_TEST_PASSWORD 時才執行，見 oracle.test.js）：
 * 執行成功的結果、從檔案匯入時不回傳結果、分享查詢結果（tooldock.table，例如交給資料轉換）、執行失敗、重複匯入。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { setup } = require('../backend/exchange');

const { ORACLE_TEST_CONNECT: connectString, ORACLE_TEST_USER: dbUser, ORACLE_TEST_PASSWORD: dbPassword } = process.env;
const noDb = !(connectString && dbUser && dbPassword) && '沒有設定 ORACLE_TEST_CONNECT / ORACLE_TEST_USER / ORACLE_TEST_PASSWORD';

/** 假的 ExtensionContext：只實作 exchange.js 用到的部分 */
function fakeContext({ savedPassword = null } = {}) {
  const handlers = new Map();
  const store = new Map();
  const shared = [];
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-sql-exchange-'));
  const ctx = {
    paths: { data },
    settings: { get: (_k, d) => d },
    storage: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => { store.set(k, v); } },
    log: { info() {}, warn() {}, error() {} },
    ui: { handle: (name, fn) => handlers.set(name, fn), emit() {} },
    commands: { execute: async () => {} },
    exchange: {
      create: (type, payload, meta) => ({ format: 'tooldock.exchange/1', id: crypto.randomUUID(), type, typeVersion: 1, ...meta, payload }),
      // 模擬平台把結果交給資料轉換（tooldock.table 的接收端之一）
      share: async (pkg) => { shared.push(pkg); return { status: 'delivered', receiver: { extId: 'data-converter', name: '資料轉換工具' }, result: { status: 'imported' } }; },
    },
  };
  const profile = { id: 'p1', name: '測試連線', user: dbUser || 'nobody', host: '', port: 1521, serviceName: '', connectString: connectString || 'localhost:1/none' };
  const api = setup(ctx, {
    profiles: () => [profile],
    connectString: (p) => p.connectString,
    savedPasswordIds: () => (savedPassword ? [profile.id] : []),
    savedPassword: async () => savedPassword,
  });
  const call = (name, ...args) => handlers.get(name)(...args);
  return { ctx, api, call, shared, data, cleanup: () => fs.rmSync(data, { recursive: true, force: true }) };
}

/** 假的 ImportInfo（平台在 host-runtime 建立的物件） */
function fakeInfo(origin = 'share') {
  const listeners = [];
  return {
    origin,
    ...(origin === 'file' ? { filePath: '/tmp/x.tdx' } : { producer: { extId: 'help', name: '協助工具' } }),
    cancelled: false,
    onCancel(fn) { listeners.push(fn); return { dispose() {} }; },
    cancel() { this.cancelled = true; listeners.forEach((fn) => fn()); },
  };
}

const pkgOf = (payload, title = '測試') => ({ format: 'tooldock.exchange/1', id: crypto.randomUUID(), type: 'tooldock.sql', typeVersion: 1, title, source: { extId: 'help', version: '0.2.0' }, payload });
const queryPayload = { dialect: 'oracle', target: { name: '人事資料庫' }, statements: [{ id: 'q', sql: 'SELECT 1 AS n FROM dual' }] };

/** 送出交換包，回傳 { result: Promise<ImportResult>, key } */
async function receive(t, pkg, info = fakeInfo()) {
  const result = t.api.importSql(pkg, info);
  const item = (await t.call('exchange.list')).find((x) => x.status === 'pending' && x.title === pkg.title);
  return { result, key: item.key, info };
}

/** 稽核紀錄，最新的在前（與畫面相同） */
const audit = (t) => fs.readFileSync(path.join(t.data, 'exchange-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).reverse();

test('拒絕：產生端收到 rejected，稽核有紀錄', async () => {
  const t = fakeContext();
  try {
    const { result, key } = await receive(t, pkgOf(queryPayload, '拒絕測試'));
    assert.equal((await t.call('exchange.detail', key)).status, 'pending');
    await t.call('exchange.reject', key);
    assert.deepEqual(await result, { status: 'rejected', message: '使用者拒絕執行' });
    assert.equal(audit(t)[0].result, 'rejected');
  } finally { t.cleanup(); }
});

test('在工作台取消：產生端收到 cancelled；擴充停止時也回報 cancelled', async () => {
  const t = fakeContext();
  try {
    const a = await receive(t, pkgOf(queryPayload, '取消測試'));
    a.info.cancel();
    assert.equal((await a.result).status, 'cancelled');
    assert.equal((await t.call('exchange.detail', a.key)).status, 'cancelled');
    const b = t.api.importSql(pkgOf(queryPayload, '停止測試'), fakeInfo());
    t.api.dispose();
    assert.deepEqual(await b, { status: 'cancelled', message: 'Oracle SQL 工具已停止' });
  } finally { t.cleanup(); }
});

test('不允許的語句：預覽列出原因，無法試跑或執行', async () => {
  const t = fakeContext({ savedPassword: 'x' });
  try {
    const { result, key } = await receive(t, pkgOf({ dialect: 'mssql', target: { name: 'x' }, options: { allowDDL: true }, statements: [{ sql: 'DROP TABLE t' }, { sql: 'BEGIN NULL; END;' }] }));
    const d = await t.call('exchange.detail', key);
    assert.ok(d.errors.some((e) => /DDL 會隱含提交/.test(e)), d.errors.join());
    assert.ok(d.errors.some((e) => /PL\/SQL/.test(e)), d.errors.join());
    assert.ok(d.warnings.some((w) => /mssql/.test(w)));
    await assert.rejects(t.call('exchange.dryRun', key, { connectionId: 'p1', prompts: {} }), /交換包有錯誤/);
    await t.call('exchange.reject', key);
    assert.equal((await result).status, 'rejected');
  } finally { t.cleanup(); }
});

test('含寫入時未試跑不能執行；沒有記住密碼時要求輸入', async () => {
  const t = fakeContext();
  try {
    const { result, key } = await receive(t, pkgOf({ dialect: 'oracle', target: { name: 'x' }, statements: [{ sql: 'UPDATE t SET a = 1' }] }));
    const d = await t.call('exchange.detail', key);
    assert.ok(d.needsDryRun && d.connections[0].needsPassword);
    await assert.rejects(t.call('exchange.execute', key, { connectionId: 'p1', prompts: {} }), /請先用目前的連線與參數試跑/);
    await assert.rejects(t.call('exchange.dryRun', key, { connectionId: 'p1', prompts: {} }), /請輸入「測試連線」的密碼/);
    await t.call('exchange.reject', key);
    await result;
  } finally { t.cleanup(); }
});

test('連到 Oracle 的往返', { skip: noDb }, async (tt) => {
  const oracledb = require('oracledb');
  const table = `TDX_X_${Date.now().toString(36).toUpperCase()}`;
  const admin = await oracledb.getConnection({ user: dbUser, password: dbPassword, connectString });
  await admin.execute(`CREATE TABLE ${table} (emp_no VARCHAR2(10) PRIMARY KEY, name NVARCHAR2(20), hours NUMBER(6,2), note VARCHAR2(40))`);
  await admin.execute(`INSERT INTO ${table} VALUES ('A001', N'王小明', 0, 'a, b')`);
  await admin.execute(`INSERT INTO ${table} VALUES ('A002', N'李小華', 0, NULL)`);
  await admin.commit();
  const input = { connectionId: 'p1', prompts: { approver: '王主管' }, password: dbPassword };
  const payload = {
    dialect: 'oracle', target: { name: '人事資料庫' },
    params: { approver: { type: 'string', from: 'prompt', label: '核准人', required: true } },
    statements: [
      { id: 'up', sql: `UPDATE ${table} SET hours = :h, note = :approver WHERE emp_no = :e`, rows: [{ e: 'A001', h: { type: 'decimal', value: '12.5' } }, { e: 'A002', h: { type: 'decimal', value: '8' } }], expect: { maxAffectedRows: 2 } },
      { id: 'check', sql: `SELECT emp_no, name, hours, note FROM ${table} ORDER BY emp_no` },
    ],
  };

  try {
    await tt.test('分享：試跑 → 執行 → 產生端拿到 imported 與查詢結果', async () => {
      const t = fakeContext();
      try {
        const { result, key } = await receive(t, pkgOf(payload, '補登'));
        const dry = await t.call('exchange.dryRun', key, input);
        assert.ok(dry.dry.data.dryRun && dry.dry.data.totalAffectedRows === 2 && !dry.dry.data.error);
        // 試跑後連線密碼已記在這次匯入裡，之後不用再送
        await t.call('exchange.execute', key, { ...input, password: '' });
        const r = await result;
        assert.equal(r.status, 'imported');
        assert.match(r.message, /影響 2 筆/);
        assert.equal(r.data.committed, true);
        assert.deepEqual(r.data.statements[0].affectedRows, [1, 1]);
        const res = r.data.statements[1].results[0];
        assert.deepEqual(res.columns.map((c) => `${c.name}:${c.type}`), ['EMP_NO:string', 'NAME:string', 'HOURS:decimal', 'NOTE:string']);
        assert.deepEqual(res.rows, [['A001', '王小明', '12.5', '王主管'], ['A002', '李小華', '8', '王主管']]);
        assert.equal(audit(t)[0].result, 'imported');
      } finally { t.cleanup(); }
    });

    await tt.test('從檔案匯入：結果不放進 ImportResult；分享結果時送出 tooldock.table（例如交給資料轉換）', async () => {
      const t = fakeContext();
      try {
        const { result, key } = await receive(t, pkgOf(payload, '從檔案'), fakeInfo('file'));
        await t.call('exchange.dryRun', key, input);
        const d = await t.call('exchange.execute', key, input);
        const r = await result;
        assert.equal(r.status, 'imported');
        assert.ok(!r.data.statements.some((s) => s.results), 'ImportResult 不應含查詢結果');
        assert.equal(d.result.statements[1].results[0].rows.length, 2, '接收端畫面要有查詢結果');
        const shareResult = await t.call('exchange.shareResult', key, 1, 0);
        assert.equal(shareResult.receiver.extId, 'data-converter');
        const [pkg] = t.shared;
        assert.equal(pkg.type, 'tooldock.table');
        assert.match(pkg.title, /從檔案：check 查詢結果/);
        // tooldock.table v1：每一列的長度等於欄位數，值依〈6.4〉（decimal 是字串）
        assert.deepEqual(pkg.payload.columns.map((c) => c.name), ['EMP_NO', 'NAME', 'HOURS', 'NOTE']);
        assert.ok(pkg.payload.rows.every((row) => row.length === pkg.payload.columns.length));
        assert.deepEqual(pkg.payload.rows[0], ['A001', '王小明', '12.5', '王主管']);
      } finally { t.cleanup(); }
    });

    await tt.test('執行失敗：產生端拿到 rejected、committed = false、錯誤訊息，沒有查詢結果', async () => {
      const t = fakeContext();
      try {
        const bad = { dialect: 'oracle', target: { name: 'x' }, transaction: 'all', statements: [{ id: 'ok', sql: `UPDATE ${table} SET hours = 1 WHERE emp_no = 'A001'` }, { id: 'boom', sql: `UPDATE ${table} SET hours = 'x' WHERE emp_no = 'A002'` }, { id: 'q', sql: `SELECT * FROM ${table}` }] };
        const { result, key } = await receive(t, pkgOf(bad, '會失敗'));
        // 試跑失敗就不能執行；改成不需要試跑的 none 模式才能看到正式執行失敗的回覆
        const dry = await t.call('exchange.dryRun', key, input);
        assert.match(dry.dry.data.error, /boom.*執行失敗.*已回復/);
        await assert.rejects(t.call('exchange.execute', key, input), /試跑失敗/);
        await t.call('exchange.reject', key);
        await result;

        const none = await receive(t, pkgOf({ ...bad, transaction: 'none' }, '不使用交易'));
        await t.call('exchange.execute', none.key, input);
        const r = await none.result;
        assert.equal(r.status, 'rejected');
        assert.equal(r.data.committed, false);
        assert.equal(r.data.failedStatement, 'boom');
        assert.match(r.message, /未使用交易，已執行的部分不會回復/);
        assert.ok(!r.data.statements.some((s) => s.results));
        assert.equal(audit(t)[0].result, 'failed');
      } finally { t.cleanup(); }
    });

    await tt.test('同一個交換包再次匯入：要勾選確認才能執行', async () => {
      const t = fakeContext();
      try {
        const pkg = pkgOf({ dialect: 'oracle', target: { name: 'x' }, statements: [{ sql: `SELECT COUNT(*) AS n FROM ${table}` }] }, '重複');
        const first = await receive(t, pkg);
        await t.call('exchange.execute', first.key, input);
        assert.equal((await first.result).data.statements[0].results[0].rows[0][0], 2);
        await t.call('exchange.dismiss', first.key);
        const second = await receive(t, pkg);
        assert.ok((await t.call('exchange.detail', second.key)).duplicate);
        await assert.rejects(t.call('exchange.execute', second.key, input), /已經匯入過/);
        await t.call('exchange.execute', second.key, { ...input, confirmDuplicate: true });
        assert.equal((await second.result).status, 'imported');
      } finally { t.cleanup(); }
    });
  } finally {
    await admin.execute(`DROP TABLE ${table} PURGE`).catch(() => {});
    await admin.close();
  }
});
