// @ts-check
/** Oracle SQL 工具：畫面 */
const td = window.tooldock;

/** @template {HTMLElement} [T=HTMLElement] @param {string} sel @returns {T} */
const $ = (sel) => /** @type {T} */ (document.querySelector(sel));

/** @type {HTMLTextAreaElement} */
const editor = $('#sql');
/** @type {HTMLSelectElement} */
const profileSel = $('#profile');
/** @type {HTMLInputElement} */
const autoCommit = $('#autoCommit');
/** @type {HTMLSelectElement} */
const schemaSel = $('#schema');

/** @typedef {{ id: string, name: string, host: string, port: number, serviceName: string, user: string, connectString?: string }} Profile */
/** @typedef {{ connected: boolean, profile: Profile | null, pending: boolean, running: boolean, autoCommit: boolean, maxRows: number }} State */
/** @typedef {{ id: string, name: string, sql: string, updatedAt: number }} Snippet */
/** @typedef {{ NAME: string, TYPE: string, NUM_ROWS: number | null, COMMENTS: string | null }} DbObject */

const ui = {
  /** @type {Profile[]} */ profiles: [],
  /** @type {string[]} */ savedPasswords: [],
  secretsAvailable: false,
  /** @type {string[]} */ history: [],
  /** @type {Snippet[]} */ snippets: [],
  /** @type {State} */ state: { connected: false, profile: null, pending: false, running: false, autoCommit: false, maxRows: 500 },
  /** @type {any[]} */ results: [],
  active: 0,
  /** @type {DbObject[]} */ objects: [],
  currentSchema: '',
  selectedObject: '',
  /** @type {Snippet | null} */ loadedSnippet: null,
};

/** @param {unknown} err */
const msgOf = (err) => (err instanceof Error ? err.message : String(err));
/** @param {string} sel */
const btn = (sel) => /** @type {HTMLButtonElement} */ ($(sel));

/* ───────── 狀態 ───────── */

/** @param {State} s */
function applyState(s) {
  const wasConnected = ui.state.connected;
  ui.state = s;
  const c = s.connected;
  $('#connectBtn').textContent = c ? '中斷連線' : '連線';
  $('#connectBtn').className = c ? 'secondary' : '';
  btn('#runBtn').disabled = !c || s.running;
  btn('#runAllBtn').disabled = !c || s.running;
  btn('#cancelBtn').disabled = !s.running;
  btn('#commitBtn').disabled = !c || !s.pending;
  btn('#rollbackBtn').disabled = !c || !s.pending;
  profileSel.disabled = c;
  autoCommit.checked = s.autoCommit;
  $('#connInfo').innerHTML = c && s.profile
    ? `<span class="badge ok">已連線</span> ${td.escape(s.profile.user)}@${td.escape(s.profile.connectString || `${s.profile.host}:${s.profile.port}/${s.profile.serviceName}`)}${s.pending ? ' <span class="badge warn">有未提交的交易</span>' : ''}`
    : '<span class="badge">未連線</span>';
  $('#footRight').textContent = s.running ? '執行中…' : `最多顯示 ${s.maxRows} 列　${s.autoCommit ? '自動提交' : '手動提交'}`;
  if (wasConnected && !c) { ui.objects = []; renderObjects(); schemaSel.innerHTML = ''; }
}

function renderProfiles() {
  const cur = profileSel.value;
  profileSel.innerHTML = ui.profiles.length
    ? ui.profiles.map((p) => `<option value="${p.id}">${ui.savedPasswords.includes(p.id) ? '🔑 ' : ''}${td.escape(p.name)}</option>`).join('')
    : '<option value="">（尚無連線設定）</option>';
  if (ui.profiles.some((p) => p.id === cur)) profileSel.value = cur;
  else if (ui.state.profile) profileSel.value = ui.state.profile.id;
}

