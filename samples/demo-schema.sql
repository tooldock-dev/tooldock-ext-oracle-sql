-- 範例交換檔 samples/overtime.tdx 使用的示範資料表
-- 用 Oracle SQL 工具連到一個測試用的 schema，貼上後按「▶▶ 執行全部」，再按 Commit。
-- 不需要時執行最下面的 DROP。

CREATE TABLE employees (
  emp_no  VARCHAR2(10) PRIMARY KEY,
  name    NVARCHAR2(50) NOT NULL,
  dept    NVARCHAR2(30),
  salary  NUMBER(10, 2),
  hired   DATE
);

CREATE TABLE overtime (
  emp_no      VARCHAR2(10) NOT NULL,
  month       VARCHAR2(7) NOT NULL,
  hours       NUMBER(6, 2) DEFAULT 0 NOT NULL,
  approved_by NVARCHAR2(50),
  updated_at  TIMESTAMP WITH TIME ZONE,
  CONSTRAINT overtime_pk PRIMARY KEY (emp_no, month)
);

CREATE TABLE overtime_log (
  id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month      VARCHAR2(7),
  approver   NVARCHAR2(50),
  created_at TIMESTAMP WITH TIME ZONE
);

INSERT INTO employees VALUES ('A001', N'王小明', N'資訊部', 52000.50, DATE '2021-03-01');
INSERT INTO employees VALUES ('A002', N'李小華', N'資訊部', 48000, DATE '2022-07-15');
INSERT INTO employees VALUES ('A003', N'陳大同', N'人資部', 61000.75, DATE '2019-11-20');
INSERT INTO overtime (emp_no, month, hours) VALUES ('A001', '2026-11', 0);
INSERT INTO overtime (emp_no, month, hours) VALUES ('A002', '2026-11', 0);
INSERT INTO overtime (emp_no, month, hours) VALUES ('A003', '2026-11', 4);

-- 清除：
-- DROP TABLE overtime_log PURGE;
-- DROP TABLE overtime PURGE;
-- DROP TABLE employees PURGE;
