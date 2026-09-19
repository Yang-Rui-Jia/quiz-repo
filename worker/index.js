/**
 * 現場互動測驗 × LINE —— Cloudflare Worker 後端（資料庫：Cloudflare D1）
 *
 * 取代原本的 Google Apps Script。API 格式完全相同（POST JSON、同樣的 action 與錯誤代碼），
 * 網頁只需要把 config.js 的網址換成這個 Worker 的網址。
 *
 * 設定（詳見 docs/01-管理者建置教學.md）：
 *   綁定（Bindings）：D1 資料庫，變數名稱 DB
 *   機密（Secrets）：
 *     CHANNEL_ACCESS_TOKEN  LINE Messaging API 的 Channel access token (long-lived)
 *     ADMIN_KEY             管理密碼（出題者登入後台用，請設 12 字以上）
 *     CHANNEL_SECRET        （建議）LINE Channel secret，用來驗證 webhook 真的來自 LINE
 *     TURNSTILE_SECRET      （選用）Cloudflare Turnstile 的 Secret key；設了之後，後台登入要先通過「我不是機器人」驗證
 *
 * 資料表在第一次被呼叫時自動建立，並放入一場示範測驗 demo，不需要手動執行 SQL。
 *
 * 玩家端流程：
 *   start  ：驗證 LINE 身分 → 沒作答過（或允許重考）才回傳題目（不含正解）
 *   submit ：收到玩家選的答案 → 在這裡比對正解、算分、寫入資料庫 → 回傳分數
 *   webhook：玩家在聊天室送出「查詢成績」→ 用 Reply API 免費回覆成績
 *
 * 安全設計：玩家身分（userId）不是前端傳來的，而是拿玩家的 LIFF access token
 * 直接問 LINE 伺服器。後台：用管理密碼登入（admin_login）換一張 7 天有效的登入憑證，
 * 之後的管理動作都帶憑證，不再傳送管理密碼本身。登入有失敗次數鎖定，可再搭配 Turnstile。
 */

// ===== 可調整的設定 =====
const TZ = 'Asia/Taipei';
const QUERY_KEYWORD = '查詢成績';            // 玩家按鈕預填的關鍵字，要和 play/index.html 一致
const TOTAL_POINTS = 100;                    // 滿分固定 100 分
const MSG_SCORE = (score, total) => '您已完成作答，成績：' + fmtNum(score) + '/' + fmtNum(total);
const MSG_NOT_FOUND = '找不到您的作答紀錄。請先掃描 QRCode 完成測驗，作答後再查詢成績。';
const MAX_RESULT_ROWS = 5000;
const QUIZ_TTL_MS = 10 * 1000;               // 題目在記憶體裡快取的時間：後台改題目後，最多這麼久玩家端就會更新
const TOKEN_TTL_MS = 5 * 60 * 1000;          // 「這個 token 是誰」的快取時間
const DONE_TTL_MS = 60 * 1000;               // 「已作答過」的快取時間
const SESSION_TTL_S = 7 * 24 * 3600;         // 後台登入憑證的有效時間

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