async function refresh() {
  const s = await td.invoke('state');
  ui.profiles = s.profiles;
  ui.savedPasswords = s.savedPasswords;
  ui.secretsAvailable = s.secretsAvailable;
  ui.history = s.history;
  ui.snippets = s.snippets;
  renderProfiles();
  renderSnippets();
  applyState(s);
}

/* ───────── 連線設定 ───────── */

/** @type {HTMLDialogElement} */ const dlg = $('#dlg');
/** @type {HTMLFormElement} */ const form = $('#form');

/** @param {Profile | null} p */
function openProfile(p) {
  const el = /** @type {any} */ (form.elements);
  $('#dlgTitle').textContent = p ? '編輯連線' : '新增連線';
  el.profileId.value = p ? p.id : '';
  el.name.value = p ? p.name : '';
  el.host.value = p ? p.host : 'localhost';
  el.port.value = p ? p.port : 1521;
  el.serviceName.value = p ? p.serviceName : '';
  el.user.value = p ? p.user : '';
  el.connectString.value = p ? p.connectString || '' : '';
  btn('#removeProfile').hidden = !p;
  $('#savedPwRow').hidden = !(p && ui.savedPasswords.includes(p.id));
  dlg.showModal();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { profileId, ...data } = Object.fromEntries(new FormData(form));
  try {
    const saved = await td.invoke('saveProfile', { ...data, id: profileId || undefined });
    dlg.close();
    await refresh();
    profileSel.value = saved.id;
  } catch (err) { td.toast(msgOf(err), 'error'); }
});
$('#cancelDlg').onclick = () => dlg.close();
$('#newProfile').onclick = () => openProfile(null);
$('#editProfile').onclick = () => openProfile(ui.profiles.find((p) => p.id === profileSel.value) || null);
$('#removeProfile').onclick = async () => {
  const id = /** @type {any} */ (form.elements).profileId.value;
  const r = await td.dialog.message({ type: 'warning', message: '刪除這個連線設定？', detail: '記住的密碼也會一併清除。', buttons: ['刪除', '取消'], defaultId: 1, cancelId: 1 });
  if (r.response !== 0) return;
  await td.invoke('removeProfile', id);
  dlg.close();
  refresh();
};
$('#forgetPw').onclick = async () => {
  ui.savedPasswords = await td.invoke('forgetPassword', /** @type {any} */ (form.elements).profileId.value);
  $('#savedPwRow').hidden = true;
  renderProfiles();
  td.toast('已清除記住的密碼', 'success');
};

/* ───────── 連線 ───────── */

/** @type {HTMLDialogElement} */ const pwDlg = $('#pwDlg');
/** @type {HTMLFormElement} */ const pwForm = $('#pwForm');

/** @param {any} r */
async function afterConnect(r) {
  ui.savedPasswords = r.savedPasswords || ui.savedPasswords;
  renderProfiles();
  applyState(r);
  setFoot(`已連線：${r.dbName}（schema ${r.schema}），Oracle ${r.serverVersion}`);
  editor.focus();
  await loadSchemas();
}

/** @param {string} [reason] */
function askPassword(reason) {
  const p = ui.profiles.find((x) => x.id === profileSel.value);
  if (!p) return;
  $('#pwTarget').textContent = p.name;
  pwForm.reset();
  $('#pwReason').hidden = !reason;
  $('#pwReason').textContent = reason || '';
  $('#rememberRow').hidden = !ui.secretsAvailable;
  $('#rememberNA').hidden = ui.secretsAvailable;
  pwDlg.showModal();
}

