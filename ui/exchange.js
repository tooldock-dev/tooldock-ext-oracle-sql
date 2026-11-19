// @ts-check
/**
 * Oracle SQL 工具：其他工具分享的 SQL（tooldock.sql，ToolDock 1.4.0 的資料交換）
 * 預覽 → 選連線、填參數 → 試跑（執行後 ROLLBACK）→ 確認執行 → 結果傳回產生端。
 * 與 app.js 共用 td、$、msgOf。
 */

/** @typedef {{ connectionId: string, prompts: Record<string, any>, password: string, confirmDuplicate: boolean }} ImportInput */

const xui = {
  /** @type {any[]} */ list: [],
  /** @type {string | null} */ key: null,
  /** @type {any} */ detail: null,
  /** @type {'import' | 'audit' | null} */ view: null,
  busy: false,
  /** @type {Map<string, ImportInput>} 每個匯入各自的輸入（切換時保留） */ inputs: new Map(),
};

const esc = (/** @type {any} */ v) => td.escape(v === null || v === undefined ? '' : String(v));

const CATEGORY = {
  query: { text: '查詢', cls: 'info' },
  dml: { text: 'DML', cls: 'warn' },
  ddl: { text: 'DDL', cls: 'err' },
  other: { text: '其他', cls: 'err' },
};
const STATUS = {
  pending: { text: '待確認', cls: 'warn' },
  imported: { text: '已執行', cls: 'ok' },
  rejected: { text: '未執行', cls: 'err' },
  cancelled: { text: '已取消', cls: '' },
};
const TRANSACTION = {
  all: '全部成功才提交（任何一個語句失敗或超過檢查條件就全部回復）',
  statement: '每個語句各自提交',
  none: '不使用交易：每次執行都直接提交',
};
const FROM = { value: '固定值', prompt: '匯入時填寫', context: '執行時提供' };

/** @param {string} text @param {string} cls */
const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
/** @param {string} cls @param {string} html */
const banner = (cls, html) => `<div class="xbanner ${cls}">${html}</div>`;

/** 確認對話框 @param {string} message @param {string} detail @param {string} ok */
async function ask(message, detail, ok) {
  const r = await td.dialog.message({ type: 'question', message, detail, buttons: [ok, '取消'], defaultId: 0, cancelId: 1 });
  return r.response === 0;
}

/** 與後端相同的寫法：連線 + prompt 值都相同，試跑才算數 @param {ImportInput} inp */
const fingerprint = (inp) => JSON.stringify([inp.connectionId || null, inp.prompts || {}]);

/* ───────── 版面切換 ───────── */

/** @param {boolean} on */
function showImportCol(on) {
  $('#mainCol').hidden = on;
  $('#importCol').hidden = !on;
  if (!on) { xui.view = null; xui.key = null; renderImportList(); }
}

function openImportsTab() {
  const tab = /** @type {HTMLElement} */ ($('#importsTab'));
  if (!tab.classList.contains('on')) tab.click();
}

/* ───────── 側欄清單 ───────── */

async function loadImports() {
  try { xui.list = await td.invoke('exchange.list'); } catch { xui.list = []; }
  renderImportList();
}

function renderImportList() {
  const pending = xui.list.filter((x) => x.status === 'pending').length;
  const count = $('#importCount');
  count.hidden = !pending;
  count.textContent = String(pending);
  const box = $('#importList');
  if (!xui.list.length) {
    box.innerHTML = '<div class="sideEmpty">其他工具分享的 SQL 會出現在這裡，經你預覽、試跑、確認後才會執行。<br><br>也可以開啟 .tdx 交換檔，或把檔案拖進 ToolDock 視窗。</div>';
    return;
  }
  box.innerHTML = xui.list.map((x) => {
    const s = STATUS[/** @type {keyof typeof STATUS} */ (x.status)] || STATUS.pending;
    return `<div class="imp ${x.key === xui.key && xui.view === 'import' ? 'sel' : ''}" data-key="${esc(x.key)}">
      <span>${x.origin === 'file' ? '📄' : '⇄'}</span><span class="t" title="${esc(x.title)}">${esc(x.title)}</span><span class="s ${s.cls}">${esc(s.text)}</span></div>`;
  }).join('');
}