// 第一次啟動時放進去的範例資料（只有在「題庫」「測驗」是空的時候才會放）
const SEED = {"categories":{"低硬度岩石":["石灰岩","頁岩","砂岩","泥岩","板岩","白雲岩","礫岩","凝灰岩"],"常見酒類":["啤酒","紅酒","白酒","清酒","威士忌","伏特加","高粱酒","琴酒","白蘭地","龍舌蘭"],"高硬度岩石":["花崗岩","石英岩","玄武岩","輝長岩","片麻岩","角閃岩","安山岩","流紋岩"]},"quiz":{"quizId":"demo","title":"示範測驗：岩石與酒類","description":"這是系統內建的示範測驗，共 10 大題、滿分 100 分。第 7 大題有 2 個子題，第 8 大題示範「部分給分」。作答時可用右上角「題目導覽」快速跳題。","allowRetake":true,"closed":false,"scoring":"equal","questions":[{"id":"q1","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q1","mode":"auto","question":"","options":["流紋岩","輝長岩","角閃岩","玄武岩","花崗岩"],"correctIndex":4,"points":10,"category":"高硬度岩石","answer":"花崗岩"}]},{"id":"q2","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q2","mode":"auto","question":"","options":["玄武岩","花崗岩","流紋岩","角閃岩","石英岩"],"correctIndex":0,"points":10,"category":"高硬度岩石","answer":"玄武岩"}]},{"id":"q3","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q3","mode":"auto","question":"","options":["頁岩","凝灰岩","砂岩","泥岩","石灰岩"],"correctIndex":4,"points":10,"category":"低硬度岩石","answer":"石灰岩"}]},{"id":"q4","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q4","mode":"auto","question":"","options":["凝灰岩","石灰岩","泥岩","板岩","頁岩"],"correctIndex":4,"points":10,"category":"低硬度岩石","answer":"頁岩"}]},{"id":"q5","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q5","mode":"manual","question":"以下哪種酒精飲料的酒精濃度最低？","options":["啤酒","威士忌","琴酒","高粱酒","伏特加"],"correctIndex":0,"points":10}]},{"id":"q6","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q6","mode":"auto","question":"","options":["高粱酒","清酒","威士忌","白蘭地","啤酒"],"correctIndex":1,"points":10,"category":"常見酒類","answer":"清酒"}]},{"id":"q7","title":"岩石分類：請回答下面兩個小題","multi":true,"subScoring":"equal","points":10,"items":[{"id":"q7-1","mode":"manual","question":"下列哪一種岩石屬於火成岩？","options":["石灰岩","花崗岩","大理岩","板岩","砂岩"],"correctIndex":1,"points":5},{"id":"q7-2","mode":"manual","question":"下列哪一種岩石屬於沉積岩？","options":["玄武岩","砂岩","石英岩","片麻岩","安山岩"],"correctIndex":1,"points":5}]},{"id":"q8","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q8","mode":"manual","question":"摩氏硬度表中，硬度最高的礦物是？","options":["螢石","滑石","方解石","石英","鑽石"],"correctIndex":4,"points":10,"partial":[0.3,0,0.3,0.5,1]}]},{"id":"q9","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q9","mode":"manual","question":"威士忌的主要原料是？","options":["甘蔗","龍舌蘭","葡萄","穀物","馬鈴薯"],"correctIndex":3,"points":10}]},{"id":"q10","title":"","multi":false,"subScoring":"equal","points":10,"items":[{"id":"q10","mode":"auto","question":"","options":["石英岩","安山岩","輝長岩","角閃岩","玄武岩"],"correctIndex":2,"points":10,"category":"高硬度岩石","answer":"輝長岩"}]}]}};
// 後台登入保護用的兩張表（舊資料庫第一次用到時會自動補建，不影響原本的資料）
const GUARD_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS login_guard (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'
];
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, items TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS quizzes (quiz_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS results (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, quiz_id TEXT NOT NULL, user_id TEXT NOT NULL, ' +
    'display_name TEXT, score INTEGER NOT NULL, total INTEGER NOT NULL, answers TEXT, submission_id TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_results_user ON results (quiz_id, user_id, id)',
  // 同一次送出（網路重試）只會寫入一筆：由資料庫保證，不靠程式判斷
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_results_sid ON results (submission_id) WHERE submission_id IS NOT NULL AND submission_id <> ''"
].concat(GUARD_SCHEMA);

// 同一個 Worker 實例內的記憶體快取（不同實例之間不共用，所以都設得很短）
const quizCache = new Map();
const tokenCache = new Map();
const doneCache = new Map();

// ===== 進入點 =====
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET') {
      return new Response('LINE quiz backend is running.', { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS) });
    }

    const raw = await request.text();
    let body;
    try { body = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad_json' }); }

    // LINE 的 webhook 一定帶有 events 陣列（按 Verify 時是空陣列）
    if (body && Array.isArray(body.events)) return handleWebhook(request, raw, body, env, ctx);

    try {
      return json(await withInit(env, function () { return route(body || {}, env, request); }));
    } catch (err) {
      const msg = String(err && err.message || err);
      // 我們自己丟的錯誤都是像 forbidden、bad_quiz_id 這種代碼；其他（例如資料庫錯誤）不把細節傳給外面
      if (!/^[a-z0-9_]+$/.test(msg)) { console.error(err && err.stack || err); return json({ ok: false, error: 'server_error' }); }
      return json({ ok: false, error: msg });
    }
  }
};

async function route(b, env, request) {
  switch (b.action) {
    // 玩家
    case 'start':                return actionStart(b, env);
    case 'submit':               return actionSubmit(b, env);
    // 管理後台
    case 'login_info':           return { ok: true, captcha: !!env.TURNSTILE_SECRET };
    case 'admin_login':          return adminLogin(b, env, request);
    case 'results':              return actionResults(b, env);
    case 'admin_purgeResults':   return adminPurgeResults(b, env);
    case 'admin_list':           return adminList(b, env);
    case 'admin_saveCategory':   return adminSaveCategory(b, env);
    case 'admin_deleteCategory': return adminDeleteCategory(b, env);
    case 'admin_saveQuiz':       return adminSaveQuiz(b, env);
    case 'admin_deleteQuiz':     return adminDeleteQuiz(b, env);
    case 'admin_setClosed':      return adminSetClosed(b, env);
    default:                     return { ok: false, error: 'unknown_action' };
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: Object.assign({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  }, CORS) });
}

// ===== 配分工具 =====
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
/** 顯示用：33.4 → "33.4"，10 → "10"（最多兩位小數，不補 0） */
function fmtNum(n) { return String(round2(Number(n) || 0)); }

