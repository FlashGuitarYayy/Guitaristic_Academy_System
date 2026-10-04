'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ST = require('../lib/storage.js');
const serve = require('../serve.js');

test('createFileBackedStorage：讀寫在記憶體、改動合併延遲寫回、失敗回報並保留、flush 等到寫完', async () => {
    const saves = [];
    let fail = false;
    const s = ST.createFileBackedStorage({ a: '1', junk: 5 }, obj => { if (fail) return Promise.reject(new Error('boom')); saves.push(obj); return Promise.resolve(); }, { delay: 5 });
    assert.strictEqual(s.getItem('a'), '1');
    assert.strictEqual(s.getItem('junk'), null, '非字串值不收');
    assert.strictEqual(s.length, 1);
    s.setItem('b', 'x'); s.setItem('c', 'y'); s.removeItem('a');
    assert.ok(s.hasPending());
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(saves, [{ b: 'x', c: 'y' }], '三個改動合併成一次寫回');
    assert.ok(!s.hasPending());
    fail = true;
    const errs = [];
    s.onError = e => errs.push(e.message);
    s.setItem('d', 'z');
    await s.flush();
    assert.deepStrictEqual(errs, ['boom']);
    assert.strictEqual(s.lastError.message, 'boom');
    fail = false;
    s.setItem('e', 'w');
    await s.flush();
    assert.strictEqual(saves.length, 2);
    assert.deepStrictEqual(saves[1], { b: 'x', c: 'y', d: 'z', e: 'w' }, '失敗那次的改動沒丟，下一次一併寫回');
    assert.strictEqual(s.lastError, null);
    assert.strictEqual(s.key(0), 'b');
    assert.strictEqual(s.key(9), null);
});

test('createFileBackedStorage：寫回進行中又有改動 → 寫完再寫一次，最後狀態一定落地', async () => {
    const saves = [];
    let release = null, n = 0;
    const s = ST.createFileBackedStorage({}, obj => { saves.push(obj); return n++ === 0 ? new Promise(r => { release = r; }) : Promise.resolve(); }, { delay: 1 });
    s.setItem('k', '1');
    const p = s.flush();
    await new Promise(r => setImmediate(r)); // 第一次寫回已開始（拿到 release）
    s.setItem('k', '2');                     // 寫回進行中的改動
    release();
    await p;
    await s.flush();                         // 沒改動就不會多寫一次
    assert.deepStrictEqual(saves, [{ k: '1' }, { k: '2' }]);
    assert.ok(!s.hasPending());
    await s.flush();
    assert.strictEqual(saves.length, 2, '沒有新改動 → flush 不寫');
});

test('pickStorage：有注入 → 檔案後備（掛在 win.__GAC_FILE_STORAGE）；沒有 → localStorage', () => {
    const ls = { getItem() { return null; }, setItem() {} };
    assert.strictEqual(ST.pickStorage({ localStorage: ls }), ls);
    const win = { localStorage: ls, __GAC_FILE_STATE: { gac_students_v2: '[]' }, __GAC_FILE_STORE: { file: 'local-state.json', folder: 'x', save: () => Promise.resolve() } };
    const s = ST.pickStorage(win);
    assert.ok(s.isFileBacked);
    assert.strictEqual(win.__GAC_FILE_STORAGE, s);
    assert.strictEqual(s.getItem('gac_students_v2'), '[]');
    assert.strictEqual(ST.createStore(s).loadStudents([{ id: 'X' }]).length, 0, 'createStore 直接沿用');
});

test('fileSaver：PUT /__state、JSON 本文、小本文 keepalive；非 2xx 視為失敗', async () => {
    const calls = [];
    const save = ST.fileSaver({ fetch: (url, o) => { calls.push({ url, o }); return Promise.resolve({ ok: true }); } });
    await save({ a: '1' });
    assert.strictEqual(calls[0].url, '/__state');
    assert.strictEqual(calls[0].o.method, 'PUT');
    assert.strictEqual(calls[0].o.body, '{"a":"1"}');
    assert.strictEqual(calls[0].o.keepalive, true);
    await assert.rejects(ST.fileSaver({ fetch: () => Promise.resolve({ ok: false, status: 500 }) })({}), /HTTP 500/);
});

