/**
 * 現場互動測驗 × LINE —— Google Apps Script 後端
 *
 * 使用方式（詳見 docs/01-管理者建置教學.md）：
 *   1. 開一個 Google Sheet → 擴充功能 → Apps Script → 把這整份貼進去
 *   2. 專案設定 → 指令碼屬性，新增兩個屬性：
 *        CHANNEL_ACCESS_TOKEN = LINE Messaging API 的 Channel access token (long-lived)
 *        ADMIN_KEY            = 你自己設定的管理密碼（出題者登入管理後台用，請設 12 字以上）
 *   3. 執行一次 setup()，並在跳出的視窗完成授權
 *   4. 部署 → 新增部署 → 類型「網頁應用程式」→ 執行身分「我」、存取權「所有人」
 *
 * 資料都存在這份 Google Sheet 裡，前端（GitHub 上的網頁）完全沒有題目和正解：
 *   分頁「題庫」  ：每個類別一列（自動生成題用的答案清單）
 *   分頁「測驗」  ：每場測驗一列（完整題目 + 正解，JSON）
 *   分頁「作答紀錄」：每次作答一列
 *
 * 玩家端流程：
 *   start  ：驗證 LINE 身分 → 沒作答過（或允許重考）才回傳題目（不含正解）
 *   submit ：收到玩家選的答案 → 在這裡比對正解、算分、寫入 Sheet → 回傳分數
 *   webhook：玩家在聊天室送出「查詢成績」→ 用 Reply API 免費回覆成績
 *
 * 安全設計：玩家身分（userId）不是前端傳來的，而是拿玩家的 LIFF access token
 * 直接問 LINE 伺服器；管理動作一律要帶 ADMIN_KEY。
 */

// ===== 可調整的設定 =====
const SHEET_RESULTS = '作答紀錄';
const SHEET_QUIZZES = '測驗';
const SHEET_CATS = '題庫';
const RESULT_HEADERS = ['timestamp', 'quizId', 'lineUserId', 'displayName', 'score', 'totalQuestions', 'answersJson', 'submissionId'];
const TZ = 'Asia/Taipei';
const QUERY_KEYWORD = '查詢成績';            // 玩家按鈕預填的關鍵字，要和 play/index.html 一致
const MSG_SCORE = (score, total) => '您已完成作答，成績：' + score + '/' + total;
const MSG_NOT_FOUND = '找不到您的作答紀錄。請先掃描 QRCode 完成測驗，作答後再查詢成績。';
const MAX_RESULT_ROWS = 5000;
const QUIZ_CACHE_SECONDS = 21600;
const TOKEN_CACHE_SECONDS = 300;
const DONE_CACHE_SECONDS = 3600;
const WRITE_ACTIONS = ['submit', 'admin_saveCategory', 'admin_deleteCategory', 'admin_saveQuiz', 'admin_deleteQuiz'];

// 第一次 setup() 時放進去的範例資料（只有在「題庫」「測驗」是空的時候才會放）
const SEED = {"categories":{"低硬度岩石":["石灰岩","頁岩","砂岩","泥岩","板岩","白雲岩","礫岩","凝灰岩"],"常見酒類":["啤酒","紅酒","白酒","清酒","威士忌","伏特加","高粱酒","琴酒","白蘭地","龍舌蘭"],"高硬度岩石":["花崗岩","石英岩","玄武岩","輝長岩","片麻岩","角閃岩","安山岩","流紋岩"]},"quiz":{"quizId":"demo","title":"示範測驗：岩石與酒類","description":"這是系統內建的示範測驗，共 10 題。作答完成後按「檢視作答總覽」確認，再送出即可看到成績。","allowRetake":true,"questions":[{"id":"q1","mode":"auto","question":"請選出正確答案","category":"高硬度岩石","answer":"花崗岩","optionCount":5,"options":["流紋岩","輝長岩","角閃岩","玄武岩","花崗岩"],"correctIndex":4},{"id":"q2","mode":"auto","question":"請選出正確答案","category":"高硬度岩石","answer":"玄武岩","optionCount":5,"options":["玄武岩","花崗岩","流紋岩","角閃岩","石英岩"],"correctIndex":0},{"id":"q3","mode":"auto","question":"請選出正確答案","category":"低硬度岩石","answer":"石灰岩","optionCount":5,"options":["頁岩","凝灰岩","砂岩","泥岩","石灰岩"],"correctIndex":4},{"id":"q4","mode":"auto","question":"請選出正確答案","category":"低硬度岩石","answer":"頁岩","optionCount":5,"options":["凝灰岩","石灰岩","泥岩","板岩","頁岩"],"correctIndex":4},{"id":"q5","mode":"manual","question":"以下哪種酒精飲料的酒精濃度最低？","options":["啤酒","威士忌","琴酒","高粱酒","伏特加"],"correctIndex":0},{"id":"q6","mode":"auto","question":"請選出正確答案","category":"常見酒類","answer":"清酒","optionCount":5,"options":["高粱酒","清酒","威士忌","白蘭地","啤酒"],"correctIndex":1},{"id":"q7","mode":"manual","question":"下列哪一種岩石屬於火成岩？","options":["石灰岩","花崗岩","大理岩","板岩","砂岩"],"correctIndex":1},{"id":"q8","mode":"manual","question":"下列哪一種岩石屬於沉積岩？","options":["玄武岩","砂岩","石英岩","片麻岩","安山岩"],"correctIndex":1},{"id":"q9","mode":"manual","question":"摩氏硬度表中，硬度最高的礦物是？","options":["螢石","滑石","方解石","石英","鑽石"],"correctIndex":4},{"id":"q10","mode":"manual","question":"威士忌的主要原料是？","options":["甘蔗","龍舌蘭","葡萄","穀物","馬鈴薯"],"correctIndex":3}]}};