/** 把 total 平均分給 n 份，每份到小數第一位；除不盡的零頭（0.1）從前面幾份補，這樣加起來剛好等於 total。 */
function distribute(total, n) {
  const T = Math.round(total * 10), base = Math.floor(T / n), rem = T - base * n;
  return Array.from({ length: n }, function (_, i) { return (base + (i < rem ? 1 : 0)) / 10; });
}

/** 舊格式（每題直接有 options）轉成新格式（大題 → 子題）。新格式原樣回傳。 */
function normalizeQuiz(q) {
  const qs = Array.isArray(q.questions) ? q.questions : [];
  if (!qs.some(function (x) { return x && !Array.isArray(x.items); })) return q;
  const pts = distribute(TOTAL_POINTS, qs.length || 1);
  return Object.assign({}, q, {
    scoring: 'equal',
    questions: qs.map(function (x, i) {
      if (Array.isArray(x.items)) return x;
      const id = x.id || 'q' + (i + 1);
      return { id: id, title: '', multi: false, subScoring: 'equal', points: pts[i],
        items: [Object.assign({}, x, { id: id, points: pts[i] })] };
    })
  });
}

function flatItems(quiz) {
  const out = [];
  quiz.questions.forEach(function (Q) { Q.items.forEach(function (it) { out.push(it); }); });
  return out;
}

// ===== 玩家：進場（查重 + 取題目） =====
async function actionStart(b, env) {
  const quizId = cleanQuizId(b.quizId);

  if (b.session) {                               // 管理者預覽：不驗證 LINE、不記錄
    await requireAdmin(env, b);
    const q = await getQuiz(env, quizId);
    if (!q) return { ok: false, error: 'quiz_not_found' };
    return { ok: true, submitted: false, quiz: publicQuiz(q), preview: true, closed: !!q.closed };
  }

  const both = await Promise.all([getQuiz(env, quizId), verifyUser(b.token)]);   // 兩件事同時做
  const quiz = both[0], user = both[1];
  if (!quiz) return { ok: false, error: 'quiz_not_found' };
  if (quiz.closed) return { ok: false, error: 'quiz_closed' };       // 已關閉：不給題目
  if (!quiz.allowRetake) {                       // 允許重考的測驗根本不用查紀錄
    const rec = await findDone(env, user.userId, quizId);
    if (rec) return { ok: true, submitted: true, score: rec.score, total: rec.total };
  }
  return { ok: true, submitted: false, quiz: publicQuiz(quiz) };
}

/** 給玩家的題目：只有題目、選項與配分，沒有正解、部分給分、類別。 */
function publicQuiz(q) {
  return {
    quizId: q.quizId,
    title: q.title,
    description: q.description || '',
    questions: q.questions.map(function (Q) {
      return { id: Q.id, title: Q.title || '', multi: !!Q.multi, points: Q.points,
        items: Q.items.map(function (it) { return { id: it.id, question: it.question || '', options: it.options, points: it.points }; }) };
    })
  };
}


// ===== 玩家：送出答案（後端算分） =====
async function actionSubmit(b, env) {
  const quizId = cleanQuizId(b.quizId);

  if (b.session) {                               // 管理者預覽：算給他看，不寫入
    await requireAdmin(env, b);
    const q = await getQuiz(env, quizId);
    if (!q) throw new Error('quiz_not_found');
    const r = score(q, b.picks);
    return { ok: true, score: r.score, total: r.total, preview: true };
  }

  const both = await Promise.all([getQuiz(env, quizId), verifyUser(b.token)]);
  const quiz = both[0], user = both[1];
  if (!quiz) throw new Error('quiz_not_found');
  if (quiz.closed) return { ok: false, error: 'quiz_closed' };
  const r = score(quiz, b.picks);
  const sid = str(b.submissionId, 64);
  const values = [new Date().toISOString(), quizId, user.userId, user.displayName, r.score, r.total,
    JSON.stringify(r.answers).slice(0, 45000), sid || null];

  let stmt;
  if (quiz.allowRetake) {
    // 允許重考：直接寫入。同一次送出重送（sid 相同）會被唯一索引擋下、被忽略
    stmt = env.DB.prepare('INSERT OR IGNORE INTO results (ts, quiz_id, user_id, display_name, score, total, answers, submission_id) VALUES (?,?,?,?,?,?,?,?)').bind(...values);
  } else {
    // 每人限一次：「沒有紀錄才寫入」是資料庫裡的單一動作，同一個人在兩支手機同時送出也只會成功一次
    stmt = env.DB.prepare('INSERT OR IGNORE INTO results (ts, quiz_id, user_id, display_name, score, total, answers, submission_id) ' +
      'SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM results WHERE quiz_id = ? AND user_id = ?)').bind(...values, quizId, user.userId);
  }
  const res = await stmt.run();
  if (res.meta && res.meta.changes > 0) {
    if (!quiz.allowRetake) doneCache.set(quizId + '|' + user.userId, { rec: { score: r.score, total: r.total }, exp: Date.now() + DONE_TTL_MS });
    return { ok: true, score: r.score, total: r.total };
  }

  // 沒寫入：不是「同一次送出重送」，就是「這個人已經作答過」
  if (sid) {
    const same = await env.DB.prepare('SELECT score, total FROM results WHERE submission_id = ?').bind(sid).first();
    if (same) return { ok: true, score: same.score, total: same.total };
  }
  const existing = await findDone(env, user.userId, quizId);
  if (existing) return { ok: false, error: 'duplicate', score: existing.score, total: existing.total };
  throw new Error('write_failed');
}