test('serve.js：/__state 讀寫本資料夾 local-state.json（先 .tmp 再改名）；index.html 注入狀態（跳脫 </script>）；壞 JSON 拒收；壞檔以空狀態啟動', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-serve-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body>\n    <script src="data.js"></script>\n</body></html>');
    const server = serve.createServer(root);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        assert.deepStrictEqual(await (await fetch(base + '/__state')).json(), {});
        let html = await (await fetch(base + '/')).text();
        assert.ok(html.includes('window.__GAC_FILE_STATE={};'), '沒有檔案 → 注入空狀態');
        assert.ok(html.includes('"folder":"' + path.basename(root) + '"') || html.includes('folder:"' + path.basename(root) + '"'));
        assert.ok(html.indexOf('__GAC_FILE_STATE') < html.indexOf('<script src="data.js">'), '注在 data.js 之前');
        const state = { gac_students_v2: '[{"id":"S1"}]', x: '</script><b>' };
        const put = await fetch(base + '/__state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
        assert.strictEqual(put.status, 204);
        assert.ok(fs.existsSync(path.join(root, serve.STATE_FILE)));
        assert.ok(!fs.existsSync(path.join(root, serve.STATE_FILE + '.tmp')));
        assert.deepStrictEqual(await (await fetch(base + '/__state')).json(), state);
        html = await (await fetch(base + '/index.html')).text();
        assert.ok(html.includes('S1'));
        assert.ok(!html.includes('</script><b>'), '狀態裡的 </script> 已跳脫');
        assert.ok(html.includes('\\u003c/script>'));
        assert.strictEqual((await fetch(base + '/__state', { method: 'PUT', body: '[1,2]' })).status, 400);
        assert.strictEqual((await fetch(base + '/__state', { method: 'PUT', body: '{oops' })).status, 400);
        assert.deepStrictEqual(await (await fetch(base + '/__state')).json(), state, '拒收的沒有覆蓋原檔');
        assert.strictEqual((await fetch(base + '/__state', { method: 'DELETE' })).status, 405);
        fs.writeFileSync(path.join(root, serve.STATE_FILE), 'garbage');
        assert.deepStrictEqual(serve.readState(root), {}, '壞檔 → 空狀態');
        assert.strictEqual(fs.readFileSync(path.join(root, serve.STATE_FILE), 'utf8'), 'garbage', '壞檔不動');
    } finally {
        await new Promise(r => server.close(r));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('帳號資料：extractCredentials 從狀態抽出 Client ID／日曆／FPS／導師日曆（備忘＋名單，清空的不記）；applyCredentials 只填空著的、導師按名字；credentialsEmpty', () => {
    assert.strictEqual(ST.extractCredentials({}), null, '還沒存過設定 → null');
    assert.strictEqual(ST.extractCredentials({ gac_settings_v2: '{oops' }), null);
    const state = {
        gac_settings_v2: JSON.stringify({ gcalClientId: ' cid.apps.googleusercontent.com ', gcalCalendarId: 'main@group.calendar.google.com', fpsId: '12345678', infoUrl: '', tplLeave: 'x', tutorCalendarMemo: { 'Instructor A': 'memo-a@group.calendar.google.com', 'Instructor Z': 'z@group.calendar.google.com', 'Gone': '' } }),
        gac_tutors_v3: JSON.stringify([{ name: 'Instructor A', tier: '普通導師', calendarId: 'a@group.calendar.google.com' }, { name: 'Instructor B', tier: '資深導師', calendarId: '' }, { name: 'Instructor Z', calendarId: '' }])
    };
    const c = ST.extractCredentials(state);
    assert.deepStrictEqual(c, { gcalClientId: 'cid.apps.googleusercontent.com', gcalCalendarId: 'main@group.calendar.google.com', fpsId: '12345678', infoUrl: '', tutorCalendars: { 'Instructor A': 'a@group.calendar.google.com' } }, '名單蓋過備忘；名單上清空的（Z）與空值（Gone）不記；不帶模板等其他設定');
    assert.ok(!ST.credentialsEmpty(c));
    assert.ok(ST.credentialsEmpty({ gcalClientId: '', gcalCalendarId: 'primary', fpsId: '', infoUrl: '', tutorCalendars: {} }), 'primary 算沒填');
    assert.ok(ST.credentialsEmpty(null));
    // 填回：空狀態（預設設定、data.js 的導師）
    const settings = Object.assign({}, ST.DEFAULT_SETTINGS);
    const tutors = [{ name: 'Instructor A', tier: '普通導師', calendarId: '' }, { name: 'Instructor B', tier: '資深導師', calendarId: 'keep@group.calendar.google.com' }];
    const filled = ST.applyCredentials(settings, tutors, Object.assign({}, c, { tutorCalendars: { 'Instructor A': 'a@group.calendar.google.com', 'Instructor B': 'other@group.calendar.google.com' } }));
    assert.deepStrictEqual(filled, ['gcalClientId', 'gcalCalendarId', 'fpsId', 'tutorCalendars:1'], 'infoUrl 空的不算填；B 已有 ID 不動');
    assert.strictEqual(settings.gcalClientId, 'cid.apps.googleusercontent.com');
    assert.strictEqual(settings.gcalCalendarId, 'main@group.calendar.google.com');
    assert.strictEqual(settings.tplLeave, ST.DEFAULT_SETTINGS.tplLeave, '只動帳號欄位');
    assert.strictEqual(tutors[0].calendarId, 'a@group.calendar.google.com');
    assert.strictEqual(tutors[1].calendarId, 'keep@group.calendar.google.com');
    assert.deepStrictEqual(settings.tutorCalendarMemo, { 'Instructor A': 'a@group.calendar.google.com', 'Instructor B': 'other@group.calendar.google.com' }, '備忘整份記住（換名單時按名字回填）');
    // 已填的不覆蓋；沒有記錄 → 不動
    const s2 = Object.assign({}, ST.DEFAULT_SETTINGS, { gcalClientId: 'mine' });
    assert.deepStrictEqual(ST.applyCredentials(s2, [], c), ['gcalCalendarId', 'fpsId']);
    assert.strictEqual(s2.gcalClientId, 'mine');
    assert.deepStrictEqual(ST.applyCredentials(s2, [], null), []);
});

test('serve.js：寫回狀態時把帳號資料另存 local-credentials.json（沒填過不建檔、內容一樣不重寫、清空會跟著清）；啟動時從現有狀態補建；index.html 注入 __GAC_FILE_CREDENTIALS', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gac-cred-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head></head><body>\n    <script src="data.js"></script>\n</body></html>');
    const credPath = path.join(root, serve.CRED_FILE);
    const put = (base, state) => fetch(base + '/__state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
    let server = serve.createServer(root);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        let html = await (await fetch(base + '/')).text();
        assert.ok(html.includes('window.__GAC_FILE_CREDENTIALS=null;'), '沒有檔 → 注入 null');
        assert.ok(html.includes('credentialsFile:"local-credentials.json"'));
        assert.strictEqual((await put(base, { gac_students_v2: '[]' })).status, 204);
        assert.ok(!fs.existsSync(credPath), '狀態裡沒有設定 → 不建檔');
        assert.strictEqual((await put(base, { gac_students_v2: '[]', gac_settings_v2: JSON.stringify({ gcalClientId: '', gcalCalendarId: 'primary' }) })).status, 204);
        assert.ok(!fs.existsSync(credPath), '什麼都沒填過 → 不建檔');
        const creds = { gcalClientId: 'cid.apps.googleusercontent.com', gcalCalendarId: '', fpsId: '', infoUrl: '', tutorCalendars: { 'Instructor A': 'a@group.calendar.google.com' } };
        const filledState = tpl => ({ gac_settings_v2: JSON.stringify({ gcalClientId: 'cid.apps.googleusercontent.com', tplLeave: tpl }), gac_tutors_v3: JSON.stringify([{ name: 'Instructor A', calendarId: 'a@group.calendar.google.com' }]) });
        assert.strictEqual((await put(base, filledState('x'))).status, 204);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), creds, '填了 → 建檔，只有帳號欄位');
        assert.ok(!fs.existsSync(credPath + '.tmp'));
        const mtime = fs.statSync(credPath).mtimeMs;
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual((await put(base, filledState('y'))).status, 204);
        assert.strictEqual(fs.statSync(credPath).mtimeMs, mtime, '帳號資料沒變（只改了模板）→ 不重寫');
        html = await (await fetch(base + '/')).text();
        assert.ok(html.includes('window.__GAC_FILE_CREDENTIALS=' + JSON.stringify(creds) + ';'), '有檔 → 注進頁面');
        // 清空 Client ID → 檔案跟著清（記的是「目前填著的」）
        await put(base, { gac_settings_v2: JSON.stringify({ gcalClientId: '' }), gac_tutors_v3: '[]' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), { gcalClientId: '', gcalCalendarId: '', fpsId: '', infoUrl: '', tutorCalendars: {} });
        // 刪掉狀態檔重來：頁面拿到空狀態＋上次的帳號資料；壞掉的帳號檔 → 注入 null、檔案不動
        fs.unlinkSync(path.join(root, serve.STATE_FILE));
        html = await (await fetch(base + '/')).text();
        assert.ok(html.includes('window.__GAC_FILE_STATE={};window.__GAC_FILE_CREDENTIALS={"gcalClientId":""'));
        fs.writeFileSync(credPath, 'garbage');
        html = await (await fetch(base + '/')).text();
        assert.ok(html.includes('window.__GAC_FILE_CREDENTIALS=null;'));
        assert.strictEqual(fs.readFileSync(credPath, 'utf8'), 'garbage');
    } finally { await new Promise(r => server.close(r)); }
    // 啟動時補建：舊版留下的 local-state.json 有設定、還沒有帳號檔
    fs.unlinkSync(credPath);
    serve.writeState(root, { gac_settings_v2: JSON.stringify({ gcalClientId: 'old.apps.googleusercontent.com' }) });
    server = serve.createServer(root);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        assert.strictEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')).gcalClientId, 'old.apps.googleusercontent.com');
    } finally {
        await new Promise(r => server.close(r));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
