'use strict';
/**
 * 接收 tooldock.sql（ToolDock 1.4.0 的資料交換，docs/EXCHANGE.md〈6.8〉）：
 *  1. 預覽並確認   2. 不接受帳號密碼（使用者選連線設定）   3. 語句分類（DDL、其他一律拒絕）
 *  4. 試跑（執行後 ROLLBACK）   5. 防止重複匯入   6. 稽核紀錄   7. 參數綁定
 *
 * 每次試跑 / 執行都另外開一條專用連線，跑完就關閉，不會動到畫面上正在使用的連線與它未提交的交易。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const oracledb = require('oracledb');
const { analyze, checkPrompts, contextValues, promptKey } = require('./sql-exchange');
const { execute } = require('./exchange-exec');

const MAX_AUDIT = 200;
const MAX_IMPORTED = 2000;

/**
 * @param {any} ctx ExtensionContext
 * @param {{ profiles: () => any[], connectString: (p: any) => string, savedPassword: (id: string) => Promise<string | null>, savedPasswordIds: () => string[] }} deps
 */
function setup(ctx, deps) {
  /** @type {Map<string, any>} key → 匯入項目（記憶體中；擴充停止時，進行中的匯入回報取消） */
  const imports = new Map();

  const settings = () => ({
    maxRowsDefault: Math.max(1, Number(ctx.settings.get('oracleSql.exchangeMaxRows', 10000)) || 10000),
    maxRowsCap: 100000,
  });

  const changed = (key) => ctx.ui.emit('exchange.changed', { key });

  /* ───────── 稽核與重複匯入 ───────── */

  const auditFile = () => path.join(ctx.paths.data, 'exchange-audit.jsonl');

  /** 至少記錄：時間、id、title、source、實際連線名稱、每個語句的影響筆數、結果（〈6.8〉第 6 點） */
  function audit(item, { profile = null, data = null, result, message = '' }) {
    const entry = {
      at: new Date().toISOString(),
      id: item.pkg.id,
      title: item.pkg.title,
      source: item.pkg.source,
      origin: item.info.origin,
      ...(item.info.filePath ? { filePath: item.info.filePath } : {}),
      connection: profile ? `${profile.name}（${profile.user}@${deps.connectString(profile)}）` : null,
      statements: data ? data.statements.map((s) => ({ id: s.id, ...(s.affectedRows ? { affectedRows: s.affectedRows } : {}) })) : [],
      committed: data ? data.committed : false,
      result,
      message,
    };
    try {
      fs.mkdirSync(ctx.paths.data, { recursive: true });
      fs.appendFileSync(auditFile(), `${JSON.stringify(entry)}\n`);
    } catch (err) {
      ctx.log.error(`無法寫入稽核紀錄：${err.message}`);
    }
    return entry;
  }

  function readAudit(limit = MAX_AUDIT) {
    try {
      return fs.readFileSync(auditFile(), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  const importedIds = () => ctx.storage.get('exchangeImported', {});
  function markImported(pkg) {
    const all = importedIds();
    all[pkg.id] = { at: Date.now(), title: pkg.title };
    const keys = Object.keys(all);
    if (keys.length > MAX_IMPORTED) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX_IMPORTED).forEach((k) => delete all[k]);
    ctx.storage.set('exchangeImported', all);
  }

  /** 記住「source.extId + target.name」對應的連線設定，下次預先選好（〈6.6〉） */
  const targetKey = (pkg, target) => `${(pkg.source && pkg.source.extId) || ''}\u0001${target ? target.name : ''}`;

  /* ───────── 分析 ───────── */

  /** 共用的 tooldock.sql 分析，再加上 Oracle 的限制 */
  function analyzeForOracle(payload) {
    const a = analyze(payload, { allowDDL: false, allowOther: false });
    const DDL_REASON = 'Oracle 的 DDL 會隱含提交、無法回復，交換包一律不執行 DDL';
    const otherReason = (kw) => `「${kw || '無法判斷'}」不是查詢或 DML：Oracle SQL 工具不執行交換包中的 PL/SQL 區塊、CALL、GRANT 等語句`;
    for (const s of a.statements) {
      if (s.category === 'ddl' && !s.allowed) s.reason = DDL_REASON;
      if (s.category === 'other' && !s.allowed) s.reason = otherReason(s.keyword);
      if (s.category === 'dml' && s.returnsRows) {
        s.allowed = false;
        s.returnsRows = false;
        s.reason = 'Oracle 的 RETURNING … INTO 需要輸出參數，交換包 v1 不支援；請在同一個交易中用查詢讀回';
        a.errors.push(`${s.label}不允許執行：${s.reason}`);
      }
    }
    a.hasQuery = a.statements.some((s) => s.returnsRows);
    // 把通用的拒絕原因（提到接收端設定）換成 Oracle 的說明：這個工具沒有開放 DDL / 其他語句的設定
    a.errors = a.errors.map((e) => {
      if (/不允許執行：DDL (預設拒絕|需要交換包)/.test(e)) return e.replace(/不允許執行：.*$/, `不允許執行：${DDL_REASON}`);
      const m = /不允許執行：「(.*?)」屬於其他類別/.exec(e);
      return m ? e.replace(/不允許執行：.*$/, `不允許執行：${otherReason(m[1] === '無法判斷' ? null : m[1])}`) : e;
    });
    if (a.dialect && !['oracle', 'generic'].includes(a.dialect)) {
      a.warnings.unshift(`交換包的方言是「${a.dialect}」，實際連線是 Oracle：語法或函式可能不相容，請先試跑確認`);
    }
    return a;
  }

  /* ───────── 匯入項目 ───────── */

  function summary(item) {
    return {
      key: item.key,
      title: item.pkg.title,
      status: item.status,
      origin: item.info.origin,
      receivedAt: item.receivedAt,
      queryOnly: item.analysis.queryOnly,
    };
  }

  function display(tv) {
    if (!tv) return '';
    if (tv.value === null || tv.value === undefined) return 'NULL';
    if (tv.type === 'json') return JSON.stringify(tv.value);
    return String(tv.value);
  }

  function paramView(name, def, scope) {
    const base = { name, scope, from: def.from, type: def.type };
    if (def.from === 'value') return { ...base, value: display(def) };
    if (def.from === 'context') return { ...base, key: def.key };
    return { ...base, key: promptKey({ name, scope }), label: def.label, required: def.required, default: def.default, options: def.options, description: def.description };
  }

  /** 預覽需要的全部資訊（〈6.8〉第 1 點） */
  function detail(item) {
    const { pkg, info, analysis } = item;
    const list = deps.profiles();
    const saved = new Set(deps.savedPasswordIds());
    const remembered = ctx.storage.get('exchangeTargets', {})[targetKey(pkg, analysis.target)];
    const defaultConnection = list.some((p) => p.id === remembered) ? remembered : list.length === 1 ? list[0].id : null;
    const producer = info.origin === 'share' ? (info.producer ? info.producer.name : (pkg.source && pkg.source.extId) || '產生端') : null;
    const dup = importedIds()[pkg.id];
    return {
      key: item.key,
      status: item.status,
      pkg: {
        id: pkg.id, type: pkg.type, typeVersion: pkg.typeVersion, title: pkg.title, description: pkg.description || '',
        source: pkg.source, createdAt: pkg.createdAt,
      },
      origin: info.origin,
      filePath: info.filePath || null,
      producer,
      dialect: analysis.dialect,
      target: analysis.target,
      transaction: analysis.transaction,
      expect: analysis.expect,
      options: analysis.options,
      errors: analysis.errors,
      warnings: analysis.warnings,
      queryOnly: analysis.queryOnly,
      hasQuery: analysis.hasQuery,
      needsDryRun: analysis.hasDML && analysis.transaction !== 'none',
      // 只比對收到這一包之前的紀錄：剛執行完的這一包不算重複
      duplicate: dup && dup.at < item.receivedAt ? dup : null,
      params: Object.entries(analysis.params).map(([n, d]) => paramView(n, d, null)),
      statements: analysis.statements.map((s) => ({
        index: s.index,
        id: s.id,
        label: s.label,
        sql: s.sql,
        category: s.category,
        keyword: s.keyword,
        returnsRows: s.returnsRows,
        allowed: s.allowed,
        reason: s.reason,
        names: s.names,
        params: Object.entries(s.params).map(([n, d]) => paramView(n, d, s.index)),
        rowsCount: s.rowsCount,
        rows: s.rows ? s.rows.slice(0, 500).map((r) => s.names.map((n) => (n in r ? display(r[n]) : '（共用參數）'))) : null,
        maxRows: s.maxRows,
        expect: s.expect,
      })),
      connections: list.map((p) => ({
        id: p.id, name: p.name, label: `${p.user}@${deps.connectString(p)}`,
        // 沒有記住密碼、這次匯入也還沒輸入過：畫面要請使用者輸入
        needsPassword: (!saved.has(p.id) || item.askPassword.has(p.id)) && !item.passwords.has(p.id),
      })),
      defaultConnection,
      maxRowsDefault: settings().maxRowsDefault,
      running: item.running ? item.running.kind : null,
      dry: item.dry ? { fingerprint: item.dry.fingerprint, data: item.dry.data } : null,
      result: item.result || null,
      message: item.message || '',
    };
  }

  function getItem(key) {
    const item = imports.get(key);
    if (!item) throw new Error('找不到這個匯入（可能已經完成或取消）');
    return item;
  }

  function finish(item, result) {
    if (item.status !== 'pending') return;
    item.status = result.status;
    item.message = result.message || '';
    item.resolve(result);
    changed(item.key);
  }

  const safeUser = () => { try { return os.userInfo().username; } catch { return ''; } };
  const fingerprint = (connectionId, prompts) => JSON.stringify([connectionId || null, prompts || {}]);

  function profileOf(id) {
    const p = deps.profiles().find((x) => x.id === id);
    if (!p) throw new Error('請選擇目標連線');
    return p;
  }

  function preflight(item, { connectionId, prompts }) {
    if (item.status !== 'pending') throw new Error('這個匯入已經結束');
    if (item.running) throw new Error('正在執行中，請稍候');
    if (item.analysis.errors.length) throw new Error(`交換包有錯誤，無法執行：${item.analysis.errors[0]}`);
    const errs = checkPrompts(item.analysis, prompts || {});
    if (errs.length) throw new Error(errs[0]);
    profileOf(connectionId);
  }

  /** 本機時區，例如 +08:00：讓 DATE 與 TIMESTAMP WITH TIME ZONE 的轉換和使用者看到的時間一致 */
  function localOffset() {
    const off = -new Date().getTimezoneOffset();
    const p = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
    return `${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
  }

  /** 開一條專用連線：密碼依序取用這次輸入的、記住的 */
  async function openConnection(item, profile, password) {
    let pw = password != null && password !== '' ? String(password) : item.passwords.get(profile.id);
    if (pw == null && !item.askPassword.has(profile.id)) pw = await deps.savedPassword(profile.id);
    if (pw == null) {
      throw Object.assign(new Error(`請輸入「${profile.name}」的密碼`), { code: 'NEED_PASSWORD' });
    }
    let conn;
    try {
      conn = await oracledb.getConnection({ user: profile.user, password: pw, connectString: deps.connectString(profile) });
    } catch (err) {
      if (err.errorNum === 1017) {
        item.passwords.delete(profile.id);
        item.askPassword.add(profile.id); // 記住的密碼也失效了：這次匯入改成請使用者輸入
        throw Object.assign(new Error(`「${profile.name}」的帳號或密碼錯誤，請重新輸入`), { code: 'NEED_PASSWORD' });
      }
      throw err;
    }
    item.passwords.set(profile.id, pw); // 只留在記憶體，這個匯入結束就丟掉
    conn.callTimeout = Math.max(1, Number(ctx.settings.get('oracleSql.callTimeoutSeconds', 60))) * 1000;
    await conn.execute(`ALTER SESSION SET TIME_ZONE = '${localOffset()}' NLS_NUMERIC_CHARACTERS = '.,'`);
    return conn;
  }

  async function runOn(item, input, dryRun) {
    const profile = profileOf(input.connectionId);
    item.running = { kind: dryRun ? 'dry' : 'exec', conn: null };
    changed(item.key);
    let conn = null;
    try {
      conn = await openConnection(item, profile, input.password);
      item.running.conn = conn;
      const st = settings();
      const data = await execute(conn, item.analysis, {
        prompts: input.prompts || {},
        context: contextValues(item.pkg, new Date(), safeUser()),
        dryRun,
        maxRowsDefault: st.maxRowsDefault,
        maxRowsCap: st.maxRowsCap,
      });
      return { profile, data };
    } finally {
      item.running = null;
      if (conn) await conn.close().catch(() => {}); // 沒有提交的部分會由 Oracle 回復
      changed(item.key);
    }
  }

  /** 從檔案匯入時沒有產生端：結果只顯示在這裡，不放進 ImportResult（〈6.10〉） */
  const withoutResults = (data) => ({ ...data, statements: data.statements.map(({ results, ...rest }) => rest) });

  /* ───────── 接收端 handler ───────── */

  /** contributes.exchange.imports[].handler：等使用者在畫面確認或拒絕後才回傳 */
  function importSql(pkg, info) {
    const analysis = analyzeForOracle(pkg.payload);
    const key = crypto.randomUUID();
    return new Promise((resolve) => {
      const item = { key, pkg, info, analysis, status: 'pending', receivedAt: Date.now(), resolve, dry: null, result: null, running: null, passwords: new Map(), askPassword: new Set() };
      imports.set(key, item);
      info.onCancel(() => {
        if (item.status !== 'pending') return;
        if (item.running && item.running.conn) item.running.conn.break().catch(() => {});
        audit(item, { result: 'cancelled', message: '在工作台取消' });
        finish(item, { status: 'cancelled', message: '已在工作台取消' });
      });
      changed(key);
      ctx.log.info(`收到交換包「${pkg.title}」（${pkg.id}，${info.origin === 'file' ? `檔案 ${info.filePath}` : `來自 ${info.producer ? info.producer.name : '其他擴充'}`}）`);
    });
  }

  /* ───────── 畫面方法 ───────── */

  ctx.ui.handle('exchange.list', () => [...imports.values()].sort((a, b) => b.receivedAt - a.receivedAt).map(summary));
  ctx.ui.handle('exchange.detail', (key) => detail(getItem(key)));

  ctx.ui.handle('exchange.dryRun', async (key, input) => {
    const item = getItem(key);
    preflight(item, input);
    const { data } = await runOn(item, input, true);
    item.dry = { fingerprint: fingerprint(input.connectionId, input.prompts), data };
    changed(key);
    return detail(item);
  });

  ctx.ui.handle('exchange.execute', async (key, input) => {
    const item = getItem(key);
    preflight(item, input);
    const d = detail(item);
    if (d.duplicate && !input.confirmDuplicate) throw new Error('這個交換包已經匯入過，請勾選「仍要再次執行」');
    if (d.needsDryRun) {
      if (!item.dry || item.dry.fingerprint !== fingerprint(input.connectionId, input.prompts)) throw new Error('請先用目前的連線與參數試跑');
      if (item.dry.data.error) throw new Error(`試跑失敗，無法執行：${item.dry.data.error}`);
    }
    const { profile, data } = await runOn(item, input, false);
    if (item.status !== 'pending') return detail(item); // 執行中被取消
    const targets = ctx.storage.get('exchangeTargets', {});
    targets[targetKey(item.pkg, item.analysis.target)] = profile.id;
    ctx.storage.set('exchangeTargets', targets);
    const ok = data.committed && !data.error;
    if (ok) markImported(item.pkg);
    item.result = data;
    const message = ok ? `已在「${profile.name}」執行${data.totalAffectedRows ? `，影響 ${data.totalAffectedRows} 筆` : ''}` : data.error;
    audit(item, { profile, data, result: ok ? 'imported' : 'failed', message });
    ctx.log.info(`「${item.pkg.title}」${ok ? '執行完成' : '執行失敗'}：${message}`);
    item.passwords.clear();
    finish(item, {
      status: ok ? 'imported' : 'rejected',
      message,
      data: item.info.origin === 'file' ? withoutResults(data) : data,
    });
    return detail(item);
  });

  ctx.ui.handle('exchange.reject', (key) => {
    const item = getItem(key);
    if (item.status !== 'pending') return true;
    if (item.running && item.running.conn) item.running.conn.break().catch(() => {});
    audit(item, { result: 'rejected', message: '使用者拒絕執行' });
    item.passwords.clear();
    finish(item, { status: 'rejected', message: '使用者拒絕執行' });
    return true;
  });

  ctx.ui.handle('exchange.dismiss', (key) => {
    const item = getItem(key);
    if (item.status === 'pending') throw new Error('請先執行或拒絕');
    imports.delete(key);
    changed(null);
    return true;
  });

  ctx.ui.handle('exchange.audit', () => readAudit());

  /** 把查詢結果用 tooldock.table 分享出去（〈6.10〉結果的去向） */
  ctx.ui.handle('exchange.shareResult', async (key, statementIndex, resultIndex) => {
    if (!ctx.exchange) throw new Error('需要 ToolDock 1.4.0 以上');
    const item = getItem(key);
    const st = item.result && item.result.statements[statementIndex];
    const r = st && st.results && st.results[resultIndex || 0];
    if (!r) throw new Error('找不到查詢結果');
    const many = st.results.length > 1 ? `（第 ${resultIndex + 1} 次）` : '';
    const pkg = ctx.exchange.create('tooldock.table', { columns: r.columns, rows: r.rows }, {
      title: `${item.pkg.title}：${st.id} 查詢結果${many}`.slice(0, 200),
      description: `由 Oracle SQL 工具執行「${item.pkg.title}」的查詢結果，共 ${r.rowCount} 筆${r.truncated ? '（已截斷）' : ''}`,
    });
    return ctx.exchange.share(pkg);
  });

  ctx.ui.handle('exchange.importFile', () => ctx.commands.execute('exchange.importFile'));

  return {
    importSql,
    /** 擴充停止時：還在等待確認的匯入一律回報取消 */
    dispose() {
      for (const item of imports.values()) finish(item, { status: 'cancelled', message: 'Oracle SQL 工具已停止' });
    },
  };
}

module.exports = { setup };