// ===== 進入點 =====

/** 用瀏覽器直接開部署網址會看到這行，代表部署成功。 */
function doGet() {
  return ContentService.createTextOutput('LINE quiz backend is running.');
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }

  // LINE 的 webhook 一定帶有 events 陣列（按 Verify 時是空陣列）
  if (body && Array.isArray(body.events)) {
    handleWebhook_(body.events);
    return ContentService.createTextOutput('OK');
  }

  try {
    // 會「改資料」的動作，網頁重試時會帶同一個 rid：第一次成功的結果先記下來，重送就直接回同一個結果，
    // 不會重複儲存（Google 後端偶爾會回一個空殼回應，網頁收到後會自動重試）
    const rid = String(body.rid || '').slice(0, 64);
    const cacheable = rid && WRITE_ACTIONS.indexOf(body.action) >= 0;
    const cache = CacheService.getScriptCache();
    if (cacheable) {
      const hit = cache.get('rid:' + rid);
      if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    }
    const text = JSON.stringify(route_(body));
    if (cacheable && text.indexOf('"ok":true') === 1) cache.put('rid:' + rid, text, 600);
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function route_(body) {
  switch (body.action) {
    // 玩家
    case 'start':                return actionStart_(body);
    case 'submit':               return actionSubmit_(body);
    // 管理後台
    case 'results':              return actionResults_(body);
    case 'admin_list':           return adminList_(body);
    case 'admin_saveCategory':   return adminSaveCategory_(body);
    case 'admin_deleteCategory': return adminDeleteCategory_(body);
    case 'admin_saveQuiz':       return adminSaveQuiz_(body);
    case 'admin_deleteQuiz':     return adminDeleteQuiz_(body);
    default:                     return { ok: false, error: 'unknown_action' };
  }
}

// ===== 玩家：進場（查重 + 取題目） =====
function actionStart_(b) {
  const quizId = cleanQuizId_(b.quizId);
  const quiz = getQuiz_(quizId);
  if (!quiz) return { ok: false, error: 'quiz_not_found' };
  const pub = publicQuiz_(quiz);

  if (b.key) {                                   // 管理者預覽：不驗證 LINE、不記錄
    requireAdmin_(b.key);
    return { ok: true, submitted: false, quiz: pub, preview: true };
  }
  const user = verifyUser_(b.token);
  if (!quiz.allowRetake) {                       // 允許重考的測驗根本不用查紀錄，省下掃描整張表的時間
    const rec = findDone_(user.userId, quizId);
    if (rec) return { ok: true, submitted: true, score: rec.score, total: rec.total };
  }
  return { ok: true, submitted: false, quiz: pub };
}

/** 這個人在這場「限一次」測驗有沒有作答過。先看快取，沒有才掃 Sheet（掃到了再記進快取）。 */
function findDone_(userId, quizId) {
  const cache = CacheService.getScriptCache();
  const key = 'done:' + quizId + ':' + userId;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const rec = findLatest_(userId, quizId);
  if (rec) cache.put(key, JSON.stringify({ score: rec.score, total: rec.total }), DONE_CACHE_SECONDS);
  return rec;
}

/** 給玩家的題目：只有題目與選項，沒有正解、類別。 */
function publicQuiz_(q) {
  return {
    quizId: q.quizId,
    title: q.title,
    description: q.description || '',
    questions: q.questions.map(function (x) { return { id: x.id, question: x.question, options: x.options }; })
  };
}

// ===== 玩家：送出答案（後端算分） =====
function actionSubmit_(b) {
  const quizId = cleanQuizId_(b.quizId);
  const quiz = getQuiz_(quizId);
  if (!quiz) throw new Error('quiz_not_found');
  const r = score_(quiz, b.picks);

  if (b.key) {                                   // 管理者預覽：算給他看，不寫入
    requireAdmin_(b.key);
    return { ok: true, score: r.score, total: r.total, preview: true };
  }
  const user = verifyUser_(b.token);
  const sid = String(b.submissionId || '').slice(0, 64);
  const cache = CacheService.getScriptCache();
  const result = { score: r.score, total: r.total };

  // 同一次送出重送（網路重試）：直接回上次的結果，不重複寫入
  if (sid) {
    const prev = cache.get('sid:' + sid);
    if (prev) return Object.assign({ ok: true }, JSON.parse(prev));
  }

  const row = [new Date(), quizId, user.userId, user.displayName, r.score, r.total,
    JSON.stringify(r.answers).slice(0, 45000), sid];

  if (quiz.allowRetake) {
    resultsSheet_().appendRow(row);              // 允許重考：不用上鎖、不用掃描整張表，多人同時送出也不會排隊
  } else {
    // 每人限一次：要上鎖，避免同一個人在兩支手機同時送出。鎖裡只做最少的事。
    const existing = withLock_(function () {
      const rec = findDone_(user.userId, quizId);
      if (!rec) resultsSheet_().appendRow(row);
      return rec;
    });
    if (existing) return { ok: false, error: 'duplicate', score: existing.score, total: existing.total };
    cache.put('done:' + quizId + ':' + user.userId, JSON.stringify(result), DONE_CACHE_SECONDS);
  }
  if (sid) cache.put('sid:' + sid, JSON.stringify(result), QUIZ_CACHE_SECONDS);
  return { ok: true, score: r.score, total: r.total };
}

function score_(quiz, picks) {
  if (!Array.isArray(picks) || picks.length !== quiz.questions.length) throw new Error('bad_answers');
  let score = 0;
  const answers = quiz.questions.map(function (q, i) {
    const p = Number(picks[i]);
    const pick = Number.isInteger(p) && p >= 0 && p < q.options.length ? p : -1;
    const ok = pick === q.correctIndex;
    if (ok) score++;
    return { id: q.id, pick: pick, text: pick >= 0 ? q.options[pick] : '', ok: ok };
  });
  return { score: score, total: quiz.questions.length, answers: answers };
}

// ===== Webhook：免費回覆成績 =====
function handleWebhook_(events) {
  events.forEach(function (ev) {
    try {
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
      const text = String(ev.message.text || '').trim();
      if (text.indexOf(QUERY_KEYWORD) !== 0) return;      // 其他訊息不處理（保留給人工客服）

      const m = text.slice(QUERY_KEYWORD.length).match(/[A-Za-z0-9_-]+/);
      const quizId = m ? m[0] : '';
      const userId = ev.source && ev.source.userId;
      if (!userId || !ev.replyToken) return;

      const rec = findLatest_(userId, quizId);
      reply_(ev.replyToken, rec ? MSG_SCORE(rec.score, rec.total) : MSG_NOT_FOUND);
    } catch (err) {
      console.error(err && err.stack || err);
    }
  });
}

function reply_(replyToken, text) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('Reply API failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}

// ===== 管理後台 =====
function adminList_(b) {
  requireAdmin_(b.key);
  const categories = {};
  readRows_(tab_(SHEET_CATS, ['name', 'items'])).forEach(function (r) {
    categories[String(r[0])] = String(r[1]).split('\n').filter(Boolean);
  });
  const quizzes = [];
  readRows_(tab_(SHEET_QUIZZES, ['quizId', 'json', 'updatedAt'])).forEach(function (r) {
    try {
      const q = JSON.parse(r[1]);
      q.updatedAt = String(r[2]);
      quizzes.push(q);
    } catch (e) { /* 壞掉的列略過 */ }
  });
  return { ok: true, categories: categories, quizzes: quizzes };
}

function adminSaveCategory_(b) {
  requireAdmin_(b.key);
  const name = String(b.name || '').trim();
  if (!name || name.length > 30 || /[\\\/:*?"<>|.#%]/.test(name)) throw new Error('bad_category_name');
  const seen = {}, items = [];
  (Array.isArray(b.items) ? b.items : []).forEach(function (x) {
    x = str_(x, 100);
    if (x && !seen[x]) { seen[x] = 1; items.push(x); }
  });
  if (!items.length || items.length > 300) throw new Error('bad_category_items');
  withLock_(function () {
    upsertRow_(tab_(SHEET_CATS, ['name', 'items']), name, [name, items.join('\n')]);
  });
  return { ok: true, items: items };
}

function adminDeleteCategory_(b) {
  requireAdmin_(b.key);
  withLock_(function () { deleteRow_(tab_(SHEET_CATS, ['name', 'items']), String(b.name || '')); });
  return { ok: true };
}

function adminSaveQuiz_(b) {
  requireAdmin_(b.key);
  const quiz = cleanQuiz_(b.quiz || {});
  const sh = tab_(SHEET_QUIZZES, ['quizId', 'json', 'updatedAt']);
  const updatedAt = new Date().toISOString();
  withLock_(function () {
    const row = findRowIndex_(sh, quiz.quizId);
    if (b.isNew && row) throw new Error('exists');
    if (!b.isNew && row && b.baseUpdatedAt && String(sh.getRange(row, 3).getValue()) !== String(b.baseUpdatedAt)) {
      throw new Error('conflict');
    }
    upsertRow_(sh, quiz.quizId, [quiz.quizId, JSON.stringify(quiz), updatedAt]);
    CacheService.getScriptCache().remove('quiz:' + quiz.quizId);
  });
  return { ok: true, updatedAt: updatedAt, quiz: quiz };
}

function adminDeleteQuiz_(b) {
  requireAdmin_(b.key);
  const id = cleanQuizId_(b.quizId);
  withLock_(function () {
    deleteRow_(tab_(SHEET_QUIZZES, ['quizId', 'json', 'updatedAt']), id);
    CacheService.getScriptCache().remove('quiz:' + id);
  });
  return { ok: true };
}

function actionResults_(b) {
  requireAdmin_(b.key);
  const quizId = b.quizId ? cleanQuizId_(b.quizId) : '';
  const values = resultsSheet_().getDataRange().getValues();
  const quizIds = {};
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const qid = String(r[1]);
    quizIds[qid] = (quizIds[qid] || 0) + 1;
    if (quizId && qid !== quizId) continue;
    rows.push({
      time: fmtTime_(r[0]),
      quizId: qid,
      userId: String(r[2]),
      name: String(r[3]),
      score: Number(r[4]),
      total: Number(r[5]),
      answers: safeParse_(r[6])
    });
  }
  return { ok: true, quizIds: quizIds, rows: rows.slice(-MAX_RESULT_ROWS) };
}

/** 驗證並整理管理者送來的測驗；只保留我們定義的欄位。 */
function cleanQuiz_(q) {
  const quizId = cleanQuizId_(q.quizId);
  const title = str_(q.title, 100);
  if (!title) throw new Error('missing_title');
  if (!Array.isArray(q.questions) || !q.questions.length || q.questions.length > 100) throw new Error('bad_questions');
  const questions = q.questions.map(function (x, i) {
    const options = Array.isArray(x.options) ? x.options.map(function (o) { return str_(o, 200); }) : [];
    if (options.length < 2 || options.length > 10 || options.some(function (o) { return !o; })) throw new Error('bad_options_q' + (i + 1));
    const ci = Number(x.correctIndex);
    if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) throw new Error('bad_correct_q' + (i + 1));
    const out = { id: 'q' + (i + 1), mode: x.mode === 'auto' ? 'auto' : 'manual', question: str_(x.question, 500), options: options, correctIndex: ci };
    if (out.mode === 'auto') { out.category = str_(x.category, 60); out.answer = str_(x.answer, 200); }
    else if (!out.question) throw new Error('missing_question_q' + (i + 1));
    return out;
  });
  return { quizId: quizId, title: title, description: str_(q.description, 500), allowRetake: !!q.allowRetake, questions: questions };
}

// ===== 資料存取 =====
function getQuiz_(quizId) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('quiz:' + quizId);
  if (hit) return JSON.parse(hit);
  const sh = tab_(SHEET_QUIZZES, ['quizId', 'json', 'updatedAt']);
  const row = findRowIndex_(sh, quizId);
  if (!row) return null;
  const text = String(sh.getRange(row, 2).getValue());
  cache.put('quiz:' + quizId, text, QUIZ_CACHE_SECONDS);
  return JSON.parse(text);
}

/** 找出某人在某場測驗「最新的一筆」紀錄；quizId 留空 = 該人所有測驗中最新的一筆 */
function findLatest_(userId, quizId) {
  const sh = resultsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const values = sh.getRange(2, 1, last - 1, RESULT_HEADERS.length).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    const r = values[i];
    if (String(r[2]) === userId && (!quizId || String(r[1]) === quizId)) {
      return { score: Number(r[4]), total: Number(r[5]), sid: String(r[7] || '') };
    }
  }
  return null;
}