$('#connectBtn').onclick = async () => {
  if (ui.state.connected) {
    let opts = {};
    if (ui.state.pending) {
      const r = await td.dialog.message({ type: 'question', message: '有未提交的交易', detail: '中斷連線前要提交（Commit）還是回滾（Rollback）？', buttons: ['Commit', 'Rollback', '取消'], defaultId: 1, cancelId: 2 });
      if (r.response === 2) return;
      opts = { commit: r.response === 0 };
    }
    applyState(await td.invoke('disconnect', opts));
    return;
  }
  const p = ui.profiles.find((x) => x.id === profileSel.value);
  if (!p) { openProfile(null); return; }
  if (!ui.savedPasswords.includes(p.id)) { askPassword(); return; }
  // 有記住密碼：直接連線
  $('#connInfo').innerHTML = '<span class="badge info">連線中…</span>';
  try {
    const r = await td.invoke('connect', p.id, null);
    if (r.needPassword) { applyState(ui.state); askPassword(r.reason); return; }
    await afterConnect(r);
  } catch (err) {
    applyState(ui.state);
    showMessage('連線失敗', msgOf(err), true);
  }
};
$('#pwCancel').onclick = () => pwDlg.close();
pwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(pwForm);
  const password = String(fd.get('password') || '');
  const remember = ui.secretsAvailable && fd.get('remember') === 'on';
  pwDlg.close();
  $('#connInfo').innerHTML = '<span class="badge info">連線中…</span>';
  try {
    await afterConnect(await td.invoke('connect', profileSel.value, password, { remember: remember || undefined }));
    if (remember) td.toast('已記住密碼，下次連線不需再輸入', 'success');
  } catch (err) {
    applyState(ui.state);
    showMessage('連線失敗', msgOf(err), true);
  }
});

/* ───────── 參數 ───────── */

/** @type {HTMLDialogElement} */ const bindDlg = $('#bindDlg');
/** @type {HTMLFormElement} */ const bindForm = $('#bindForm');
/** @type {((v: Record<string, { type: string, value: string }> | null) => void) | null} */
let bindResolve = null;

/**
 * @param {{ name: string, last: { type: string, value: string } | null }[]} list
 * @returns {Promise<Record<string, { type: string, value: string }> | null>}
 */
function askBinds(list) {
  // 依參數名稱推測型別（只是預設值，可在對話框中更改）
  const guess = (/** @type {string} */ n) => {
    if (/date|day|time|_dt$|^dt_|since|until|_at$|_from$|_to$|^from_|^to_/i.test(n)) return 'date';
    if (/^(id|n|no|num|qty|amount|price|count|limit|offset|year|month|age)$|_id$|_no$|_num$|_qty$|_count$|amount|price|salary|^min_|^max_/i.test(n)) return 'number';
    return 'string';
  };
  $('#bindRows').innerHTML = list.map((b, i) => {
    const type = b.last ? b.last.type : guess(b.name);
    const value = b.last ? b.last.value : '';
    const opt = (/** @type {string} */ v, /** @type {string} */ t) => `<option value="${v}" ${v === type ? 'selected' : ''}>${t}</option>`;
    return `<span class="bn">:${td.escape(b.name)}</span>
      <select data-i="${i}" class="bt">${opt('string', '文字')}${opt('number', '數字')}${opt('date', '日期')}${opt('null', 'NULL')}</select>
      <input data-i="${i}" class="bv" value="${td.escape(value)}" placeholder="${type === 'date' ? 'YYYY-MM-DD [HH:MM:SS]' : ''}" ${type === 'null' ? 'disabled' : ''}>`;
  }).join('');
  $('#bindRows').querySelectorAll('select.bt').forEach((s) => {
    s.addEventListener('change', () => {
      const sel = /** @type {HTMLSelectElement} */ (s);
      const input = /** @type {HTMLInputElement} */ ($(`#bindRows input[data-i="${sel.dataset.i}"]`));
      input.disabled = sel.value === 'null';
      input.placeholder = sel.value === 'date' ? 'YYYY-MM-DD [HH:MM:SS]' : '';
    });
  });
  bindDlg.showModal();
  const first = /** @type {HTMLInputElement | null} */ ($('#bindRows input.bv'));
  if (first) { first.focus(); first.select(); }
  return new Promise((resolve) => {
    bindResolve = (values) => {
      if (!values) { resolve(null); return; }
      resolve(values);
    };
    bindForm.dataset.names = JSON.stringify(list.map((b) => b.name));
  });
}

bindForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const names = JSON.parse(bindForm.dataset.names || '[]');
  /** @type {Record<string, { type: string, value: string }>} */
  const values = {};
  names.forEach((/** @type {string} */ n, /** @type {number} */ i) => {
    const type = /** @type {HTMLSelectElement} */ ($(`#bindRows select[data-i="${i}"]`)).value;
    const value = /** @type {HTMLInputElement} */ ($(`#bindRows input[data-i="${i}"]`)).value;
    values[n.toUpperCase()] = { type, value };
  });
  bindDlg.close();
  if (bindResolve) bindResolve(values);
  bindResolve = null;
});
$('#bindCancel').onclick = () => { bindDlg.close(); if (bindResolve) bindResolve(null); bindResolve = null; };

/* ───────── 執行 ───────── */

/** @param {'current' | 'all'} which */
async function run(which) {
  if (!ui.state.connected || ui.state.running) return;
  const selected = editor.selectionStart !== editor.selectionEnd;
  const text = selected ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : editor.value;
  const mode = which === 'all' ? 'all' : selected ? 'selection' : 'current';
  const req = { text, cursor: editor.selectionStart, mode };
  try {
    let r = await td.invoke('execute', req);
    if (r.needBinds) {
      if (r.range && mode === 'current') editor.setSelectionRange(r.range.start, Math.min(r.range.end + 1, editor.value.length));
      const binds = await askBinds(r.needBinds);
      if (!binds) { setFoot('已取消執行'); return; }
      setFoot('執行中…');
      r = await td.invoke('execute', { ...req, binds });
    } else {
      setFoot('執行中…');
    }
    applyState(r.state);
    ui.results = r.results;
    if (r.range && mode === 'current') editor.setSelectionRange(r.range.start, Math.min(r.range.end + 1, editor.value.length));
    const failed = r.results.find((/** @type {any} */ x) => !x.ok);
    ui.active = failed ? r.results.indexOf(failed) : Math.max(0, r.results.findIndex((/** @type {any} */ x) => x.kind === 'query'));
    renderResults();
    const total = r.results.reduce((/** @type {number} */ s, /** @type {any} */ x) => s + x.ms, 0);
    setFoot(failed ? `第 ${r.results.length} / ${r.total} 句發生錯誤，後續指令未執行` : `已執行 ${r.executed} 句，共 ${total} ms`);
    ui.history = (await td.invoke('state')).history;
  } catch (err) {
    showMessage('無法執行', msgOf(err), true);
    setFoot('');
  }
}

$('#runBtn').onclick = () => run('current');
$('#runAllBtn').onclick = () => run('all');
$('#cancelBtn').onclick = () => td.invoke('cancel');
$('#commitBtn').onclick = async () => { applyState(await td.invoke('commit')); setFoot('已提交（Commit）'); };
$('#rollbackBtn').onclick = async () => { applyState(await td.invoke('rollback')); setFoot('已回滾（Rollback）'); };
autoCommit.onchange = async () => applyState(await td.invoke('setAutoCommit', autoCommit.checked));

editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? 'all' : 'current'); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); openSaveSnippet(); }
  else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); }
});
editor.addEventListener('input', () => { try { localStorage.setItem('sql', editor.value); } catch { /* 忽略 */ } });

/* ───────── 結果 ───────── */

/** @param {string} text */
function setFoot(text) { $('#footMsg').textContent = text; }

/** @param {string} title @param {string} body @param {boolean} [error] */
function showMessage(title, body, error) {
  $('#tabs').innerHTML = '';
  $('#pane').innerHTML = `<div class="msg"><b class="${error ? 'err' : ''}">${td.escape(title)}</b><pre>${td.escape(body)}</pre></div>`;
}