function score(quiz, picks) {
  const items = flatItems(quiz);
  if (!Array.isArray(picks) || picks.length !== items.length) throw new Error('bad_answers');
  let earnedTotal = 0, maxTotal = 0;
  const answers = items.map(function (it, i) {
    const p = Number(picks[i]);
    const pick = Number.isInteger(p) && p >= 0 && p < it.options.length ? p : -1;
    const ratio = pick < 0 ? 0 : (it.partial ? it.partial[pick] : (pick === it.correctIndex ? 1 : 0));
    const earned = round2(it.points * ratio);
    earnedTotal += earned; maxTotal += it.points;
    return { id: it.id, pick: pick, text: pick >= 0 ? it.options[pick] : '', earned: earned, max: it.points, ok: earned >= it.points - 0.001 };
  });
  return { score: round2(earnedTotal), total: round2(maxTotal), answers: answers };
}


// ===== Webhook：免費回覆成績 =====
async function handleWebhook(request, raw, body, env, ctx) {
  if (env.CHANNEL_SECRET) {                      // 有設定 Channel secret 就驗證簽章：確認這個請求真的是 LINE 送的
    const sig = request.headers.get('x-line-signature') || '';
    if (!(await verifySignature(raw, env.CHANNEL_SECRET, sig))) {
      return new Response('bad signature', { status: 401, headers: CORS });
    }
  }
  // 先回 200 給 LINE，回覆訊息在背景處理
  ctx.waitUntil(processEvents(body.events, env).catch(function (e) { console.error(e && e.stack || e); }));
  return new Response('OK', { headers: CORS });
}

async function processEvents(events, env) {
  for (const ev of events) {
    try {
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') continue;
      const text = String(ev.message.text || '').trim();
      if (text.indexOf(QUERY_KEYWORD) !== 0) continue;      // 其他訊息不處理（保留給人工客服）

      const m = text.slice(QUERY_KEYWORD.length).match(/[A-Za-z0-9_-]+/);
      const quizId = m ? m[0] : '';
      const userId = ev.source && ev.source.userId;
      if (!userId || !ev.replyToken) continue;

      const rec = await withInit(env, function () {
        return env.DB.prepare('SELECT score, total FROM results WHERE user_id = ? AND (? = \'\' OR quiz_id = ?) ORDER BY id DESC LIMIT 1')
          .bind(userId, quizId, quizId).first();
      });
      await reply(env, ev.replyToken, rec ? MSG_SCORE(rec.score, rec.total) : MSG_NOT_FOUND);
    } catch (err) {
      console.error(err && err.stack || err);
    }
  }
}

async function reply(env, replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (env.CHANNEL_ACCESS_TOKEN || '') },
    body: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] })
  });
  if (!res.ok) console.error('Reply API failed: ' + res.status + ' ' + (await res.text()));
}

async function verifySignature(raw, secret, signature) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  let bin = '';
  new Uint8Array(mac).forEach(function (b) { bin += String.fromCharCode(b); });
  return safeEqual(btoa(bin), signature);
}

// ===== 管理後台 =====
async function adminList(b, env) {
  await requireAdmin(env, b);
  const out = await env.DB.batch([
    env.DB.prepare('SELECT name, items FROM categories ORDER BY name'),
    env.DB.prepare('SELECT json, updated_at FROM quizzes ORDER BY updated_at DESC')
  ]);
  const categories = {};
  out[0].results.forEach(function (r) { categories[r.name] = safeParse(r.items, []); });
  const quizzes = [];
  out[1].results.forEach(function (r) {
    const q = safeParse(r.json, null);
    if (q) { const n = normalizeQuiz(q); n.updatedAt = r.updated_at; quizzes.push(n); }
  });
  return { ok: true, categories: categories, quizzes: quizzes };
}