function spreadsheet_() {
  const id = prop_('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/** 取得（不存在就建立）某個分頁，第一列是表頭。整欄設成純文字，避免代碼/暱稱被轉成數字。 */
function tab_(name, headers) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange('A:' + String.fromCharCode(64 + headers.length)).setNumberFormat('@');
  }
  return sh;
}

function resultsSheet_() {
  const existed = !!spreadsheet_().getSheetByName(SHEET_RESULTS);
  const sh = tab_(SHEET_RESULTS, RESULT_HEADERS);
  if (!existed) {
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sh.getRange('E:F').setNumberFormat('0');
    spreadsheet_().setSpreadsheetTimeZone(TZ);
  }
  return sh;
}

function readRows_(sh) {
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}
function findRowIndex_(sh, key) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const keys = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) if (String(keys[i][0]) === String(key)) return i + 2;
  return 0;
}
function upsertRow_(sh, key, values) {
  const row = findRowIndex_(sh, key);
  if (row) sh.getRange(row, 1, 1, values.length).setValues([values]);
  else sh.appendRow(values);
}
function deleteRow_(sh, key) {
  const row = findRowIndex_(sh, key);
  if (row) sh.deleteRow(row);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ===== 工具 =====
function verifyUser_(accessToken) {
  if (!accessToken) throw new Error('missing_token');
  // 同一位玩家「進場」和「送出」會各驗證一次；驗證過的結果快取 5 分鐘，省下一趟往返 LINE 的時間。
  // 快取的 key 是 token 的雜湊值，不會把 token 本身存進去。
  const cache = CacheService.getScriptCache();
  const ck = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, accessToken));
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);

  const res = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('invalid_token');
  const p = JSON.parse(res.getContentText());
  const user = { userId: p.userId, displayName: p.displayName || '' };
  cache.put(ck, JSON.stringify(user), TOKEN_CACHE_SECONDS);
  return user;
}