/** @param {any} r @param {number} i */
function tabLabel(r, i) {
  if (!r.ok) return `#${i + 1} 錯誤`;
  if (r.kind === 'query') return `#${i + 1} 結果（${r.rows.length}${r.truncated ? '+' : ''}）`;
  return `#${i + 1} ${r.kind === 'dml' ? `${r.rowsAffected} 列` : '完成'}`;
}

/** @param {any} r */
function boundChips(r) {
  if (!r.bound || !r.bound.length) return '';
  return `<div class="chips">${r.bound.map((/** @type {any} */ b) => `<span class="chip">:${td.escape(b.name)} = ${b.value === null ? 'NULL' : td.escape(b.value)}</span>`).join('')}</div>`;
}

function renderResults() {
  const list = ui.results;
  $('#tabs').innerHTML = list.map((r, i) => `<button class="${i === ui.active ? 'on' : ''} ${r.ok ? '' : 'err'}" data-i="${i}">${tabLabel(r, i)}</button>`).join('');
  const r = list[ui.active];
  if (!r) { $('#pane').innerHTML = ''; return; }
  const sqlBlock = `<pre>${td.escape(r.sql.length > 2000 ? `${r.sql.slice(0, 2000)}…` : r.sql)}</pre>`;
  const out = r.output && r.output.length ? `<div class="msg"><b>DBMS_OUTPUT</b><pre>${td.escape(r.output.join('\n'))}</pre></div>` : '';
  if (!r.ok) {
    $('#pane').innerHTML = `<div class="msg"><b class="err">${td.escape(r.code || '錯誤')}</b><pre class="err">${td.escape(r.error)}</pre>${sqlBlock}</div>`;
    return;
  }
  if (r.kind !== 'query') {
    const what = r.kind === 'dml' ? `${r.rowsAffected} 列受影響${ui.state.autoCommit ? '（已自動提交）' : '（尚未提交）'}` : '執行完成';
    $('#pane').innerHTML = `<div class="msg"><b class="ok">✓ ${what}</b><span class="faint">　${r.ms} ms</span>${boundChips(r)}${sqlBlock}</div>${out}`;
    return;
  }
  const head = `<tr><th>#</th>${r.columns.map((/** @type {any} */ c) => `<th>${td.escape(c.name)}<span class="t">${td.escape(c.type)}</span></th>`).join('')}</tr>`;
  const body = r.rows.map((/** @type {any[]} */ row, /** @type {number} */ n) => `<tr><td class="rn">${n + 1}</td>${row.map((v) => (v === null ? '<td class="null">NULL</td>' : `<td class="${typeof v === 'number' ? 'num' : ''}" title="${td.escape(v)}">${td.escape(v)}</td>`)).join('')}</tr>`).join('');
  $('#pane').innerHTML = `<div class="row" style="padding:6px 12px;font-size:12px">
      <span class="muted">${r.rows.length} 列${r.truncated ? `（只顯示前 ${r.rows.length} 列，可在設定調整上限）` : ''}　${r.ms} ms</span>${boundChips(r)}
      <span class="spacer"></span><button class="ghost" id="csvBtn">匯出 CSV</button></div>
    <table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table>${out}`;
  $('#csvBtn').onclick = async () => {
    const file = await td.invoke('exportCsv', { columns: r.columns, rows: r.rows });
    if (file) td.toast(`已匯出 ${file}`, 'success');
  };
}

$('#tabs').addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('button[data-i]');
  if (b instanceof HTMLElement) { ui.active = Number(b.dataset.i); renderResults(); }
});

/* ───────── 側欄：資料表 ───────── */

document.querySelectorAll('#sideTabs button').forEach((b) => {
  b.addEventListener('click', () => {
    const pane = /** @type {HTMLElement} */ (b).dataset.pane;
    document.querySelectorAll('#sideTabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#pane-objects').hidden = pane !== 'objects';
    $('#pane-snippets').hidden = pane !== 'snippets';
  });
});
$('#toggleSide').onclick = () => document.body.classList.toggle('side-hidden');

