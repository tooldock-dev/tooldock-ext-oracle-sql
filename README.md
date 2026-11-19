# Oracle SQL 工具

ToolDock 擴充：連線 Oracle 資料庫並執行 SQL 指令，查詢結果以表格顯示。

使用 [node-oracledb](https://node-oracledb.readthedocs.io/) 的 **Thin 模式**，純 JavaScript 實作，**不需要安裝 Oracle Instant Client**。同一個套件可以在 macOS、Windows、Linux 上使用。

## 功能

- **連線設定**：
  - 可以填主機、連接埠、服務名稱，或直接輸入連線字串（Easy Connect 或 `(DESCRIPTION=...)`）。
  - 可以儲存多組連線設定。
- **多連線**：
  - 最多可同時開啟 5 條連線（每組連線設定一條），切換環境不用先中斷再重連。
  - 已開啟的連線以分頁顯示在工具列下方，點分頁或按 `⌘/Ctrl + 1`～`5` 切換；按分頁上的 × 或滑鼠中鍵中斷該連線。
  - 每條連線各自保留編輯器內容、查詢結果、資料表瀏覽，以及交易狀態（Commit／Rollback 只作用在目前的連線）。編輯器內容會依連線設定保存，下次連線時還原。
  - 不同連線可以同時執行指令：一條在跑長查詢時，可以切到另一條繼續工作，結果會留在原本的連線。
  - 分頁上的圓點：綠色＝已連線、黃色＝有未提交的交易、藍色閃爍＝執行中。
  - 關閉工具分頁不會中斷連線（manifest 設定 `keepAlive`，ToolDock 1.3.0 起不會被自動回收），點狀態列即可回到工具繼續使用。
- **記住密碼**（需要 ToolDock 1.2.0 以上）：
  - 連線時勾選「記住密碼」，密碼會透過平台的 `ctx.secrets` 存放：用作業系統鑰匙圈保護的金鑰加密，磁碟上只有密文。
  - 記住的密碼失效時（例如密碼已變更），會改為請你重新輸入。
  - 可以在連線設定中清除記住的密碼；刪除連線設定或移除擴充時，也會一併清除。
  - 舊版平台不提供這個選項，密碼只留在記憶體。
- **參數（綁定變數）**：
  - SQL 裡的 `:名稱`（例如 `WHERE dept = :dept`）在執行前會跳出對話框，讓你輸入值，型別可選文字、數字、日期或 NULL。
  - 參數以真正的綁定變數傳給資料庫，不是字串替換，所以不會有 SQL Injection 的問題。
  - 會記住上次輸入的值。
  - 字串、註解、`:=` 指派，以及觸發程序裡的 `:NEW`、`:OLD`，都不會被當成參數。
- **資料表瀏覽**：
  - 側欄列出目前 schema（也可以切換到其他有權限的 schema）的資料表和檢視表，並顯示筆數與註解，可以篩選。
  - 點擊顯示欄位結構：型別、主鍵、NOT NULL、欄位註解。
  - 雙擊會查詢前 100 列；也可以把 SELECT 範本或名稱插入編輯器。
- **SQL 保存**：
  - 用 `⌘/Ctrl + S` 或「儲存目前 SQL」把編輯器內容存成一則有名稱的 SQL，可以搜尋、載入、刪除；同名會覆寫。
  - 可以開啟 `.sql` 檔，或另存為 `.sql` 檔。
- **編輯器**：
  - 語法高亮：關鍵字、資料型別、常用內建函式、字串（含 `q'[...]'`）、雙引號識別字、數字、註解、`:參數` 各有顏色，跟隨亮色／暗色主題。
  - 行號、目前行標示、括號配對；`⌘/Ctrl + F` 尋找與取代。
  - `Tab` 插入兩個空白，選取多行時整段縮排；`Shift + Tab` 減少縮排。
- **排版**：
  - 按「排版」或 `Shift + Alt + F`：有選取時只排版選取範圍，沒有選取時排版全部。按 `⌘/Ctrl + Z` 可以一次復原。
  - 一句一句排版，關鍵字、型別、函式轉成大寫，名稱維持原樣；`:參數`、字串、註解不會被改動。
  - PL/SQL 區塊（`BEGIN`、`DECLARE`、`CREATE PROCEDURE`…）和單獨一行的 `/` 原樣保留，不排版。
  - 無法解析的指令會保持原樣，並在狀態列提示。
- **執行 SQL**：
  - `⌘/Ctrl + Enter` 執行游標所在的那一句，或目前選取的範圍。
  - `⌘/Ctrl + Shift + Enter` 依序執行全部指令，遇到錯誤就停止。
  - 一般 SQL 以行尾的 `;` 結束，PL/SQL 區塊以單獨一行的 `/` 結束（與 SQL\*Plus 相同）。
- **查詢結果**：以表格顯示，並標示欄位型別、`NULL` 值和執行時間。超過列數上限時會截斷並提示。可以匯出 CSV（UTF-8 BOM，Excel 可直接開啟）。
- **PL/SQL**：自動讀取並顯示 `DBMS_OUTPUT` 的輸出。
- **錯誤**：顯示 `ORA-xxxxx` 錯誤代碼與訊息。
- **交易**：
  - 預設為手動提交，畫面上有 Commit／Rollback 按鈕，有未提交的交易時會提示。
  - 中斷連線前會詢問要提交還是回滾（每條連線各自詢問）。
  - 平台結束時，會自動回滾未提交的交易。
- **其他**：
  - 可以中途停止正在執行的長時間查詢。
  - 保留最近 50 筆執行紀錄。
  - 狀態列會顯示連線資訊；多條連線時顯示連線數，有任何一條未提交時加上 ●。命令面板的「中斷全部連線」會關閉所有連線（未提交的交易會回滾）。

## 接收其他工具分享的 SQL（需要 ToolDock 1.4.0 以上）

其他擴充可以用 ToolDock 的資料交換，把要執行的 SQL 打包成 `tooldock.sql` 交給這個工具。也可以從 `.tdx` 交換檔匯入：在側欄「匯入」按「開啟 .tdx」，或把檔案拖進 ToolDock 視窗。格式與接收端的規則見 ToolDock 的 `docs/EXCHANGE.md`〈6〉。

收到後會切到預覽畫面，**經你確認後才會執行**：

- **預覽**：
  - 顯示標題、來源、目標、每個語句的 SQL 與分類（查詢／DML），以及參數值和參數列。
  - 有查詢時會註明結果會傳回給哪個工具。
  - 標示為「匯入時填寫」的參數，在這裡輸入。
- **選擇連線**：交換包只帶邏輯目標（例如「人事資料庫」），不帶帳號密碼。實際連線由你從連線設定中選擇。
  - 下次同一個工具送來同一個目標時，會預先選好上次的連線。
  - 沒有記住密碼的連線，會請你輸入密碼。這個密碼只用在這次匯入，不會儲存。
- **專用連線**：試跑和執行都會另外開一條連線，用完就關閉，不會影響編輯器裡正在使用的連線和它未提交的交易。
- **試跑**：含有寫入的交換包必須先試跑，才能執行。
  - 試跑會實際執行，再 ROLLBACK，並顯示預計影響的筆數和查詢結果的前幾筆。
  - 連線或參數改變後要重新試跑。
  - 序號（SEQUENCE／IDENTITY）會前進，觸發程序中的自主交易也不會回復。
- **交易**：
  - `all`（預設）：全部成功才 COMMIT。
  - `statement`：每個語句各自 COMMIT。
  - `none`：每次執行都直接提交。
- **檢查條件**：影響筆數超過 `expect` 的上限時會回復，並回報失敗；這時不回傳任何查詢結果。
- **查詢結果**：查詢結果會傳回給產生端，例如交給報表產生器做成報表。
  - 預設每次最多回傳 10,000 列，可用設定調整；整包不超過 10 MB。
  - `NUMBER` 以字串傳回，不會失去精度。`DATE`／`TIMESTAMP` 以帶時區的 ISO 8601 傳回。
  - 執行完成後，每個查詢結果都可以用「⇄ 分享結果」以 `tooldock.table` 分享出去，例如交給報表產生器做成報表，或交給資料轉換工具轉成 CSV / JSON；有多個工具可以接收時，ToolDock 會讓你選擇。
  - 從 `.tdx` 檔匯入時沒有產生端，結果只會顯示在畫面上，要交給其他工具請用「⇄ 分享結果」。
- **安全限制**：
  - **DDL 一律拒絕**：Oracle 的 DDL 會隱含提交，無法回復。
  - PL/SQL 區塊、`CALL`、`GRANT` 等語句一律拒絕。
  - `RETURNING … INTO` 需要輸出參數，不支援；需要新產生的值時，請在同一個交易中用查詢讀回。
  - 交換包的方言不是 `oracle` 或 `generic` 時，會顯示警告。
- **防止重複**：同一個交換包（相同 `id`）再次匯入時會警告，要再勾選確認才能執行。
- **稽核紀錄**：側欄「匯入」→「稽核紀錄」，保留最近 200 筆。每筆記錄每次執行、拒絕或取消的時間、交換包 id、來源、實際連線，以及每個語句的影響筆數與結果。

試用：在測試用的 schema 執行 `samples/demo-schema.sql` 建立示範資料表，再匯入 `samples/overtime.tdx`。

產生端的寫法：

```js
const pkg = ctx.exchange.create('tooldock.sql', {
  dialect: 'oracle',
  target: { name: '人事資料庫' },
  params: { dept: { type: 'string', from: 'prompt', label: '部門', required: true } },
  statements: [{ id: 'emps', sql: 'SELECT emp_no, name FROM employees WHERE dept = :dept', maxRows: 100 }],
}, { title: '查詢部門員工' });
const r = await ctx.exchange.share(pkg, { preferReceiver: 'oracle-sql' });
if (r.status === 'delivered' && r.result.status === 'imported') console.log(r.result.data.statements[0].results[0].rows);
```

## 設定

| 設定 | 預設值 | 說明 |
|---|---|---|
| `oracleSql.maxRows` | 500 | 查詢結果最多取回的列數 |
| `oracleSql.callTimeoutSeconds` | 60 | 單一指令的執行逾時（也套用在交換包的試跑與執行） |
| `oracleSql.autoCommit` | false | 自動提交 DML |
| `oracleSql.exchangeMaxRows` | 10000 | 其他工具分享的 SQL 沒有指定 `maxRows` 時，每次查詢最多回傳的列數（上限 100,000） |

## 限制

- Thin 模式不支援部分進階功能，例如 Oracle Wallet 以外的外部驗證、Advanced Queuing。詳見 node-oracledb 文件中的 Thin 與 Thick 模式比較。
- 停止執行要等資料庫回應中斷請求。像 `DBMS_SESSION.SLEEP` 這類伺服器端的等待，要到等待結束後才會中止。

## 開發

```bash
npm install
npm run dev      # 以開發模式啟動 ToolDock
npm run debug    # 同上，並開啟後端偵錯埠 9229
npm run pack     # 打包成 dist/*.tbx
npm test         # 單元測試與接收端往返測試（不需要資料庫的部分）
npm run build:editor  # 修改 src-ui/ 或升級 @codemirror/*、sql-formatter 後，重新產生 ui/vendor/sql-editor.js
```

編輯器（CodeMirror 6）和排版（sql-formatter）的原始碼在 `src-ui/`，用 esbuild 打包成 `ui/vendor/sql-editor.js`。打包結果有提交到 repo，打包 `.tbx` 時不需要先建置；`src-ui/` 和 `scripts/` 不會放進 `.tbx`。

| 測試檔 | 內容 |
|---|---|
| `test/sql-format.test.js` | SQL 排版：綁定變數、註解、PL/SQL 區塊與 `/` 保留，無法解析時保持原樣 |
| `test/sql-exchange.test.js` | `tooldock.sql` 的解析、分類、型別轉換 |
| `test/exchange.test.js` | 接收端往返：用假的 `ctx` 送交換包給 `backend/exchange.js`，檢查產生端拿到的 `ImportResult`。<br>不需要資料庫：拒絕、取消、擴充停止、不允許的語句、未試跑、缺密碼。<br>需要資料庫：執行成功的結果、從檔案匯入時不回傳結果、分享查詢結果（`tooldock.table`）、執行失敗、重複匯入 |
| `test/oracle.test.js` | 需要資料庫：交易、試跑、`expect`、`maxRows` 與型別轉換 |

需要資料庫的測試會連到真正的 Oracle，沒有設定下面的環境變數時會略過。測試會建立名稱以 `TDX_T_`、`TDX_X_` 開頭的暫時資料表，結束時刪除：

```bash
ORACLE_TEST_CONNECT=localhost:1521/FREEPDB1 ORACLE_TEST_USER=tdx_test ORACLE_TEST_PASSWORD=… npm test
```

推送 `v*` tag 後，GitHub Actions 會自動打包、簽章並建立 Release，流程見 `.github/workflows/release.yml`。