async function adminSaveCategory(b, env) {
  await requireAdmin(env, b);
  const name = String(b.name || '').trim();
  if (!name || name.length > 30 || /[\\\/:*?"<>|.#%]/.test(name)) throw new Error('bad_category_name');
  const seen = {}, items = [];
  (Array.isArray(b.items) ? b.items : []).forEach(function (x) {
    x = str(x, 100);
    if (x && !seen[x]) { seen[x] = 1; items.push(x); }
  });
  if (!items.length || items.length > 300) throw new Error('bad_category_items');
  await env.DB.prepare('INSERT INTO categories (name, items) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET items = excluded.items')
    .bind(name, JSON.stringify(items)).run();
  return { ok: true, items: items };
}

async function adminDeleteCategory(b, env) {
  await requireAdmin(env, b);
  const res = await env.DB.prepare('DELETE FROM categories WHERE name = ?').bind(String(b.name || '')).run();
  if (!res.meta.changes) throw new Error('not_found');
  return { ok: true };
}

async function adminSaveQuiz(b, env) {
  await requireAdmin(env, b);
  const quiz = cleanQuiz(b.quiz || {});
  const text = JSON.stringify(quiz);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT json, updated_at FROM quizzes WHERE quiz_id = ?').bind(quiz.quizId).first();

  // 內容完全一樣 = 網路重試造成的重送，直接回上次的結果，不當成衝突
  if (existing && existing.json === text) return { ok: true, updatedAt: existing.updated_at, quiz: quiz };

  if (b.isNew) {
    if (existing) throw new Error('exists');
    try {
      await env.DB.prepare('INSERT INTO quizzes (quiz_id, json, updated_at) VALUES (?, ?, ?)').bind(quiz.quizId, text, now).run();
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e && e.message))) throw new Error('exists');   // 兩個人同時建立同一個代碼
      throw e;
    }
  } else if (b.baseUpdatedAt) {
    // 樂觀鎖：只有「還是我讀到的那一版」才能覆蓋，否則代表別人剛改過
    const res = await env.DB.prepare('UPDATE quizzes SET json = ?, updated_at = ? WHERE quiz_id = ? AND updated_at = ?')
      .bind(text, now, quiz.quizId, String(b.baseUpdatedAt)).run();
    if (!res.meta.changes) throw new Error(existing ? 'conflict' : 'not_found');
  } else {
    await env.DB.prepare('INSERT INTO quizzes (quiz_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(quiz_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .bind(quiz.quizId, text, now).run();
  }
  quizCache.delete(quiz.quizId);
  return { ok: true, updatedAt: now, quiz: quiz };
}

/** 只改「是否開放作答」，題目與紀錄都不動。 */
async function adminSetClosed(b, env) {
  await requireAdmin(env, b);
  const id = cleanQuizId(b.quizId);
  const row = await env.DB.prepare('SELECT json, updated_at FROM quizzes WHERE quiz_id = ?').bind(id).first();
  if (!row) throw new Error('not_found');
  const q = JSON.parse(row.json);
  q.closed = !!b.closed;
  const quiz = cleanQuiz(q);
  const now = new Date().toISOString();
  // 只在「還是我讀到的那一版」時才更新，避免蓋掉別人同時做的修改
  const res = await env.DB.prepare('UPDATE quizzes SET json = ?, updated_at = ? WHERE quiz_id = ? AND updated_at = ?')
    .bind(JSON.stringify(quiz), now, id, row.updated_at).run();
  if (!res.meta.changes) throw new Error('conflict');
  quizCache.delete(id);
  return { ok: true, updatedAt: now, closed: quiz.closed };
}

async function adminDeleteQuiz(b, env) {
  await requireAdmin(env, b);
  const id = cleanQuizId(b.quizId);
  const res = await env.DB.prepare('DELETE FROM quizzes WHERE quiz_id = ?').bind(id).run();
  quizCache.delete(id);
  if (!res.meta.changes) throw new Error('not_found');
  return { ok: true };
}

async function actionResults(b, env) {
  await requireAdmin(env, b);
  const quizId = b.quizId ? cleanQuizId(b.quizId) : '';
  const out = await env.DB.batch([
    env.DB.prepare('SELECT quiz_id, COUNT(*) AS n FROM results GROUP BY quiz_id'),
    env.DB.prepare('SELECT ts, quiz_id, user_id, display_name, score, total, answers FROM results WHERE (? = \'\' OR quiz_id = ?) ORDER BY id DESC LIMIT ?')
      .bind(quizId, quizId, MAX_RESULT_ROWS)
  ]);
  const quizIds = {};
  out[0].results.forEach(function (r) { quizIds[r.quiz_id] = r.n; });
  const rows = out[1].results.reverse().map(function (r) {        // 由舊到新
    return { time: fmtTime(r.ts), quizId: r.quiz_id, userId: r.user_id, name: r.display_name || '',
      score: r.score, total: r.total, answers: safeParse(r.answers, []) };
  });
  return { ok: true, quizIds: quizIds, rows: rows };
}