async function loadSchemas() {
  try {
    const r = await td.invoke('listSchemas');
    ui.currentSchema = r.current;
    schemaSel.innerHTML = r.schemas.map((/** @type {string} */ s) => `<option value="${td.escape(s)}">${td.escape(s)}${s === r.current ? '（目前）' : ''}</option>`).join('');
    schemaSel.value = r.current;
    await loadObjects();
  } catch (err) {
    $('#objList').innerHTML = `<div class="sideEmpty err">${td.escape(msgOf(err))}</div>`;
  }
}

async function loadObjects() {
  if (!ui.state.connected) return;
  $('#objList').innerHTML = '<div class="sideEmpty">載入中…</div>';
  try {
    ui.objects = await td.invoke('listObjects', { owner: schemaSel.value });
    renderObjects();
  } catch (err) {
    $('#objList').innerHTML = `<div class="sideEmpty err">${td.escape(msgOf(err))}</div>`;
  }
}

function renderObjects() {
  const q = /** @type {HTMLInputElement} */ ($('#objFilter')).value.trim().toUpperCase();
  const list = ui.objects.filter((o) => !q || o.NAME.toUpperCase().includes(q) || (o.COMMENTS || '').toUpperCase().includes(q));
  if (!ui.state.connected) { $('#objList').innerHTML = '<div class="sideEmpty">連線後顯示資料表</div>'; return; }
  $('#objList').innerHTML = list.length
    ? list.map((o) => `<div class="obj ${o.NAME === ui.selectedObject ? 'sel' : ''}" data-name="${td.escape(o.NAME)}" title="${td.escape(o.COMMENTS || '')}　雙擊查詢前 100 列">
        <span class="k ${o.TYPE === 'VIEW' ? 'V' : 'T'}">${o.TYPE === 'VIEW' ? 'V' : 'T'}</span>
        <span class="n">${td.escape(o.NAME)}</span>${o.NUM_ROWS != null ? `<span class="c">${Number(o.NUM_ROWS).toLocaleString()}</span>` : ''}</div>`).join('')
    : `<div class="sideEmpty">${ui.objects.length ? '沒有符合的項目' : '這個 schema 沒有資料表或檢視表'}</div>`;
}

