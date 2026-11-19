# Oracle SQL 工具

ToolDock 擴充：連線 Oracle 資料庫並執行 SQL 指令，查詢結果以表格顯示。

使用 [node-oracledb](https://node-oracledb.readthedocs.io/) 的 **Thin 模式**，純 JavaScript 實作，**不需要安裝 Oracle Instant Client**。同一個套件可以在 macOS、Windows、Linux 上使用。

## 功能

- **連線設定**：
  - 可以填主機、連接埠、服務名稱，或直接輸入連線字串（Easy Connect 或 `(DESCRIPTION=...)`）。
  - 可以儲存多組連線設定。
  - 密碼不會存到磁碟，每次連線時重新輸入。
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