/**
 * 清除作答紀錄——只能清「測驗已經被刪除」的紀錄。還存在的測驗，紀錄一律不能清。
 * 判斷「測驗還在不在」跟刪除寫在同一個 SQL 裡，就算前端送來的資料有誤，也刪不到還在使用的測驗。
 * quizId 空白 = 清掉全部「測驗已刪除」的紀錄；有填 = 只清那一個。
 */
async function adminPurgeResults(b, env) {
  await requireAdmin(env, b);
  const quizId = b.quizId ? cleanQuizId(b.quizId) : '';
  if (quizId) {
    const alive = await env.DB.prepare('SELECT 1 AS x FROM quizzes WHERE quiz_id = ?').bind(quizId).first();
    if (alive) throw new Error('quiz_still_exists');
  }
  const res = await env.DB.prepare("DELETE FROM results WHERE (? = '' OR quiz_id = ?) AND NOT EXISTS (SELECT 1 FROM quizzes q WHERE q.quiz_id = results.quiz_id)")
    .bind(quizId, quizId).run();
  doneCache.clear();
  return { ok: true, deleted: res.meta.changes };
}

/** 驗證並整理管理者送來的測驗；只保留我們定義的欄位。舊格式會先轉成新格式。 */
function cleanQuiz(input) {
  const q = normalizeQuiz(input || {});
  const quizId = cleanQuizId(q.quizId);
  const title = str(q.title, 100);
  if (!title) throw new Error('missing_title');
  if (!Array.isArray(q.questions) || !q.questions.length || q.questions.length > 100) throw new Error('bad_questions');
  const scoring = q.scoring === 'custom' ? 'custom' : 'equal';
  const equalPts = distribute(TOTAL_POINTS, q.questions.length);
  let totalItems = 0, sum = 0;

  const questions = q.questions.map(function (Q, i) {
    const n = i + 1;
    const raw = Array.isArray(Q.items) ? Q.items : [];
    const multi = !!Q.multi;
    if (!raw.length || raw.length > 20 || (!multi && raw.length !== 1)) throw new Error('bad_items_q' + n);
    totalItems += raw.length;

    const points = scoring === 'equal' ? equalPts[i] : round1(Number(Q.points));
    if (!(points > 0) || points > TOTAL_POINTS) throw new Error('bad_points_q' + n);
    sum += points;

    const subScoring = multi && Q.subScoring === 'custom' ? 'custom' : 'equal';
    let itemPts;
    if (!multi) itemPts = [points];
    else if (subScoring === 'equal') {
      itemPts = distribute(points, raw.length);
      if (itemPts.some(function (p) { return !(p > 0); })) throw new Error('bad_points_q' + n);      // 配分太少，平均後有子題拿到 0 分
    } else {
      itemPts = raw.map(function (x) { return round1(Number(x.points)); });
      if (itemPts.some(function (p) { return !(p > 0); })) throw new Error('bad_points_q' + n);
      if (Math.abs(itemPts.reduce(function (a, b) { return a + b; }, 0) - points) > 0.05) throw new Error('bad_subsum_q' + n);
    }

    const items = raw.map(function (x, j) {
      const label = multi ? n + '_' + (j + 1) : String(n);            // 錯誤代碼用，例如 q2_3 = 第 2 大題第 3 子題
      const options = Array.isArray(x.options) ? x.options.map(function (o) { return str(o, 200); }) : [];
      if (options.length < 2 || options.length > 10 || options.some(function (o) { return !o; })) throw new Error('bad_options_q' + label);
      let correctIndex = Number(x.correctIndex);
      let partial;
      if (Array.isArray(x.partial)) {
        // 部分給分：每個選項拿題目配分的幾成（0～1），至少要有一個選項拿滿分
        if (x.partial.length !== options.length) throw new Error('bad_partial_q' + label);
        partial = x.partial.map(function (r) { return Math.round(Number(r) * 1e6) / 1e6; });
        if (partial.some(function (r) { return !(r >= 0 && r <= 1); })) throw new Error('bad_partial_q' + label);
        const best = Math.max.apply(null, partial);
        if (best < 0.999999) throw new Error('no_full_option_q' + label);
        correctIndex = partial.indexOf(best);
      }
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) throw new Error('bad_correct_q' + label);
      const out = { id: multi ? 'q' + n + '-' + (j + 1) : 'q' + n, mode: x.mode === 'auto' ? 'auto' : 'manual',
        question: str(x.question, 500), options: options, correctIndex: correctIndex, points: itemPts[j] };
      if (partial) out.partial = partial;
      if (out.mode === 'auto') { out.category = str(x.category, 60); out.answer = str(x.answer, 200); }
      return out;
    });
    return { id: 'q' + n, title: multi ? str(Q.title, 500) : '', multi: multi, subScoring: subScoring, points: points, items: items };
  });

  if (totalItems > 200) throw new Error('bad_questions');
  if (scoring === 'custom' && Math.abs(sum - TOTAL_POINTS) > 0.05) throw new Error('bad_total');
  return { quizId: quizId, title: title, description: str(q.description, 500), allowRetake: !!q.allowRetake, closed: !!q.closed, scoring: scoring, questions: questions };
}


