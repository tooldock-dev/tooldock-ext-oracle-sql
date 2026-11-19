/**
 * SQL 編輯器（CodeMirror 6）：以 `npm run build:editor` 打包成 ui/vendor/sql-editor.js，
 * 在畫面上以全域 `SqlEditor.create(parent, options)` 使用。
 *
 * 回傳的物件模仿 <textarea> 的介面（value、selectionStart、setRangeText…），
 * 讓 ui/app.js 不必知道底層換成了 CodeMirror。
 */
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, placeholder as placeholderExt, Decoration, ViewPlugin,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { syntaxHighlighting, syntaxTree, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { sql, SQLDialect, PLSQL } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';

/** 常用的 Oracle 內建函式（以「內建」顏色顯示） */
const ORACLE_FUNCTIONS = [
  // 字串
  'ascii chr concat initcap instr length lengthb lower lpad ltrim nls_initcap nls_lower nls_upper regexp_count',
  'regexp_instr regexp_like regexp_replace regexp_substr replace rpad rtrim soundex substr substrb translate trim upper',
  // 數值
  'abs ceil floor mod power remainder round sign sqrt trunc exp ln log greatest least width_bucket',
  // 日期
  'add_months current_date current_timestamp extract last_day localtimestamp months_between new_time next_day',
  'numtodsinterval numtoyminterval sys_extract_utc sysdate systimestamp',
  // 轉換
  'cast to_char to_clob to_date to_dsinterval to_number to_timestamp to_timestamp_tz to_yminterval rawtohex hextoraw',
  // NULL 與條件
  'coalesce decode nullif nvl nvl2 lnnvl',
  // 彙總與分析
  'avg count max min sum listagg median stddev variance rank dense_rank row_number ntile lag lead',
  'first_value last_value cume_dist percent_rank ratio_to_report',
  // 其他
  'sys_context sys_guid userenv uid ora_hash standard_hash dump vsize',
].join(' ');

/**
 * Oracle 方言：雙引號是識別字（不是字串）。
 * `:名稱` 綁定變數不在這裡處理（`:=` 也以冒號開頭），改由下方的 bindVariables 標示。
 */
const OracleDialect = SQLDialect.define({
  ...PLSQL.spec,
  builtin: `${PLSQL.spec.builtin || ''} ${ORACLE_FUNCTIONS}`,
  doubleQuotedStrings: false,
  identifierQuotes: '"',
});

/** 語法顏色：使用 ui/index.html 定義的 --syn-* 變數，自動跟隨亮色 / 暗色主題 */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.typeName], color: 'var(--syn-type)' },
  { tag: [t.standard(t.name)], color: 'var(--syn-func)' },
  { tag: [t.string], color: 'var(--syn-string)' },
  { tag: [t.special(t.string)], color: 'var(--syn-ident)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator], color: 'var(--syn-operator)' },
]);

const bindMark = Decoration.mark({ class: 'cm-bind' });

/**
 * 標示 `:名稱`、`:1` 綁定變數（規則與 backend/sql-split.js 的 bindNames 相同）：
 * 只看語法樹中的冒號標點，所以字串、註解、`:=`、`::` 都不會被標示。
 * @param {EditorView} view
 */
function findBinds(view) {
  /** @type {RangeSetBuilder<Decoration>} */
  const builder = new RangeSetBuilder();
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Punctuation' || state.sliceDoc(node.from, node.to) !== ':') return;
        if (state.sliceDoc(node.from - 1, node.from) === ':') return;
        const m = /^(?:[A-Za-z][A-Za-z0-9_$#]*|\d+)/.exec(state.sliceDoc(node.to, node.to + 128));
        if (m) builder.add(node.from, node.to + m[0].length, bindMark);
      },
    });
  }
  return builder.finish();
}

const bindVariables = ViewPlugin.fromClass(class {
  /** @param {EditorView} view */
  constructor(view) { this.decorations = findBinds(view); }
  /** @param {import('@codemirror/view').ViewUpdate} u */
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = findBinds(u.view);
  }
}, { decorations: (v) => v.decorations });

