// 把 src-ui/sql-editor.js（CodeMirror 6）打包成 ui/vendor/sql-editor.js，畫面以全域 SqlEditor 使用。
// 修改 src-ui/ 或升級 @codemirror/* 後執行：npm run build:editor
import { build } from 'esbuild';

build({
  entryPoints: ['src-ui/sql-editor.js'],
  outfile: 'ui/vendor/sql-editor.js',
  bundle: true,
  format: 'iife',
  globalName: 'SqlEditor',
  minify: true,
  target: 'chrome120',
  legalComments: 'eof',
  banner: { js: '/* 由 scripts/build-editor.mjs 產生，請勿直接修改。原始碼：src-ui/sql-editor.js */' },
  logLevel: 'info',
}).catch(() => process.exit(1));
