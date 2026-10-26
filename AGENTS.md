# 給 AI 助理／新接手的人：怎麼快速找到要改的地方

Guitaristic Academy System：小型音樂學校的排課、Google Calendar 同步、WhatsApp 通知、學費與導師薪酬。
純前端（vanilla JS＋Tailwind CDN），**沒有建置步驟**；`serve.js`（Node）只負責送檔和把資料存到本資料夾。
使用方式在 [README.md](README.md)；每項功能的做法與來由在 [docs/developer_notes.md](docs/developer_notes.md)（最詳細，按需要搜尋，不必整份讀）。

## 先記住這幾條
- **`data.js` 絕不改、絕不提交。** 客戶的資料夾是這個 repo 的 git 副本，`data.js` 放著他們的真實名單（本地修改）；提交裡動到它會讓客戶 `git pull` 失敗。要改測試資料改 `demo_data.js`。
- **絕不提交** `local-state.json`、`local-credentials.json`、真實學生／導師／電話／電郵／日曆 ID／OAuth Client ID。測試用假資料（Student 001、Instructor A、電話 00000000）。
- UI 文字與程式註解用繁體中文（香港用語）；commit message 用英文。
- 邏輯放 `lib/*.js`（純函數、UMD、有單元測試），畫面放 `app.js`／`gcal-ui.js`。改了邏輯要補測試。
- 檔案行尾 LF／CRLF 混雜：改檔時保留該檔原本的行尾，不要整檔重排。

## 怎麼跑、怎麼測
- 開頁：雙擊 `serve.cmd`（Windows）／`serve.command`（Mac）→ http://127.0.0.1:5500/ ；資料存本資料夾 `local-state.json`。
- 單元測試：`node --test "tests/*.test.js"`（Node 18+）。
- 冒煙（stub DOM 走完整流程）：`node tests/smoke/smoke.js`，再 `GAC_SMOKE_FILE_MODE=1 node tests/smoke/smoke.js`。
- 改完三種都要跑過；冒煙每段對應一個功能，新功能照最後幾段的寫法加一段。

## 檔案地圖
| 檔 | 內容 |
|---|---|
| `index.html` | 所有頁籤與彈窗的 HTML（Tailwind class），script 載入順序在檔尾 |
| `state.js` | 全域變數：`studentDatabase` `groupClasses` `lessonsByMonth` `sendLog` `appSettings` `tutorsList` `rateOverrides` `actionHistory`；存放層 `gacStorage`／`gacStore` |
| `app.js`（五千多行） | 主程式：載入、總課表、學生／小組表單、狀態／補堂／改期、發送中心、繳費、設定、撤銷。靠函數名搜尋 |
| `gcal-ui.js` | Google Calendar：授權、同步面板、ICS 匯入、推送／拉回 |
| `payroll-advanced.js`、`paysheet-ui.js` | 高級薪酬頁、糧單 Excel／PDF 下載 |
| `lib/schedule.js` | 生成課表、合併、撞堂、停課、小組、學號容錯、舊寫法小組轉換、名單→課堂同步 |
| `lib/lessonState.js` | 課堂狀態機：出席／請假／缺席、補堂（含 15 分鐘分段）、改期、待補堂池 |
| `lib/payroll.js`、`lib/analytics.js` | 薪酬與統計（分段補堂按比例） |
| `lib/sendlog.js` | 發送中心條目：學費單、請假／補堂／改期確認、催繳、收款確認、繳費紀錄 |
| `lib/gcal.js`、`lib/ics.js` | Calendar 對帳（標籤配對＋按內容配對）、REST 客戶端、ICS 解析／輸出 |
| `lib/rates.js`、`art-rate-data.js` | 費率表、查價、表單連動下拉 |
| `lib/storage.js` | 存放層（localStorage／檔案）、設定預設值與遷移、備份、導師名單推導、帳號資料另存 |
| `lib/history.js` | 撤銷／還原快照 |
| `lib/xlsx.js`、`lib/paysheet.js` | 自寫的 xlsx／pdf 輸出、糧單格子模型 |
| `serve.js` | 本地伺服器：注入 `local-state.json`、`PUT /__state` 寫回、帳號資料另存 `local-credentials.json` |
| `data.js`／`demo_data.js` | 名單（客戶的真實名單只在他們本地）／演示名單 |
| `tests/` | 單元測試（node:test）、冒煙 `tests/smoke/smoke.js` |
| `docs/diagnose-console.js` | 貼進瀏覽器 Console 的現場診斷（查價路徑、課堂 vs 名單、學號寫法） |