const theme = EditorView.theme({
  '.cm-bind': { color: 'var(--syn-bind)', fontWeight: '600' },
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--fg)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--fg-strong)' },
  '.cm-line': { padding: '0 14px 0 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg-strong)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 10px', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'var(--syn-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-muted)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--syn-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--syn-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--syn-match)', outline: '1px solid var(--border-strong)' },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--err)' },
  '.cm-placeholder': { color: 'var(--fg-faint)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elevated)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'var(--syn-match)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--syn-selection)' },
});

/** 搜尋面板等內建文字的中文翻譯 */
const phrases = EditorState.phrases.of({
  Find: '尋找',
  Replace: '取代',
  next: '下一個',
  previous: '上一個',
  all: '全部',
  'match case': '大小寫須相符',
  'by word': '全字相符',
  regexp: '規則運算式',
  replace: '取代',
  'replace all': '全部取代',
  close: '關閉',
  'current match': '目前相符項目',
  'replaced $ matches': '已取代 $ 處',
  'replaced match on line $': '已取代第 $ 行的相符項目',
  'on line': '在第',
  'Go to line': '跳到第幾行',
  go: '前往',
  'Control character': '控制字元',
});

/** Tab：沒有選取時插入兩個空白，有選取時整段縮排 */
const tabKeys = [
  {
    key: 'Tab',
    run: (/** @type {EditorView} */ view) => {
      if (!view.state.selection.main.empty) return indentMore(view);
      view.dispatch(view.state.replaceSelection('  '), { scrollIntoView: true, userEvent: 'input' });
      return true;
    },
  },
  { key: 'Shift-Tab', run: indentLess },
];

/**
 * @typedef {{ placeholder?: string, keys?: Record<string, () => void>, doc?: string }} Options
 * keys：額外的快捷鍵（CodeMirror 格式，例如 'Mod-Enter'），優先於內建快捷鍵
 */

/**
 * @param {HTMLElement} parent
 * @param {Options} [options]
 */
export function create(parent, options = {}) {
  /** @type {Map<string, Set<(e: Event) => void>>} */
  const listeners = new Map();
  const fire = (/** @type {string} */ type, /** @type {Event} */ e) => {
    for (const fn of listeners.get(type) || []) fn(e);
  };

  const extensions = () => [
    keymap.of(Object.entries(options.keys || {}).map(([key, fn]) => ({ key, run: () => { fn(); return true; }, preventDefault: true }))),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    sql({ dialect: OracleDialect }),
    syntaxHighlighting(highlight),
    bindVariables,
    theme,
    phrases,
    options.placeholder ? placeholderExt(options.placeholder) : [],
    keymap.of([...tabKeys, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.updateListener.of((u) => { if (u.docChanged) fire('input', new Event('input')); }),
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.doc || '', extensions: extensions() }),
  });

  const clamp = (/** @type {number} */ n) => Math.max(0, Math.min(Number(n) || 0, view.state.doc.length));

  return {
    view,
    /** 目前內容 */
    get value() { return view.state.doc.toString(); },
    /** 整個換掉內容（同 textarea：不觸發 input 事件；復原紀錄重新開始） */
    set value(text) {
      view.setState(EditorState.create({ doc: String(text ?? ''), extensions: extensions() }));
    },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    /** @param {number} start @param {number} end */
    setSelectionRange(start, end) {
      const anchor = clamp(start);
      const head = clamp(end);
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    },
    /**
     * 以文字取代 start～end（同 textarea.setRangeText，selectMode 只支援 'end' 與預設的 'preserve'）
     * @param {string} text @param {number} [start] @param {number} [end] @param {'end' | 'preserve'} [selectMode]
     */
    setRangeText(text, start, end, selectMode) {
      const from = clamp(start ?? this.selectionStart);
      const to = clamp(end ?? this.selectionEnd);
      const insert = String(text);
      view.dispatch({
        changes: { from, to, insert },
        selection: selectMode === 'end' ? { anchor: from + insert.length } : undefined,
        scrollIntoView: true,
        userEvent: 'input',
      });
    },
    focus() { view.focus(); },
    /** @param {string} type @param {(e: Event) => void} fn */
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      /** @type {Set<(e: Event) => void>} */ (listeners.get(type)).add(fn);
    },
    /** @param {string} type @param {(e: Event) => void} fn */
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    /** @param {Event} e */
    dispatchEvent(e) { fire(e.type, e); return true; },
  };
}
