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

/** @typedef {{ id: string, name: string, host: string, port: number, serviceName: string, user: string, connectString?: string }} Profile */
/** @typedef {{ connected: boolean, profile: Profile | null, pending: boolean, running: boolean, autoCommit: boolean, maxRows: number }} State */

/** @type {{ profiles: Profile[], history: string[], state: State, results: any[], active: number }} */
const ui = {
  profiles: [],
  history: [],
  state: { connected: false, profile: null, pending: false, running: false, autoCommit: false, maxRows: 500 },
  results: [],
  active: 0,
};

/** @param {unknown} err */
const msgOf = (err) => (err instanceof Error ? err.message : String(err));

/* ───────── 狀態 ───────── */

/** @param {State} s */
function applyState(s) {
  ui.state = s;
  const c = s.connected;
  $('#connectBtn').textContent = c ? '中斷連線' : '連線';
  $('#connectBtn').className = c ? 'secondary' : '';
  /** @type {HTMLButtonElement} */ ($('#runBtn')).disabled = !c || s.running;
  /** @type {HTMLButtonElement} */ ($('#runAllBtn')).disabled = !c || s.running;
  /** @type {HTMLButtonElement} */ ($('#cancelBtn')).disabled = !s.running;
  /** @type {HTMLButtonElement} */ ($('#commitBtn')).disabled = !c || !s.pending;
  /** @type {HTMLButtonElement} */ ($('#rollbackBtn')).disabled = !c || !s.pending;
  profileSel.disabled = c;
  autoCommit.checked = s.autoCommit;
  $('#connInfo').innerHTML = c && s.profile
    ? `<span class="badge ok">已連線</span> ${td.escape(s.profile.user)}@${td.escape(s.profile.connectString || `${s.profile.host}:${s.profile.port}/${s.profile.serviceName}`)}${s.pending ? ' <span class="badge warn">有未提交的交易</span>' : ''}`
    : '<span class="badge">未連線</span>';
  $('#footRight').textContent = s.running ? '執行中…' : `最多顯示 ${s.maxRows} 列　${s.autoCommit ? '自動提交' : '手動提交'}`;
}

function renderProfiles() {
  const cur = profileSel.value;
  profileSel.innerHTML = ui.profiles.length
    ? ui.profiles.map((p) => `<option value="${p.id}">${td.escape(p.name)}</option>`).join('')
    : '<option value="">（尚無連線設定）</option>';
  if (ui.profiles.some((p) => p.id === cur)) profileSel.value = cur;
  else if (ui.state.profile) profileSel.value = ui.state.profile.id;
}

async function refresh() {
  const s = await td.invoke('state');
  ui.profiles = s.profiles;
  ui.history = s.history;
  renderProfiles();
  applyState(s);
}

/* ───────── 連線設定對話框 ───────── */

/** @type {HTMLDialogElement} */
const dlg = $('#dlg');
/** @type {HTMLFormElement} */
const form = $('#form');

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
  /** @type {HTMLButtonElement} */ ($('#removeProfile')).hidden = !p;
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
  const r = await td.dialog.message({ type: 'warning', message: '刪除這個連線設定？', buttons: ['刪除', '取消'], defaultId: 1, cancelId: 1 });
  if (r.response !== 0) return;
  await td.invoke('removeProfile', id);
  dlg.close();
  refresh();
};

/* ───────── 連線 ───────── */

/** @type {HTMLDialogElement} */
const pwDlg = $('#pwDlg');
/** @type {HTMLFormElement} */
const pwForm = $('#pwForm');

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
  $('#pwTarget').textContent = p.name;
  pwForm.reset();
  pwDlg.showModal();
};
$('#pwCancel').onclick = () => pwDlg.close();
pwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = String(new FormData(pwForm).get('password') || '');
  pwDlg.close();
  $('#connInfo').innerHTML = '<span class="badge info">連線中…</span>';
  try {
    const r = await td.invoke('connect', profileSel.value, password);
    applyState(r);
    setFoot(`已連線：${r.dbName}（schema ${r.schema}），Oracle ${r.serverVersion}`);
    editor.focus();
  } catch (err) {
    applyState(ui.state);
    showMessage('連線失敗', msgOf(err), true);
  }
});

/* ───────── 執行 ───────── */

/** @param {'current' | 'all'} which */
async function run(which) {
  if (!ui.state.connected || ui.state.running) return;
  const selected = editor.selectionStart !== editor.selectionEnd;
  const text = selected ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : editor.value;
  const mode = which === 'all' ? 'all' : selected ? 'selection' : 'current';
  setFoot('執行中…');
  try {
    const r = await td.invoke('execute', { text, cursor: editor.selectionStart, mode });
    applyState(r.state);
    ui.results = r.results;
    // 執行單一指令時，把執行範圍反白，方便確認執行的是哪一句
    if (r.range && mode === 'current') editor.setSelectionRange(r.range.start, Math.min(r.range.end + 1, editor.value.length));
    const failed = r.results.find((/** @type {any} */ x) => !x.ok);
    ui.active = failed ? r.results.indexOf(failed) : Math.max(0, r.results.findIndex((/** @type {any} */ x) => x.kind === 'query'));
    renderResults();
    const total = r.results.reduce((/** @type {number} */ s, /** @type {any} */ x) => s + x.ms, 0);
    setFoot(failed
      ? `第 ${r.results.length} / ${r.total} 句發生錯誤，後續指令未執行`
      : `已執行 ${r.executed} 句，共 ${total} ms`);
    const h = await td.invoke('state');
    ui.history = h.history;
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
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    run(e.shiftKey ? 'all' : 'current');
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
  }
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
    $('#pane').innerHTML = `<div class="msg"><b class="ok">✓ ${what}</b><span class="faint">　${r.ms} ms</span>${sqlBlock}</div>${out}`;
    return;
  }
  const head = `<tr><th>#</th>${r.columns.map((/** @type {any} */ c) => `<th>${td.escape(c.name)}<span class="t">${td.escape(c.type)}</span></th>`).join('')}</tr>`;
  const body = r.rows.map((/** @type {any[]} */ row, /** @type {number} */ n) => `<tr><td class="rn">${n + 1}</td>${row.map((v) => (v === null ? '<td class="null">NULL</td>' : `<td class="${typeof v === 'number' ? 'num' : ''}" title="${td.escape(v)}">${td.escape(v)}</td>`)).join('')}</tr>`).join('');
  $('#pane').innerHTML = `<div class="row" style="padding:6px 12px;font-size:12px">
      <span class="muted">${r.rows.length} 列${r.truncated ? `（只顯示前 ${r.rows.length} 列，可在設定調整上限）` : ''}　${r.ms} ms</span>
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
try { editor.value = localStorage.getItem('sql') || "-- 範例：\nSELECT SYSDATE, USER FROM DUAL;\n\nSELECT table_name, num_rows FROM user_tables ORDER BY table_name;\n"; } catch { /* 忽略 */ }
refresh().catch((err) => showMessage('載入失敗', msgOf(err), true));
