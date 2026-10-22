// 現場診斷：學費查價與課表時間為何「對不上」。
// 用法：在系統頁面按 F12 → Console，把整個檔案貼進去按 Enter。只讀不改任何資料，任何版本（2026-09-19 之後）都能跑。
// 印出幾張表：版本線索、導師等級 vs 學生記錄上的導師級別、每位學生的查價路徑、已生成課堂 vs 目前名單的時間／導師／時長、
// 學費條目 vs 現在重算的金額、學號／姓名撞號。最後回傳摘要物件；要帶走可按 copy(JSON.stringify(gacDiag))。
// 之後要看某一位：gacWhy('0032')——印出這位學生的查價鏈與各月課堂。
(function () {
    'use strict';
    var fn = function (name) { try { return typeof window[name] === 'function'; } catch (e) { return false; } };
    var lib = function (obj, name) { try { return typeof window[obj] === 'object' && typeof window[obj][name] === 'function'; } catch (e) { return false; } };
    var val = function (name) { try { return (0, eval)(name); } catch (e) { return undefined; } };
    var students = val('studentDatabase') || [], groups = val('groupClasses') || [], tutors = val('tutorsList') || [];
    var byMonth = val('lessonsByMonth') || {}, log = val('sendLog') || {}, overrides = val('rateOverrides') || {};
    var table = val('rateTable') || [], grades = val('GRADE_OPTIONS') || [];
    var idKey = lib('GACSchedule', 'studentIdKey') ? GACSchedule.studentIdKey : function (id) { return String(id == null ? '' : id).trim().toUpperCase(); };
    var tierOf = fn('tutorTier') ? tutorTier : function () { return null; };
    var gradeOf = fn('advancedGrade') ? advancedGrade : function (s) { return s.level; };
    var weekdayOf = function (d) { var p = String(d).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).getDay(); };
    var WD = ['日', '一', '二', '三', '四', '五', '六'];
    var out = { version: [], tutors: [], tierMismatch: [], pricing: [], lessonMismatch: [], tuition: [], idClash: [], nameClash: [], notes: [] };

    // ===== 0. 版本線索（功能出現的日期）=====
    [['2026-10-13 新增學生自動學號', lib('GACSchedule', 'nextStudentId')],
     ['2026-10-04 帳號資料另存、啟動不彈窗', fn('startFreshFileState')],
     ['2026-10-03 分段補堂（15 分鐘）', lib('GACLessonState', 'normalizeLessons')],
     ['2026-10-02 小組一律小組班', lib('GACSchedule', 'planLegacyGroups')],
     ['2026-10-01 在學／停課狀態', lib('GACSchedule', 'currentInactivePeriod')],
     ['2026-09-29 學號容錯（032＝32）', lib('GACSchedule', 'studentIdKey')],
     ['2026-09-25 資料存本資料夾', lib('GACStorage', 'pickStorage')]
    ].forEach(function (m) { out.version.push({ 功能: m[0], 有: m[1] ? '✔' : '✘' }); });
    var newest = out.version.filter(function (v) { return v.有 === '✔'; })[0];
    out.notes.push('程式版本至少到 ' + (newest ? newest.功能.slice(0, 10) : '2026-09-19 之前'));
    var store = val('gacStorage');
    out.notes.push('資料存放：' + (store && store.isFileBacked ? '本資料夾 local-state.json' : '瀏覽器 localStorage'));

    // ===== 1. 導師名單（設定頁的定價等級）=====
    tutors.forEach(function (t) {
        out.tutors.push({ 導師: t.name, 設定頁等級: t.tier, 日曆ID: t.calendarId ? '有' : '', 學生數: students.filter(function (s) { return s.tutor === t.name; }).length });
    });
    students.forEach(function (s) { if (s.tutor && !tutors.some(function (t) { return t.name === s.tutor; })) out.notes.push('學生 ' + s.id + ' 的導師「' + s.tutor + '」不在導師名單'); });

    // ===== 2. 學生記錄上的導師級別 vs 設定頁 =====
    // 查價用的級別：學生記錄自帶 tutorLevel（在學生表單存過就有）→ 否則看導師名單。記錄上有值就不跟著設定頁改。
    students.forEach(function (s) {
        if (s.weekday === null || s.weekday === undefined || s.weekday === '') return;
        var listTier = tierOf(s.tutor);
        var used = s.tutorLevel || listTier || '(回退)';
        if (s.tutorLevel && listTier && s.tutorLevel !== listTier) {
            out.tierMismatch.push({ 學號: s.id, 導師: s.tutor, 設定頁等級: listTier, 學生記錄上的級別: s.tutorLevel, 查價用: used });
        }
    });
    groups.forEach(function (g) {
        var listTier = tierOf(g.tutor);
        if (g.tutorLevel && listTier && g.tutorLevel !== listTier) out.tierMismatch.push({ 學號: '小組 ' + g.id, 導師: g.tutor, 設定頁等級: listTier, 學生記錄上的級別: g.tutorLevel, 查價用: g.tutorLevel });
    });

    // ===== 3. 每位學生的查價路徑 =====
    var exact = function (tier, s) {
        return lib('GACRates', 'findRate') ? GACRates.findRate(table, { tutorLevel: tier, program: s.program, level: s.level, type: s.type, duration: s.duration }) : null;
    };
    var usedRate = function (s) {
        return fn('rateForLesson') ? rateForLesson({ program: s.program, level: s.level, classType: s.type, duration: s.duration, tutor: s.tutor, tutorLevel: s.tutorLevel }) : null;
    };
    students.forEach(function (s) {
        if (s.weekday === null || s.weekday === undefined || s.weekday === '') return;
        var tier = s.tutorLevel || tierOf(s.tutor) || '';
        var other = tier === '資深導師' ? '普通導師' : '資深導師';
        var ex = exact(tier, s), used = usedRate(s);
        var why = [];
        if (ex === null) why.push('費率表沒有這個組合 → 系統用估算值');
        if (grades.length && grades.indexOf(s.level) === -1) why.push('級別「' + s.level + '」不在選項 → 按 ' + gradeOf(s) + ' 查');
        if (!s.tutorLevel) why.push('記錄沒有導師級別 → 跟設定頁');
        if (/小組/.test(String(s.type || ''))) why.push('常規課寫成小組形式（舊寫法）');
        out.pricing.push({ 學號: s.id, 導師: s.tutor, 級別用: tier, 課程: s.program, 級別: s.level, 形式: s.type, 時長: s.duration,
            每堂_系統用: used, 費率表_同級別: ex, 費率表_另一級別: exact(other, s), 說明: why.join('；') });
    });

    // ===== 4. 已生成的課 vs 目前的名單（時間／星期／導師／時長／導師級別）=====
    var sById = {}; students.forEach(function (s) { sById[s.id] = s; });
    var gById = {}; groups.forEach(function (g) { gById[g.id] = g; });
    Object.keys(byMonth).sort().forEach(function (m) {
        var agg = {};
        (byMonth[m] || []).forEach(function (l) {
            if (l.isMakeup) return;
            var s = sById[l.studentId];
            if (!s) { out.notes.push(m + '：課堂 ' + l.lessonId + ' 的學號不在名單（已刪？）'); return; }
            var exp;
            if (l.groupId) { var g = gById[l.groupId]; if (!g) { out.notes.push(m + '：課堂 ' + l.lessonId + ' 的小組 ' + l.groupId + ' 已不存在'); return; } exp = { time: g.time, weekday: Number(g.weekday), tutor: g.tutor, duration: Number(g.duration), tutorLevel: g.tutorLevel || tierOf(g.tutor) || '' }; }
            else { var sc = lib('GACSchedule', 'getScheduleForMonth') ? GACSchedule.getScheduleForMonth(s, m) : { weekday: s.weekday, time: s.time }; exp = { time: sc.time, weekday: Number(sc.weekday), tutor: s.tutor, duration: Number(s.duration), tutorLevel: s.tutorLevel || tierOf(s.tutor) || '' }; }
            var diffs = [];
            if (l.time !== exp.time) diffs.push('時間 ' + l.time + '≠' + exp.time);
            if (weekdayOf(l.date) !== exp.weekday) diffs.push('星期' + WD[weekdayOf(l.date)] + '≠星期' + WD[exp.weekday]);
            if (l.tutor !== exp.tutor) diffs.push('導師 ' + l.tutor + '≠' + exp.tutor);
            if (Number(l.duration) !== exp.duration) diffs.push('時長 ' + l.duration + '≠' + exp.duration);
            if ((l.tutorLevel || tierOf(l.tutor) || '') !== exp.tutorLevel) diffs.push('級別 ' + (l.tutorLevel || '(空)') + '≠' + exp.tutorLevel);
            if (!diffs.length) return;
            var k = l.studentId + '|' + diffs.join('，');
            if (!agg[k]) agg[k] = { 月份: m, 學號: l.studentId, 差異: diffs.join('，'), 堂數: 0, 狀態: {}, 例子: l.date + ' ' + l.time + (l.gcalMovedFrom ? '（本地改期過）' : '') };
            agg[k].堂數++; agg[k].狀態[l.status] = (agg[k].狀態[l.status] || 0) + 1;
        });
        Object.keys(agg).forEach(function (k) { var a = agg[k]; a.狀態 = Object.keys(a.狀態).map(function (st) { return st + '×' + a.狀態[st]; }).join(' '); out.lessonMismatch.push(a); });
    });

    // ===== 5. 學費條目 vs 現在重算 =====
    Object.keys(log).forEach(function (k) {
        var e = log[k];
        if (!e || e.type !== 'TUITION') return;
        var mine = (byMonth[e.month] || []).filter(function (l) { return l.studentId === e.studentId && !l.isMakeup; });
        var now = fn('rateForLesson') ? mine.reduce(function (sum, l) { return sum + (Number(rateForLesson(l)) || 0); }, 0) : null;
        if (now === null || now === Number(e.amount)) return;
        out.tuition.push({ 月份: e.month, 學號: e.studentId, 條目金額: e.amount, 現在重算: now, 堂數: mine.length, 狀態: e.status, 手改過: e.amountEdited ? '是' : '', 已收: e.paidAmount || 0 });
    });

    // ===== 6. 學號／姓名撞號（Calendar 按標題認人會混）=====
    var keys = {};
    students.forEach(function (s) { var k = idKey(s.id); (keys[k] = keys[k] || []).push(s.id); });
    Object.keys(keys).forEach(function (k) { if (keys[k].length > 1) out.idClash.push({ 比對鍵: k, 學號: keys[k].join('、') }); });
    students.forEach(function (a) { students.forEach(function (b) {
        if (a === b) return;
        var na = String(a.name || '').trim().toLowerCase(), nb = String(b.name || '').trim().toLowerCase();
        if (na.length >= 2 && (na === nb || nb.indexOf(na) !== -1)) out.nameClash.push({ 學號: a.id, 姓名: a.name, 會被認成: b.id + ' ' + b.name, 情況: na === nb ? '同名' : '名字是對方的一部分' });
    }); });

    out.notes.push('費率表改價 ' + Object.keys(overrides).length + ' 項；學生 ' + students.length + '、小組 ' + groups.length + '、導師 ' + tutors.length + '；已生成月份：' + Object.keys(byMonth).sort().join('、'));

    var show = function (title, rows) { console.group(title + (rows.length ? '（' + rows.length + '）' : '（沒有）')); if (rows.length) console.table(rows); console.groupEnd(); };
    console.group('%cGAC 診斷', 'font-weight:bold;font-size:14px');
    out.notes.forEach(function (n) { console.log('• ' + n); });
    show('0. 版本線索', out.version);
    show('1. 導師名單（設定頁）', out.tutors);
    show('2. 學生記錄上的導師級別 ≠ 設定頁等級（查價跟記錄，不跟設定頁）', out.tierMismatch);
    show('3. 每位學生的查價路徑（每堂_系統用 ≠ 費率表_同級別 → 估算；看「說明」）', out.pricing);
    show('4. 已生成的課 ≠ 目前名單（改了名單沒有重新「生成」，或 Calendar 同步改過）', out.lessonMismatch);
    show('5. 學費條目 ≠ 現在重算（改價後要重新「生成」才更新；已發送的不會改）', out.tuition);
    show('6a. 學號撞號', out.idClash);
    show('6b. 姓名撞號（Calendar 標題沒學號時按姓名認人）', out.nameClash);
    console.groupEnd();

    window.gacDiag = out;
    window.gacWhy = function (id) {
        var k = idKey(id);
        var s = students.filter(function (x) { return idKey(x.id) === k; })[0];
        if (!s) { console.log('沒有這位學生：' + id); return; }
        var tier = s.tutorLevel || tierOf(s.tutor) || '';
        console.group('學生 ' + s.id + ' ' + s.name);
        console.table([{ 導師: s.tutor, 記錄上的級別: s.tutorLevel || '(空)', 設定頁等級: tierOf(s.tutor), 查價用: tier, 課程: s.program, 級別: s.level, 形式: s.type, 時長: s.duration, 星期: s.weekday, 時間: s.time, 生效月份: s.effectiveMonth || '', 預定星期: s.futureWeekday, 預定時間: s.futureTime || '' }]);
        console.table(['普通導師', '資深導師'].map(function (t) { return { 若級別為: t, 費率表: exact(t, s) }; }).concat([{ 若級別為: '系統實際用', 費率表: usedRate(s) }]));
        var rows = [];
        Object.keys(byMonth).sort().forEach(function (m) { (byMonth[m] || []).forEach(function (l) { if (l.studentId !== s.id) return; rows.push({ 月份: m, 日期: l.date, 時間: l.time, 時長: l.duration, 導師: l.tutor, 級別: l.tutorLevel || '(空)', 狀態: l.status, 補堂: l.isMakeup ? '是' : '', 小組: l.groupId || '', 每堂: fn('rateForLesson') ? rateForLesson(l) : '', 改期自: l.gcalMovedFrom ? JSON.stringify(l.gcalMovedFrom) : '', Calendar事件: l.gcalEventId ? '有' : '' }); }); });
        console.table(rows);
        Object.keys(log).forEach(function (key) { var e = log[key]; if (e && e.type === 'TUITION' && e.studentId === s.id) console.log('學費條目 ' + e.month + '：$' + e.amount + '（' + e.status + (e.amountEdited ? '，手改過' : '') + '）'); });
        console.groupEnd();
    };
    console.log('摘要在 gacDiag；看單一學生：gacWhy("學號")；帶走：copy(JSON.stringify(gacDiag))');
    return out;
})();
