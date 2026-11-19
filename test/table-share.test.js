'use strict';
/** 編輯器查詢結果 → tooldock.table（backend/table-share.js） */
const test = require('node:test');
const assert = require('node:assert/strict');
const { toTable } = require('../backend/table-share.js');
const { isoLocal } = require('../backend/exchange-exec.js');

test('依 xtype 轉成〈6.4〉的值', () => {
  const columns = [
    { name: 'ID', type: 'NUMBER', xtype: 'int' },
    { name: 'AMT', type: 'NUMBER', xtype: 'decimal' },
    { name: 'NAME', type: 'VARCHAR2', xtype: 'string' },
    { name: 'AT', type: 'DATE', xtype: 'datetime' },
    { name: 'RAWV', type: 'RAW', xtype: 'binary' },
    { name: 'DOC', type: 'JSON', xtype: 'json' },
    { name: 'F', type: 'BINARY_DOUBLE', xtype: 'float' },
  ];
  const t = toTable(columns, [
    [1, 0.5, '王小明', '2026-11-19 08:05:09', '0x0A0B', '{"a":1}', 1.25],
    [null, -12.3, null, null, null, 'not json', null],
  ]);
  assert.deepEqual(t.columns, [
    { name: 'ID', type: 'int' }, { name: 'AMT', type: 'decimal' }, { name: 'NAME', type: 'string' },
    { name: 'AT', type: 'datetime' }, { name: 'RAWV', type: 'string' }, { name: 'DOC', type: 'json' }, { name: 'F', type: 'float' },
  ]);
  assert.deepEqual(t.rows[0], [1, '0.5', '王小明', isoLocal(new Date(2026, 10, 19, 8, 5, 9)), '0x0A0B', { a: 1 }, 1.25]);
  assert.deepEqual(t.rows[1], [null, '-12.3', null, null, null, 'not json', null]);
});

test('沒有 xtype 的欄位當成字串', () => {
  const t = toTable([{ name: 'X' }], [[12], [{ a: 1 }]]);
  assert.deepEqual(t, { columns: [{ name: 'X', type: 'string' }], rows: [['12'], ['{"a":1}']] });
});