/** 管理密碼錯誤或沒設定一律拒絕；錯誤時故意延遲，拖慢暴力猜測。 */
function requireAdmin_(key) {
  const real = prop_('ADMIN_KEY');
  if (real && String(key || '') === real) return;
  Utilities.sleep(800);
  throw new Error('forbidden');
}

function cleanQuizId_(id) {
  id = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new Error('bad_quiz_id');
  return id;
}

function str_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k) || '';
}

function fmtTime_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v);
}

function safeParse_(s) {
  try { return JSON.parse(s); } catch (e) { return []; }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===== 第一次安裝用：在編輯器選 setup 後按「執行」 =====
function setup() {
  resultsSheet_();
  const cats = tab_(SHEET_CATS, ['name', 'items']);
  const quizzes = tab_(SHEET_QUIZZES, ['quizId', 'json', 'updatedAt']);

  if (SEED) {
    if (cats.getLastRow() < 2) {
      Object.keys(SEED.categories).forEach(function (n) { cats.appendRow([n, SEED.categories[n].join('\n')]); });
    }
    if (quizzes.getLastRow() < 2) {
      const q = cleanQuiz_(SEED.quiz);
      quizzes.appendRow([q.quizId, JSON.stringify(q), new Date().toISOString()]);
    }
  }

  const problems = [];
  if (!prop_('CHANNEL_ACCESS_TOKEN')) problems.push('尚未設定指令碼屬性 CHANNEL_ACCESS_TOKEN');
  if (!prop_('ADMIN_KEY')) problems.push('尚未設定指令碼屬性 ADMIN_KEY');
  else if (prop_('ADMIN_KEY').length < 10) problems.push('ADMIN_KEY 太短，建議 12 字以上');
  if (problems.length) {
    console.log('⚠️ 還有東西沒設定：\n- ' + problems.join('\n- '));
  } else {
    console.log('✅ 設定完成。已建立分頁「' + SHEET_RESULTS + '」「' + SHEET_QUIZZES + '」「' + SHEET_CATS + '」，並放入示範測驗 demo。可以部署網頁應用程式了。');
  }
}