/** 必要時加上引號，並在非目前 schema 時加上擁有者 @param {string} name */
function qualified(name) {
  const q = (/** @type {string} */ s) => (/^[A-Z][A-Z0-9_$#]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
  return schemaSel.value && schemaSel.value !== ui.currentSchema ? `${q(schemaSel.value)}.${q(name)}` : q(name);
}

/** @param {string} sql */
function insertSql(sql) {
  const before = editor.value.slice(0, editor.selectionStart);
  const prefix = before && !before.endsWith('\n') ? '\n' : '';
  editor.setRangeText(`${prefix}${sql}\n`, editor.selectionStart, editor.selectionEnd, 'end');
  const end = editor.selectionStart - 1;
  const start = end - sql.length;
  editor.setSelectionRange(start, start);
  editor.dispatchEvent(new Event('input'));
}

/** @param {string} name */
function queryTop(name) {
  insertSql(`SELECT * FROM ${qualified(name)} FETCH FIRST 100 ROWS ONLY;`);
  run('current');
}

/** @param {string} name */
async function showDescribe(name) {
  ui.selectedObject = name;
  renderObjects();
  try {
    const cols = await td.invoke('describe', { owner: schemaSel.value, name });
    const obj = ui.objects.find((o) => o.NAME === name);
    $('#tabs').innerHTML = `<button class="on">${td.escape(name)} 結構</button>`;
    $('#pane').innerHTML = `<div class="row" style="padding:8px 12px">
        <b>${td.escape(qualified(name))}</b><span class="badge">${obj && obj.TYPE === 'VIEW' ? '檢視表' : '資料表'}</span>
        <span class="muted" style="font-size:12px">${td.escape((obj && obj.COMMENTS) || '')}</span><span class="spacer"></span>
        <button class="secondary" id="dTop">查詢前 100 列</button><button class="ghost" id="dSelect">插入 SELECT</button><button class="ghost" id="dName">插入名稱</button></div>
      <table class="grid"><thead><tr><th>#</th><th>欄位</th><th>型別</th><th>可為 NULL</th><th>說明</th></tr></thead><tbody>
      ${cols.map((/** @type {any} */ c) => `<tr><td class="rn">${c.pos}</td><td>${c.pk ? '🔑 ' : ''}${td.escape(c.name)}</td><td><code>${td.escape(c.type)}</code></td><td>${c.nullable ? 'Y' : '<b>N</b>'}</td><td class="muted">${td.escape(c.comments)}</td></tr>`).join('')}
      </tbody></table>`;
    $('#dTop').onclick = () => queryTop(name);
    $('#dName').onclick = () => { editor.setRangeText(qualified(name), editor.selectionStart, editor.selectionEnd, 'end'); editor.focus(); };
    $('#dSelect').onclick = () => {
      const colList = cols.map((/** @type {any} */ c) => (/^[A-Z][A-Z0-9_$#]*$/.test(c.name) ? c.name : `"${c.name}"`)).join(',\n       ');
      insertSql(`SELECT ${colList}\nFROM ${qualified(name)}\nWHERE 1 = 1;`);
      editor.focus();
    };
  } catch (err) {
    showMessage('無法讀取結構', msgOf(err), true);
  }
}

$('#objList').addEventListener('click', (e) => {
  const el = /** @type {HTMLElement} */ (e.target).closest('.obj');
  if (el instanceof HTMLElement && el.dataset.name) showDescribe(el.dataset.name);
});
$('#objList').addEventListener('dblclick', (e) => {
  const el = /** @type {HTMLElement} */ (e.target).closest('.obj');
  if (el instanceof HTMLElement && el.dataset.name) queryTop(el.dataset.name);
});
$('#objFilter').addEventListener('input', renderObjects);
schemaSel.addEventListener('change', loadObjects);
$('#refreshObjects').onclick = loadObjects;

/* ───────── 側欄：已存 SQL ───────── */

/** @type {HTMLDialogElement} */ const snipDlg = $('#snipDlg');
/** @type {HTMLFormElement} */ const snipForm = $('#snipForm');

function renderSnippets() {
  const q = /** @type {HTMLInputElement} */ ($('#snipFilter')).value.trim().toLowerCase();
  const list = ui.snippets.filter((s) => !q || s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));
  $('#snipList').innerHTML = list.length
    ? list.map((s) => `<div class="snip" data-id="${s.id}" title="點擊載入到編輯器">
        <div class="t"><b>${td.escape(s.name)}</b><span class="faint" style="font-size:10px">${new Date(s.updatedAt).toLocaleDateString('zh-TW')}</span><button class="danger" data-del="${s.id}">刪除</button></div>
        <pre>${td.escape(s.sql.slice(0, 200))}</pre></div>`).join('')
    : `<div class="sideEmpty">${ui.snippets.length ? '沒有符合的項目' : '還沒有儲存的 SQL<br>按「＋ 儲存目前 SQL」或 ⌘/Ctrl + S'}</div>`;
}

function openSaveSnippet() {
  if (!editor.value.trim()) { td.toast('編輯器是空的', 'warn'); return; }
  /** @type {any} */ (snipForm.elements).name.value = ui.loadedSnippet ? ui.loadedSnippet.name : '';
  snipDlg.showModal();
}

snipForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = /** @type {any} */ (snipForm.elements).name.value;
  try {
    ui.snippets = await td.invoke('saveSnippet', { name, sql: editor.value });
    ui.loadedSnippet = ui.snippets.find((s) => s.name === name.trim()) || null;
    snipDlg.close();
    renderSnippets();
    td.toast(`已儲存「${name.trim()}」`, 'success');
  } catch (err) { td.toast(msgOf(err), 'error'); }
});
$('#snipCancel').onclick = () => snipDlg.close();
$('#saveSnippet').onclick = openSaveSnippet;
$('#snipFilter').addEventListener('input', renderSnippets);

$('#snipList').addEventListener('click', async (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const del = target.closest('button[data-del]');
  if (del instanceof HTMLElement) {
    e.stopPropagation();
    const s = ui.snippets.find((x) => x.id === del.dataset.del);
    const r = await td.dialog.message({ type: 'warning', message: `刪除「${s ? s.name : ''}」？`, buttons: ['刪除', '取消'], defaultId: 1, cancelId: 1 });
    if (r.response !== 0) return;
    ui.snippets = await td.invoke('removeSnippet', del.dataset.del);
    if (ui.loadedSnippet && ui.loadedSnippet.id === del.dataset.del) ui.loadedSnippet = null;
    renderSnippets();
    return;
  }
  const item = target.closest('.snip');
  if (!(item instanceof HTMLElement)) return;
  const s = ui.snippets.find((x) => x.id === item.dataset.id);
  if (!s) return;
  editor.value = s.sql;
  ui.loadedSnippet = s;
  editor.dispatchEvent(new Event('input'));
  editor.focus();
  setFoot(`已載入「${s.name}」`);
});

$('#openFile').onclick = async () => {
  try {
    const f = await td.invoke('openSqlFile');
    if (!f) return;
    editor.value = f.sql;
    ui.loadedSnippet = null;
    editor.dispatchEvent(new Event('input'));
    setFoot(`已開啟 ${f.path}`);
  } catch (err) { td.toast(msgOf(err), 'error'); }
};
$('#saveFile').onclick = async () => {
  const file = await td.invoke('saveSqlFile', { sql: editor.value, name: ui.loadedSnippet ? ui.loadedSnippet.name : 'query' });
  if (file) td.toast(`已儲存 ${file}`, 'success');
};

/* ───────── 歷史紀錄 ───────── */

$('#historyBtn').onclick = () => {
  const box = $('#historyList');
  box.hidden = !box.hidden;
  box.innerHTML = ui.history.length
    ? ui.history.map((h, i) => `<div data-i="${i}" title="點擊放回編輯器">${td.escape(h)}</div>`).join('')
    : '<div class="faint">尚無紀錄</div>';
};
$('#historyList').addEventListener('click', (e) => {
  const d = /** @type {HTMLElement} */ (e.target).closest('div[data-i]');
  if (!(d instanceof HTMLElement)) return;
  editor.value = `${ui.history[Number(d.dataset.i)]};\n`;
  $('#historyList').hidden = true;
  editor.focus();
});
document.addEventListener('click', (e) => {
  if (!$('#history').contains(/** @type {Node} */ (e.target))) $('#historyList').hidden = true;
});

/* ───────── 編輯器高度拖曳 ───────── */

$('#resizer').addEventListener('mousedown', (e) => {
  const wrap = $('#editorWrap');
  const startY = e.clientY;
  const startH = wrap.getBoundingClientRect().height;
  /** @param {MouseEvent} ev */
  const move = (ev) => { wrap.style.height = `${Math.max(100, startH + ev.clientY - startY)}px`; };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

/* ───────── 啟動 ───────── */

td.on('state', (s) => applyState(s));
try { editor.value = localStorage.getItem('sql') || "-- 範例：\nSELECT SYSDATE, USER FROM DUAL;\n\n-- 參數：執行時會詢問 :prefix 的值\nSELECT table_name, num_rows FROM user_tables WHERE table_name LIKE :prefix || '%' ORDER BY table_name;\n"; } catch { /* 忽略 */ }
refresh().catch((err) => showMessage('載入失敗', msgOf(err), true));