// ===== 資料存取 =====
async function getQuiz(env, quizId) {
  const hit = quizCache.get(quizId);
  if (hit && hit.exp > Date.now()) return hit.quiz;
  const row = await env.DB.prepare('SELECT json FROM quizzes WHERE quiz_id = ?').bind(quizId).first();
  if (!row) { quizCache.delete(quizId); return null; }
  const quiz = normalizeQuiz(JSON.parse(row.json));
  quizCache.set(quizId, { quiz: quiz, exp: Date.now() + QUIZ_TTL_MS });
  return quiz;
}

/** 這個人在這場「限一次」測驗有沒有作答過（有紀錄才快取，所以不會把「還沒作答」記成錯的）。 */
async function findDone(env, userId, quizId) {
  const key = quizId + '|' + userId;
  const hit = doneCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.rec;
  const row = await env.DB.prepare('SELECT score, total FROM results WHERE quiz_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1')
    .bind(quizId, userId).first();
  if (!row) return null;
  const rec = { score: row.score, total: row.total };
  doneCache.set(key, { rec: rec, exp: Date.now() + DONE_TTL_MS });
  return rec;
}

// ===== 第一次使用：自動建立資料表 =====
async function withInit(env, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await initDb(env);
    return await fn();
  }
}

async function initDb(env) {
  await env.DB.batch(SCHEMA.map(function (s) { return env.DB.prepare(s); }));
  if (!SEED) return;
  const counts = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM categories'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM quizzes')
  ]);
  const stmts = [];
  if (!counts[0].results[0].n) {
    Object.keys(SEED.categories).forEach(function (n) {
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO categories (name, items) VALUES (?, ?)').bind(n, JSON.stringify(SEED.categories[n])));
    });
  }
  if (!counts[1].results[0].n) {
    const q = cleanQuiz(SEED.quiz);
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO quizzes (quiz_id, json, updated_at) VALUES (?, ?, ?)').bind(q.quizId, JSON.stringify(q), new Date().toISOString()));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ===== 工具 =====
async function verifyUser(accessToken) {
  if (!accessToken) throw new Error('missing_token');
  const key = await sha256Hex(accessToken);        // 快取的 key 是 token 的雜湊值，不存 token 本身
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.user;

  const res = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status === 401 || res.status === 400 || res.status === 403) throw new Error('invalid_token');
  if (!res.ok) throw new Error('line_unavailable');
  const p = await res.json();
  const user = { userId: p.userId, displayName: p.displayName || '' };
  if (tokenCache.size > 2000) tokenCache.clear();
  tokenCache.set(key, { user: user, exp: Date.now() + TOKEN_TTL_MS });
  return user;
}

// ===== 後台登入保護 =====
// 1) 管理密碼只在 admin_login 用到：通過後換一張「登入憑證」（HMAC 簽章、7 天有效），之後的管理動作都帶憑證。
// 2) 憑證的簽章金鑰 = 資料庫裡的隨機值 + 管理密碼：換掉 ADMIN_KEY，所有舊憑證立刻失效。
// 3) 登入失敗會依來源 IP 計次並鎖定；有設 TURNSTILE_SECRET 時，還要先通過「我不是機器人」驗證。

async function requireAdmin(env, b) {
  if (String(env.ADMIN_KEY || '') && await checkSession(env, b && b.session)) return;
  throw new Error('forbidden');
}

async function adminLogin(b, env, request) {
  const real = String(env.ADMIN_KEY || '');
  const ip = clientIp(request);
  const slot = await takeLoginSlot(env, ip);                                  // 先領名額（同時送很多次也只有前幾次能進來）
  if (!slot.ok) return { ok: false, error: 'too_many_attempts', retryAfter: slot.retryAfter };

  let error = '';
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, b.turnstile))) error = 'captcha_failed';
  else if (!(real && safeEqual(await sha256Hex(String(b.key || '').slice(0, 500)), await sha256Hex(real)))) error = 'forbidden';
  if (error) {
    await new Promise(function (r) { setTimeout(r, 600); });                  // 錯誤時故意慢一點
    const wait = await lockedFor(env, ip);
    return wait > 0 ? { ok: false, error: 'too_many_attempts', retryAfter: wait } : { ok: false, error: error };
  }

  await guardDb(env, function () { return env.DB.prepare('DELETE FROM login_guard WHERE ip = ?').bind(ip).run(); });
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  return { ok: true, session: await signSession(env, exp), expiresAt: exp * 1000 };
}

