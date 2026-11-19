# Oracle SQL 工具

ToolDock 擴充：連線 Oracle 資料庫並執行 SQL 指令，查詢結果以表格顯示。

使用 [node-oracledb](https://node-oracledb.readthedocs.io/) 的 **Thin 模式**，純 JavaScript 實作，**不需要安裝 Oracle Instant Client**。同一個套件可以在 macOS、Windows、Linux 上使用。

## 功能

- **連線設定**：
  - 可以填主機、連接埠、服務名稱，或直接輸入連線字串（Easy Connect 或 `(DESCRIPTION=...)`）。
  - 可以儲存多組連線設定。
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
- **執行 SQL**：
  - `⌘/Ctrl + Enter` 執行游標所在的那一句，或目前選取的範圍。
  - `⌘/Ctrl + Shift + Enter` 依序執行全部指令，遇到錯誤就停止。
  - 一般 SQL 以行尾的 `;` 結束，PL/SQL 區塊以單獨一行的 `/` 結束（與 SQL\*Plus 相同）。
- **查詢結果**：以表格顯示，並標示欄位型別、`NULL` 值和執行時間。超過列數上限時會截斷並提示。可以匯出 CSV（UTF-8 BOM，Excel 可直接開啟）。
- **PL/SQL**：自動讀取並顯示 `DBMS_OUTPUT` 的輸出。
- **錯誤**：顯示 `ORA-xxxxx` 錯誤代碼與訊息。
- **交易**：
  - 預設為手動提交，畫面上有 Commit／Rollback 按鈕，有未提交的交易時會提示。
  - 中斷連線前會詢問要提交還是回滾。
  - 平台結束時，會自動回滾未提交的交易。
- **其他**：
  - 可以中途停止正在執行的長時間查詢。
  - 保留最近 50 筆執行紀錄。
  - 連線時，狀態列會顯示連線資訊。

## 設定

| 設定 | 預設值 | 說明 |
|---|---|---|
| `oracleSql.maxRows` | 500 | 查詢結果最多取回的列數 |
| `oracleSql.callTimeoutSeconds` | 60 | 單一指令的執行逾時 |
| `oracleSql.autoCommit` | false | 自動提交 DML |

## 限制

- Thin 模式不支援部分進階功能，例如 Oracle Wallet 以外的外部驗證、Advanced Queuing。詳見 node-oracledb 文件中的 Thin 與 Thick 模式比較。
- 停止執行要等資料庫回應中斷請求。像 `DBMS_SESSION.SLEEP` 這類伺服器端的等待，要到等待結束後才會中止。

## 開發

```bash
npm install
npm run dev      # 以開發模式啟動 ToolDock
npm run debug    # 同上，並開啟後端偵錯埠 9229
npm run pack     # 打包成 dist/*.tbx
```

推送 `v*` tag 後，GitHub Actions 會自動打包、簽章並建立 Release，流程見 `.github/workflows/release.yml`。