## 資料模型（存放 key 見 `lib/storage.js` KEYS）
- 學生 `{ id, name, phone, email, type('一對一'；空＝只上小組), program, level, duration, tutor, weekday(null＝沒有個別課), time, effectiveMonth/futureWeekday/futureTime(預定改時段), inactivePeriods:[{from,resume}] }`。
  **學生 `id` 是主鍵**，課堂、學費單、小組成員都用它精確比對；只有認 Calendar 標題、表單查重、搜尋用容錯鍵（032＝32，`GACSchedule.studentIdKey`）。
  導師級別**不存在學生上**，一律看 `tutorsList` 的 `tier`。
- 小組班 `{ id:'G01', name, program, level, duration, tutor, weekday, time, memberIds:[], startMonth? }`。
- 課堂 `lessonsByMonth['YYYY-MM'] = [lesson]`：`lessonId = 學號-YYYYMMDD-HHMM`；
  `studentId, tutor, tutorLevel(生成時的等級快照), program, level, classType, date, time, duration, status(SCHEDULED|ATTENDED|LEAVE|NOSHOW), leaveType(L|SL|TL), isMakeup, originLessonId, makeupLessonIds[], hostLessonId/baseDuration(分段補堂), groupId, gcalEventId, changedAt`。
- 發送中心 `sendLog[key]`：`TUITION:學號:月份`（含繳費欄位 `paidAmount/payMethod/payDate`）、`LEAVE_CONFIRM:lessonId`、`MAKEUP_CONFIRM:lessonId`、`MOVE_CONFIRM:lessonId`、`PAY_REMIND:…`、`RECEIPT:…`、`CUSTOM:…`；`status` TODO|SENT。
- 設定 `appSettings`（預設值 `GACStorage.DEFAULT_SETTINGS`）：`gcalClientId`、`gcalWrite`（唯讀／寫入）、訊息模板 `tpl*`、`tutorCalendarMemo`／`tutorTierMemo`（按導師名字記住）。
- 導師 `tutorsList:[{ name, tier('資深導師'|'普通導師'), calendarId }]`；費率覆寫 `rateOverrides:{ 'tier|program|level|classType|duration': rate }`。

## 功能 → 進入點
| 想改 | 從這裡開始 |
|---|---|
| 生成／重新生成某月課表 | `app.js generateMasterSchedule` → `lib/schedule.js generateMonthLessons`／`generateGroupMonthLessons`／`mergeMonthLessons` |
| 出席／請假／缺席、補堂、分段補堂 | `app.js markLessonStatus`／`submitMakeup`／`openMakeupParts` → `lib/lessonState.js markStatus`／`scheduleMakeup`／`remainingMinutes` |
| 改期（單堂／全組） | `app.js openMoveModal` → `lib/lessonState.js moveLessonDateTime` |
| 學生／小組表單、費率連動 | `app.js openStudentModal`／`saveStudentFromModal`、`openGroupModal`／`saveGroupModal`、`renderStudentFeeSelects` |
| 停課／復課 | `lib/schedule.js` 的 `inactivePeriods` 系列；`app.js offerScheduleSyncAfterStatusChange` |
| 導師等級／費率／名單改了往下推 | `app.js propagateRosterChanges`（→ `GACSchedule.syncLessonsWithRoster`、`refreshTuition`）；學費單規則 `lib/sendlog.js refreshSentTuition` |
| 學費單與各種訊息文字 | `app.js tuitionMsgFor`／`lessonVars`／`msgTpl`；模板預設在 `lib/storage.js DEFAULT_SETTINGS` |
| 發送中心、WhatsApp | `app.js renderSendCenter`／`sendEntryCard`／`sendWhatsApp`；派生的催繳／收款確認 `lib/sendlog.js syncDerived` |
| 繳費 | `app.js renderPaymentTab`；`lib/sendlog.js setPayment`／`paymentStatus` |
| 薪酬、糧單 | `payroll-advanced.js rateForLesson`／`advancedRefresh`；`lib/payroll.js monthPayroll`；`lib/paysheet.js` |
| Google Calendar 同步 | `gcal-ui.js openGcalSync`（面板；搜尋 `gcalSyncPlan`）；`lib/gcal.js reconcile`／`reconcileByContent`；唯讀 ICS `lib/ics.js` |
| 撤銷／還原 | `app.js pushHistory`／`undoLastAction`；`lib/history.js` |
| 存放、備份、帳號資料 | `lib/storage.js`、`serve.js` |

## 改東西的套路
1. 先在 `lib` 補純函數與單元測試，再接到 `app.js` 的畫面；畫面上的提示用 `showToast`，少用 `alert`／`confirm`（用戶不喜歡彈窗）。
2. 課堂的日期、時間、狀態、補堂鏈接只由狀態機與「生成」改；其他地方只能刷新顯示／計價欄位。
3. 跑三種測試；冒煙照既有段落的寫法加一段檢查。
4. 不確定舊資料長怎樣：把 `docs/diagnose-console.js` 貼進瀏覽器 Console 看。
5. 改了行為要同步 `README.md`（使用手冊，給職員看）與 `docs/developer_notes.md`（一條 bullet：日期、誰要的、做法）。