/** 登入來源：IPv4 用完整位址；IPv6 同一個 /64 網段視為同一個來源（攻擊者通常握有整段位址可以輪流換）。 */
function clientIp(request) {
  const ip = String(request.headers.get('CF-Connecting-IP') || 'unknown').trim().toLowerCase().split('%')[0];
  if (ip.indexOf(':') < 0) return ip;
  let parts;
  if (ip.indexOf('::') >= 0) {
    const sides = ip.split('::'), l = sides[0] ? sides[0].split(':') : [], r = sides[1] ? sides[1].split(':') : [];
    parts = l.concat(new Array(Math.max(0, 8 - l.length - r.length)).fill('0'), r);
  } else parts = ip.split(':');
  return parts.slice(0, 4).map(function (p) { return p.padStart(4, '0'); }).join(':') + '::/64';
}

/** 這兩張表是後來才加的：舊資料庫第一次用到時，單獨補建（不會重跑範例資料）。 */
async function guardDb(env, fn) {
  try { return await fn(); } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    await env.DB.batch(GUARD_SCHEMA.map(function (q) { return env.DB.prepare(q); }));
    return await fn();
  }
}

/**
 * 領一個「嘗試登入」的名額。次數 +1 與「要不要鎖」在資料庫裡一次完成，所以同時送 100 次也只有前 5 次進得去：
 *   第 5 次起鎖 5 分鐘；之後每次鎖期結束只能再試 1 次，第 8 次起鎖 30 分鐘、第 12 次起鎖 24 小時。
 *   24 小時沒有再失敗，計數自動歸零。登入成功會清掉計數。
 */
async function takeLoginSlot(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  return guardDb(env, async function () {
    await env.DB.prepare('INSERT OR IGNORE INTO login_guard (ip, fails, first_at, locked_until) VALUES (?, 0, ?, 0)').bind(ip, now).run();
    // 24 小時內都沒再失敗（而且沒被鎖）：計數歸零
    await env.DB.prepare('UPDATE login_guard SET fails = 0, first_at = ? WHERE ip = ? AND first_at < ? AND locked_until <= ?').bind(now, ip, now - 86400, now).run();
    // 次數 +1 與「要不要鎖」一次完成；正在鎖定中（locked_until 還沒到）的來源這句不會生效
    const res = await env.DB.prepare(
      'UPDATE login_guard SET fails = fails + 1, locked_until = CASE WHEN fails + 1 >= 12 THEN ? + 86400 WHEN fails + 1 >= 8 THEN ? + 1800 WHEN fails + 1 >= 5 THEN ? + 300 ELSE 0 END ' +
      'WHERE ip = ? AND locked_until <= ?').bind(now, now, now, ip, now).run();
    if (res.meta && res.meta.changes > 0) {
      if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM login_guard WHERE locked_until < ? AND first_at < ?').bind(now, now - 172800).run();   // 順手清掉很久以前的紀錄
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.max(1, (await lockedFor(env, ip)) || 60) };
  });
}

async function lockedFor(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await guardDb(env, function () { return env.DB.prepare('SELECT locked_until FROM login_guard WHERE ip = ?').bind(ip).first(); });
  return row ? Math.max(0, row.locked_until - now) : 0;
}

async function verifyTurnstile(env, token) {
  if (!token || String(token).length > 2048) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token) })
    });
    const j = await res.json();
    return !!j.success;
  } catch (e) { console.error('turnstile verify failed', e && e.message); return false; }
}

// ---- 登入憑證：「到期時間.簽章」 ----
let sessionKeyCache = null;
async function getSessionKey(env) {
  const adm = String(env.ADMIN_KEY || '');
  if (sessionKeyCache && sessionKeyCache.exp > Date.now() && sessionKeyCache.adm === adm) return sessionKeyCache.key;
  const read = function () { return env.DB.prepare("SELECT v FROM kv WHERE k = 'session_secret'").first(); };
  let row = await guardDb(env, read);
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('session_secret', ?)").bind(randomHex(32)).run();
    row = await read();
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(row.v + '|' + adm), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  sessionKeyCache = { key: key, adm: adm, exp: Date.now() + 10 * 60 * 1000 };
  return key;
}
async function signSession(env, exp) {
  const sig = await crypto.subtle.sign('HMAC', await getSessionKey(env), new TextEncoder().encode('admin-session|' + exp));
  return exp + '.' + Array.from(new Uint8Array(sig)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}
async function checkSession(env, token) {
  const m = /^(\d{9,12})\.[0-9a-f]{64}$/.exec(String(token || ''));
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return safeEqual(await signSession(env, m[1]), token);
}
function randomHex(nBytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(nBytes))).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}

function cleanQuizId(id) {
  id = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new Error('bad_quiz_id');
  return id;
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('sv-SE', { timeZone: TZ });   // 2026-09-19 20:15:30
}

/** 長度相同時逐字元比對，不會因為第幾個字不同而回應時間不同。 */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