$('#importList').addEventListener('click', (e) => {
  const el = /** @type {HTMLElement} */ (e.target).closest('.imp[data-key]');
  if (el instanceof HTMLElement && el.dataset.key) openImport(el.dataset.key);
});
$('#openTdx').onclick = () => td.invoke('exchange.importFile').catch((err) => td.toast(msgOf(err), 'error'));
$('#showAudit').onclick = () => showAudit();

/* ───────── 預覽 ───────── */

/** @param {string} key */
async function openImport(key) {
  xui.key = key;
  xui.view = 'import';
  openImportsTab();
  showImportCol(true);
  xui.view = 'import';
  xui.key = key;
  renderImportList();
  await refreshDetail();
}

async function refreshDetail() {
  const key = xui.key;
  if (!key) return;
  let detail;
  try {
    detail = await td.invoke('exchange.detail', key);
  } catch (err) {
    if (xui.key !== key) return;
    xui.detail = null;
    $('#importCol').innerHTML = `${backBar()}${banner('err', esc(msgOf(err)))}`;
    bindBack();
    return;
  }
  if (xui.key !== key || xui.view !== 'import') return; // 等待期間已切到別的匯入：不要蓋掉
  xui.detail = detail;
  renderDetail();
}

/** @param {any} d @returns {ImportInput} */
function inputsFor(d) {
  let inp = xui.inputs.get(d.key);
  if (!inp) {
    inp = { connectionId: d.defaultConnection || '', prompts: {}, password: '', confirmDuplicate: false };
    xui.inputs.set(d.key, inp);
  }
  return inp;
}

/** 從畫面讀回輸入（prompt 依宣告順序組成，指紋才會穩定） @param {any} d */
function readInputs(d) {
  const inp = inputsFor(d);
  const sel = /** @type {HTMLSelectElement | null} */ (document.querySelector('#xConn'));
  if (sel) inp.connectionId = sel.value;
  const pw = /** @type {HTMLInputElement | null} */ (document.querySelector('#xPw'));
  inp.password = pw ? pw.value : '';
  const dup = /** @type {HTMLInputElement | null} */ (document.querySelector('#xDup'));
  inp.confirmDuplicate = !!(dup && dup.checked);
  /** @type {Record<string, any>} */
  const prompts = {};
  for (const p of promptsOf(d)) {
    const el = /** @type {HTMLInputElement | null} */ (document.querySelector(`[data-prompt="${CSS.escape(p.key)}"]`));
    if (!el) continue;
    prompts[p.key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  inp.prompts = prompts;
  return inp;
}

/** @param {any} d */
const promptsOf = (d) => [...d.params, ...d.statements.flatMap((/** @type {any} */ s) => s.params)].filter((p) => p.from === 'prompt');

/** @param {any} d @param {ImportInput} inp */
function dryValid(d, inp) {
  return !!(d.dry && d.dry.fingerprint === fingerprint(inp) && !d.dry.data.error);
}

/** 選的連線需要輸入密碼，但還沒填 @param {any} d @param {ImportInput} inp */
function missingPassword(d, inp) {
  const c = d.connections.find((/** @type {any} */ x) => x.id === inp.connectionId);
  return !!(c && c.needsPassword && !inp.password);
}

/** @param {any} d @param {ImportInput} inp */
function canExecute(d, inp) {
  if (xui.busy || d.running || d.status !== 'pending' || d.errors.length || !inp.connectionId || missingPassword(d, inp)) return false;
  if (d.duplicate && !inp.confirmDuplicate) return false;
  if (d.needsDryRun && !dryValid(d, inp)) return false;
  return true;
}

/** 輸入參數時只更新按鈕與提示，不整頁重繪（避免輸入框失去焦點） */
function updateControls() {
  const d = xui.detail;
  if (!d) return;
  const inp = readInputs(d);
  const exec = /** @type {HTMLButtonElement | null} */ (document.querySelector('#xExecBtn'));
  if (exec) exec.disabled = !canExecute(d, inp);
  const dry = /** @type {HTMLButtonElement | null} */ (document.querySelector('#xDryBtn'));
  if (dry) dry.disabled = xui.busy || !!d.running || d.status !== 'pending' || !!d.errors.length || !inp.connectionId || missingPassword(d, inp);
  const hint = document.querySelector('#xHint');
  if (hint) {
    hint.textContent = d.status !== 'pending' ? ''
      : !inp.connectionId ? '請選擇要執行的連線'
        : missingPassword(d, inp) ? '這組連線沒有記住密碼，請輸入密碼'
        : d.needsDryRun && !dryValid(d, inp) ? (d.dry && d.dry.data.error && d.dry.fingerprint === fingerprint(inp) ? '試跑失敗，修正後才能執行' : '含有寫入的語句，請先用目前的連線與參數試跑')
          : d.duplicate && !inp.confirmDuplicate ? '這個交換包已經匯入過，請勾選「仍要再次執行」' : '';
  }
  const stale = document.querySelector('#xDryStale');
  if (stale) /** @type {HTMLElement} */ (stale).hidden = !d.dry || d.dry.fingerprint === fingerprint(inp);
  const pwRow = /** @type {HTMLElement | null} */ (document.querySelector('#xPwRow'));
  if (pwRow) {
    const c = d.connections.find((/** @type {any} */ x) => x.id === inp.connectionId);
    pwRow.hidden = !(c && c.needsPassword);
  }
}

const backBar = () => '<div class="row" style="margin-bottom:10px"><button class="ghost" id="xBack">← 回到 SQL 編輯器</button></div>';
function bindBack() {
  const b = document.querySelector('#xBack');
  if (b) /** @type {HTMLElement} */ (b).onclick = () => showImportCol(false);
}

/** @param {any} p 參數 */
function paramValueCell(p) {
  if (p.from === 'value') return `<code>${esc(p.value)}</code>`;
  if (p.from === 'context') return `<span class="muted">${esc(p.key)}（執行時提供）</span>`;
  const d = xui.detail;
  const inp = inputsFor(d);
  const cur = p.key in inp.prompts ? inp.prompts[p.key] : p.default;
  const attrs = `data-prompt="${esc(p.key)}" ${d.status !== 'pending' ? 'disabled' : ''}`;
  if (p.options) {
    return `<select ${attrs}>${p.required ? '' : '<option value=""></option>'}${p.options.map((/** @type {any} */ o) => `<option value="${esc(o.value)}" ${String(o.value) === String(cur ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  }
  if (p.type === 'bool') return `<input type="checkbox" ${attrs} ${cur ? 'checked' : ''}>`;
  const type = p.type === 'date' ? 'date' : p.type === 'datetime' ? 'datetime-local' : p.type === 'time' ? 'time' : 'text';
  const val = p.type === 'datetime' && typeof cur === 'string' ? cur.slice(0, 16) : cur ?? '';
  return `<input type="${type}" ${attrs} value="${esc(val)}" placeholder="${esc(p.label)}${p.required ? '（必填）' : ''}">`;
}

/** @param {any[]} params @param {string} [title] */
function paramsTable(params, title) {
  if (!params.length) return '';
  return `${title ? `<div class="muted-sm" style="margin:6px 0 4px">${esc(title)}</div>` : ''}
    <table class="grid params"><thead><tr><th>參數</th><th>型別</th><th>來源</th><th>值</th></tr></thead><tbody>
    ${params.map((p) => `<tr><td><code>:${esc(p.name)}</code></td><td>${esc(p.type)}</td><td>${esc(FROM[/** @type {keyof typeof FROM} */ (p.from)] || p.from)}</td>
      <td>${p.from === 'prompt' ? `<div class="muted-sm">${esc(p.label)}${p.required ? ' *' : ''}${p.description ? `：${esc(p.description)}` : ''}</div>` : ''}${paramValueCell(p)}</td></tr>`).join('')}
    </tbody></table>`;
}

/** @param {any} r 一次執行的結果（〈6.10〉） @param {boolean} dry */
function resultTable(r, dry) {
  const head = `<tr>${r.columns.map((/** @type {any} */ c) => `<th>${esc(c.name)}<span class="faint" style="font-weight:normal;font-size:10px;margin-left:4px">${esc(c.type)}</span></th>`).join('')}</tr>`;
  const body = r.rows.map((/** @type {any[]} */ row) => `<tr>${row.map((v) => (v === null ? '<td class="null">NULL</td>' : `<td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td>`)).join('')}</tr>`).join('');
  return `<div class="muted-sm">${r.rowCount} 筆${r.truncated ? '（已截斷）' : ''}${dry ? '，試跑只顯示前幾筆' : ''}</div>
    <div class="xtbl"><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** @param {any} d @param {any} data @param {boolean} dry */
function resultBlock(d, data, dry) {
  const head = data.error
    ? banner('err', `${dry ? '試跑失敗' : '執行失敗'}：${esc(data.error)}`)
    : dry
      ? banner('info', `試跑完成（已 ROLLBACK，資料庫沒有變更）：預計影響 ${data.totalAffectedRows} 筆，耗時 ${data.durationMs} ms`)
      : data.committed
        ? banner('ok', `✔ 已提交：影響 ${data.totalAffectedRows} 筆，耗時 ${data.durationMs} ms`)
        : banner('warn', `未提交：影響 ${data.totalAffectedRows} 筆`);
  const parts = data.statements.map((/** @type {any} */ s, /** @type {number} */ si) => {
    if (!s.affectedRows && !s.results) return '';
    const st = d.statements[si];
    const affected = s.affectedRows ? `<span class="muted-sm">影響 ${s.affectedRows.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0)} 筆${s.affectedRows.length > 1 ? `（${s.affectedRows.join(' + ')}）` : ''}</span>` : '';
    const results = (s.results || []).map((/** @type {any} */ r, /** @type {number} */ ri) => {
      const share = !dry && d.status !== 'pending' && /** @type {any} */ (td).exchange ? `<button class="ghost" data-share="${si}:${ri}">⇄ 分享結果…</button>` : '';
      return `<div class="xres">${s.results.length > 1 ? `<b>第 ${ri + 1} 次</b> ` : ''}${share}${resultTable(r, dry)}</div>`;
    }).join('');
    return `<div class="xres"><b>${esc(st ? st.label : s.id)}</b> ${affected}${results}</div>`;
  }).join('');
  return `<div class="xblock" id="${dry ? 'xDryResult' : 'xExecResult'}"><h3>${dry ? '試跑結果' : '執行結果'}</h3>${head}
    ${dry ? '<div class="xbanner warn" id="xDryStale" hidden>連線或參數已變更，需要重新試跑</div>' : ''}${parts}</div>`;
}

function renderDetail() {
  const d = xui.detail;
  if (!d) return;
  const inp = inputsFor(d);
  const st = STATUS[/** @type {keyof typeof STATUS} */ (d.status)] || STATUS.pending;
  const pending = d.status === 'pending';
  const src = d.pkg.source || {};
  const created = d.pkg.createdAt ? new Date(d.pkg.createdAt).toLocaleString() : '';
  const origin = d.origin === 'file'
    ? `交換檔 ${esc(d.filePath)} · ${esc(src.extId || '?')} v${esc(src.version || '?')}<div class="warn muted-sm">來自檔案，來源資訊可能被修改，請以實際 SQL 為準</div>`
    : `${esc(d.producer)}（${esc(src.extId || '?')} v${esc(src.version || '?')}）`;

  const notices = [];
  if (d.errors.length) notices.push(banner('err', `<b>交換包有錯誤，無法執行</b><ul>${d.errors.map((/** @type {string} */ e) => `<li>${esc(e)}</li>`).join('')}</ul>`));
  if (d.warnings.length) notices.push(banner('warn', `<ul style="margin:0">${d.warnings.map((/** @type {string} */ w) => `<li>${esc(w)}</li>`).join('')}</ul>`));
  if (d.hasQuery) {
    notices.push(d.origin === 'share'
      ? banner('info', `查詢結果會傳回給「<b>${esc(d.producer)}</b>」。`)
      : banner('info', '查詢結果只會顯示在這裡（從檔案匯入沒有產生端），可以再用「分享結果」交給其他工具。'));
  }
  if (d.transaction === 'none' && !d.queryOnly) notices.push(banner('warn', '這個交換包<b>不使用交易</b>：執行到一半失敗時，已執行的部分不會回復，也無法試跑。'));
  if (d.duplicate) {
    notices.push(banner('warn', `這個交換包（${esc(d.pkg.id)}）已在 ${esc(new Date(d.duplicate.at).toLocaleString())} 匯入過。
      ${pending ? `<label class="row" style="gap:6px;margin-top:4px"><input type="checkbox" id="xDup" ${inp.confirmDuplicate ? 'checked' : ''}>仍要再次執行</label>` : ''}`));
  }
  if (!pending) {
    const cls = d.status === 'imported' ? 'ok' : d.status === 'cancelled' ? 'info' : 'err';
    notices.unshift(banner(cls, `${esc(st.text)}${d.message ? `：${esc(d.message)}` : ''}`));
  }

  const conns = d.connections.length
    ? `<select id="xConn" ${pending ? '' : 'disabled'}><option value="">— 選擇實際連線 —</option>${d.connections.map((/** @type {any} */ c) => `<option value="${esc(c.id)}" ${c.id === inp.connectionId ? 'selected' : ''}>${esc(c.name)}（${esc(c.label)}）</option>`).join('')}</select>
       <span id="xPwRow" class="row" style="gap:6px" hidden><input type="password" id="xPw" placeholder="密碼（只用於這次匯入）" autocomplete="off" value="${esc(inp.password)}"></span>`
    : '<span class="warn">還沒有任何連線設定。</span><button class="secondary" id="xNewProfile">＋ 新增連線</button>';

  const statements = d.statements.map((/** @type {any} */ s) => {
    const c = CATEGORY[/** @type {keyof typeof CATEGORY} */ (s.category)] || CATEGORY.other;
    const rows = s.rows
      ? `<details><summary>${s.rowsCount} 列參數，各執行一次${s.rowsCount > s.rows.length ? `（只顯示前 ${s.rows.length} 列）` : ''}</summary>
          <div class="xtbl"><table class="grid"><thead><tr>${s.names.map((/** @type {string} */ n) => `<th>:${esc(n)}</th>`).join('')}</tr></thead>
          <tbody>${s.rows.map((/** @type {string[]} */ r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`
      : '';
    const extra = [
      s.expect ? `檢查 ${esc(JSON.stringify(s.expect))}` : '',
      s.returnsRows ? `每次最多回傳 ${s.maxRows || d.maxRowsDefault} 列` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="stmt">
      <div class="hd"><b>${esc(s.label)}</b>${badge(c.text, c.cls)}<span class="faint">${esc(s.keyword || '')}</span>
        ${s.allowed ? '' : `<span class="err">✖ ${esc(s.reason)}</span>`}<span class="spacer" style="flex:1"></span><span class="muted-sm">${extra}</span></div>
      <pre>${esc(s.sql)}</pre>
      ${s.params.length || rows ? `<div class="bd">${paramsTable(s.params, '這個語句專用的參數')}${rows}</div>` : ''}
    </div>`;
  }).join('');

  const actions = pending
    ? `<div class="xactions">
        ${d.needsDryRun ? '<button class="secondary" id="xDryBtn">試跑（執行後 ROLLBACK）</button>' : ''}
        <button id="xExecBtn">${d.queryOnly ? '確認並執行查詢' : '確認執行'}</button>
        <span class="muted-sm" id="xHint"></span>
        <span class="spacer"></span>
        <button class="danger" id="xRejectBtn">拒絕</button>
      </div>
      ${d.running ? `<div class="xbanner info">${d.running === 'dry' ? '試跑中…' : '執行中…'}</div>` : ''}
      ${d.needsDryRun ? '<div class="muted-sm" style="margin-top:6px">試跑會在專用連線上實際執行再 ROLLBACK，資料不會變更；但序號（SEQUENCE、IDENTITY）會前進，觸發程序中的自主交易也不會回復。</div>' : ''}`
    : `<div class="xactions"><span class="spacer"></span><button class="secondary" id="xDismiss">從清單移除</button></div>`;

  $('#importCol').innerHTML = `${backBar()}
    <h1>${esc(d.pkg.title)} ${badge(st.text, st.cls)}</h1>
    ${d.pkg.description ? `<div class="muted">${esc(d.pkg.description)}</div>` : ''}
    <dl class="kv">
      <dt>來源</dt><dd>${origin}</dd>
      <dt>格式</dt><dd>${esc(d.pkg.type)} v${esc(d.pkg.typeVersion)}</dd>
      <dt>交換包 id</dt><dd><code>${esc(d.pkg.id)}</code></dd>
      ${created ? `<dt>建立時間</dt><dd>${esc(created)}</dd>` : ''}
      <dt>目標</dt><dd>${esc(d.target ? d.target.name : '?')}${d.target && d.target.database ? `（${esc(d.target.database)}）` : ''} · 方言 ${esc(d.dialect)}</dd>
      <dt>交易</dt><dd>${esc(TRANSACTION[/** @type {keyof typeof TRANSACTION} */ (d.transaction)] || d.transaction)}${d.expect ? ` · 整包檢查 ${esc(JSON.stringify(d.expect))}` : ''}</dd>
    </dl>
    ${notices.join('')}
    <div class="xblock"><h3>執行的連線</h3><div class="xform">${conns}</div>
      <div class="muted-sm" style="margin-top:4px">交換包不帶帳號密碼，由你選擇實際連線。試跑與執行都會另外開一條專用連線，不會影響編輯器裡的連線與未提交的交易。</div></div>
    ${d.params.length ? `<div class="xblock"><h3>共用參數</h3>${paramsTable(d.params)}</div>` : ''}
    <div class="xblock"><h3>語句（${d.statements.length}）</h3>${statements}</div>
    ${d.dry && pending ? resultBlock(d, d.dry.data, true) : ''}
    ${d.result ? resultBlock(d, d.result, false) : ''}
    ${actions}`;

  bindBack();
  bindDetail(d);
  updateControls();
}

/** @param {any} d */
function bindDetail(d) {
  const col = $('#importCol');
  col.querySelectorAll('input, select').forEach((el) => {
    el.addEventListener('input', () => updateControls());
    el.addEventListener('change', () => updateControls());
  });
  const on = (/** @type {string} */ sel, /** @type {() => void} */ fn) => { const b = document.querySelector(sel); if (b) /** @type {HTMLElement} */ (b).onclick = fn; };
  on('#xDryBtn', () => run('dry'));
  on('#xExecBtn', () => run('exec'));
  on('#xRejectBtn', async () => {
    if (!(await ask(`拒絕執行「${d.pkg.title}」？`, '產生端會收到「未執行」，資料庫不會有任何變更。', '拒絕'))) return;
    try { await td.invoke('exchange.reject', d.key); } catch (err) { td.toast(msgOf(err), 'error'); }
    await refreshDetail();
  });
  on('#xDismiss', async () => {
    try { await td.invoke('exchange.dismiss', d.key); } catch (err) { td.toast(msgOf(err), 'error'); }
    xui.inputs.delete(d.key);
    showImportCol(false);
    await loadImports();
  });
  on('#xNewProfile', () => { showImportCol(false); /** @type {HTMLElement} */ ($('#newProfile')).click(); });
  col.querySelectorAll('[data-share]').forEach((b) => {
    /** @type {HTMLElement} */ (b).onclick = async () => {
      const [si, ri] = String(/** @type {HTMLElement} */ (b).dataset.share).split(':').map(Number);
      try {
        const r = await td.invoke('exchange.shareResult', d.key, si, ri);
        /** @type {Record<string, string>} */
        const msg = { delivered: `已交給「${r.receiver && r.receiver.name}」`, exported: `已存成 ${r.filePath}`, 'no-receiver': '沒有可接收的工具', cancelled: '已取消', error: `失敗：${r.message}` };
        td.toast(msg[r.status] || r.status, r.status === 'error' ? 'error' : 'info');
      } catch (err) { td.toast(msgOf(err), 'error'); }
    };
  });
}

/** @param {'dry' | 'exec'} which */
async function run(which) {
  const d = xui.detail;
  if (!d || xui.busy) return;
  const inp = readInputs(d);
  if (which === 'exec' && !d.queryOnly) {
    const conn = d.connections.find((/** @type {any} */ c) => c.id === inp.connectionId) || {};
    const dry = d.dry && d.dry.data ? `試跑預計影響 ${d.dry.data.totalAffectedRows} 筆。` : '';
    if (!(await ask(`在「${conn.name}」執行「${d.pkg.title}」？`, `${dry}${d.transaction === 'all' ? '全部成功才會提交。' : d.transaction === 'none' ? '不使用交易，執行後無法回復。' : '每個語句各自提交。'}`, '執行'))) return;
  }
  xui.busy = true;
  updateControls();
  try {
    xui.detail = await td.invoke(which === 'dry' ? 'exchange.dryRun' : 'exchange.execute', d.key, {
      connectionId: inp.connectionId, prompts: inp.prompts, password: inp.password, confirmDuplicate: inp.confirmDuplicate,
    });
    inp.password = ''; // 密碼只送一次，之後由後端在這次匯入中記住
  } catch (err) {
    td.toast(msgOf(err), 'error');
    try { xui.detail = await td.invoke('exchange.detail', d.key); } catch { /* 匯入已結束 */ }
  } finally {
    xui.busy = false;
  }
  renderDetail();
  if (which === 'dry') { const r = document.querySelector('#xDryResult'); if (r) r.scrollIntoView({ block: 'nearest' }); }
}

/* ───────── 稽核紀錄 ───────── */

async function showAudit() {
  openImportsTab();
  showImportCol(true);
  xui.view = 'audit';
  xui.key = null;
  renderImportList();
  /** @type {any[]} */
  let list = [];
  try { list = await td.invoke('exchange.audit'); } catch (err) { td.toast(msgOf(err), 'error'); }
  const rows = list.map((a) => `<tr>
      <td>${esc(new Date(a.at).toLocaleString())}</td><td>${esc(a.title)}</td>
      <td>${a.origin === 'file' ? '檔案' : '分享'}（${esc(a.source && a.source.extId)}）</td>
      <td>${esc(a.connection || '—')}</td>
      <td>${esc((a.statements || []).filter((/** @type {any} */ s) => s.affectedRows).map((/** @type {any} */ s) => `${s.id}: ${s.affectedRows.join('+')}`).join('、') || '—')}</td>
      <td class="${a.result === 'imported' ? 'ok' : a.result === 'cancelled' ? '' : 'err'}">${esc(a.result)}${a.message ? `：${esc(a.message)}` : ''}</td></tr>`).join('');
  $('#importCol').innerHTML = `${backBar()}<h1>稽核紀錄</h1>
    <div class="muted-sm">每次執行、拒絕或取消都會記錄時間、交換包 id、標題、來源、實際連線、每個語句的影響筆數與結果（最近 200 筆）。</div>
    ${list.length ? `<div class="xtbl" style="max-height:none"><table class="grid"><thead><tr><th>時間</th><th>標題</th><th>來源</th><th>連線</th><th>影響筆數</th><th>結果</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="sideEmpty">尚無紀錄</div>'}`;
  bindBack();
}

/* ───────── 啟動 ───────── */

td.on('exchange.changed', async (/** @type {{ key: string | null }} */ e) => {
  const known = new Set(xui.list.map((x) => x.key));
  await loadImports();
  const fresh = e && e.key && !known.has(e.key) ? xui.list.find((x) => x.key === e.key && x.status === 'pending') : null;
  if (fresh) { await openImport(fresh.key); return; } // 新收到的交換包：直接切到預覽
  if (xui.view === 'import' && xui.key && e && e.key === xui.key && !xui.busy) await refreshDetail();
});

loadImports().then(() => {
  // 平台為了匯入而開啟這個畫面時，交換包可能比畫面先到：開啟最新一個待確認的
  const pending = xui.list.find((x) => x.status === 'pending');
  if (pending) openImport(pending.key);
});
