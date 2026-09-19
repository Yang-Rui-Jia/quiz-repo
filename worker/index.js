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
 *
 * 資料表在第一次被呼叫時自動建立，並放入一場示範測驗 demo，不需要手動執行 SQL。
 *
 * 玩家端流程：
 *   start  ：驗證 LINE 身分 → 沒作答過（或允許重考）才回傳題目（不含正解）
 *   submit ：收到玩家選的答案 → 在這裡比對正解、算分、寫入資料庫 → 回傳分數
 *   webhook：玩家在聊天室送出「查詢成績」→ 用 Reply API 免費回覆成績
 *
 * 安全設計：玩家身分（userId）不是前端傳來的，而是拿玩家的 LIFF access token
 * 直接問 LINE 伺服器；管理動作一律要帶 ADMIN_KEY。
 */

// ===== 可調整的設定 =====
const TZ = 'Asia/Taipei';
const QUERY_KEYWORD = '查詢成績';            // 玩家按鈕預填的關鍵字，要和 play/index.html 一致
const MSG_SCORE = (score, total) => '您已完成作答，成績：' + score + '/' + total;
const MSG_NOT_FOUND = '找不到您的作答紀錄。請先掃描 QRCode 完成測驗，作答後再查詢成績。';
const MAX_RESULT_ROWS = 5000;
const QUIZ_TTL_MS = 10 * 1000;               // 題目在記憶體裡快取的時間：後台改題目後，最多這麼久玩家端就會更新
const TOKEN_TTL_MS = 5 * 60 * 1000;          // 「這個 token 是誰」的快取時間
const DONE_TTL_MS = 60 * 1000;               // 「已作答過」的快取時間

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

// 第一次啟動時放進去的範例資料（只有在「題庫」「測驗」是空的時候才會放）
const SEED = {"categories":{"低硬度岩石":["石灰岩","頁岩","砂岩","泥岩","板岩","白雲岩","礫岩","凝灰岩"],"常見酒類":["啤酒","紅酒","白酒","清酒","威士忌","伏特加","高粱酒","琴酒","白蘭地","龍舌蘭"],"高硬度岩石":["花崗岩","石英岩","玄武岩","輝長岩","片麻岩","角閃岩","安山岩","流紋岩"]},"quiz":{"quizId":"demo","title":"示範測驗：岩石與酒類","description":"這是系統內建的示範測驗，共 10 題。作答完成後按「檢視作答總覽」確認，再送出即可看到成績。","allowRetake":true,"questions":[{"id":"q1","mode":"auto","question":"請選出正確答案","category":"高硬度岩石","answer":"花崗岩","optionCount":5,"options":["流紋岩","輝長岩","角閃岩","玄武岩","花崗岩"],"correctIndex":4},{"id":"q2","mode":"auto","question":"請選出正確答案","category":"高硬度岩石","answer":"玄武岩","optionCount":5,"options":["玄武岩","花崗岩","流紋岩","角閃岩","石英岩"],"correctIndex":0},{"id":"q3","mode":"auto","question":"請選出正確答案","category":"低硬度岩石","answer":"石灰岩","optionCount":5,"options":["頁岩","凝灰岩","砂岩","泥岩","石灰岩"],"correctIndex":4},{"id":"q4","mode":"auto","question":"請選出正確答案","category":"低硬度岩石","answer":"頁岩","optionCount":5,"options":["凝灰岩","石灰岩","泥岩","板岩","頁岩"],"correctIndex":4},{"id":"q5","mode":"manual","question":"以下哪種酒精飲料的酒精濃度最低？","options":["啤酒","威士忌","琴酒","高粱酒","伏特加"],"correctIndex":0},{"id":"q6","mode":"auto","question":"請選出正確答案","category":"常見酒類","answer":"清酒","optionCount":5,"options":["高粱酒","清酒","威士忌","白蘭地","啤酒"],"correctIndex":1},{"id":"q7","mode":"manual","question":"下列哪一種岩石屬於火成岩？","options":["石灰岩","花崗岩","大理岩","板岩","砂岩"],"correctIndex":1},{"id":"q8","mode":"manual","question":"下列哪一種岩石屬於沉積岩？","options":["玄武岩","砂岩","石英岩","片麻岩","安山岩"],"correctIndex":1},{"id":"q9","mode":"manual","question":"摩氏硬度表中，硬度最高的礦物是？","options":["螢石","滑石","方解石","石英","鑽石"],"correctIndex":4},{"id":"q10","mode":"manual","question":"威士忌的主要原料是？","options":["甘蔗","龍舌蘭","葡萄","穀物","馬鈴薯"],"correctIndex":3}]}};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, items TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS quizzes (quiz_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS results (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, quiz_id TEXT NOT NULL, user_id TEXT NOT NULL, ' +
    'display_name TEXT, score INTEGER NOT NULL, total INTEGER NOT NULL, answers TEXT, submission_id TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_results_user ON results (quiz_id, user_id, id)',
  // 同一次送出（網路重試）只會寫入一筆：由資料庫保證，不靠程式判斷
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_results_sid ON results (submission_id) WHERE submission_id IS NOT NULL AND submission_id <> ''"
];

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
      return json(await withInit(env, function () { return route(body || {}, env); }));
    } catch (err) {
      const msg = String(err && err.message || err);
      // 我們自己丟的錯誤都是像 forbidden、bad_quiz_id 這種代碼；其他（例如資料庫錯誤）不把細節傳給外面
      if (!/^[a-z0-9_]+$/.test(msg)) { console.error(err && err.stack || err); return json({ ok: false, error: 'server_error' }); }
      return json({ ok: false, error: msg });
    }
  }
};

async function route(b, env) {
  switch (b.action) {
    // 玩家
    case 'start':                return actionStart(b, env);
    case 'submit':               return actionSubmit(b, env);
    // 管理後台
    case 'results':              return actionResults(b, env);
    case 'admin_list':           return adminList(b, env);
    case 'admin_saveCategory':   return adminSaveCategory(b, env);
    case 'admin_deleteCategory': return adminDeleteCategory(b, env);
    case 'admin_saveQuiz':       return adminSaveQuiz(b, env);
    case 'admin_deleteQuiz':     return adminDeleteQuiz(b, env);
    default:                     return { ok: false, error: 'unknown_action' };
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS) });
}

// ===== 玩家：進場（查重 + 取題目） =====
async function actionStart(b, env) {
  const quizId = cleanQuizId(b.quizId);

  if (b.key) {                                   // 管理者預覽：不驗證 LINE、不記錄
    await requireAdmin(env, b.key);
    const q = await getQuiz(env, quizId);
    if (!q) return { ok: false, error: 'quiz_not_found' };
    return { ok: true, submitted: false, quiz: publicQuiz(q), preview: true };
  }

  const both = await Promise.all([getQuiz(env, quizId), verifyUser(b.token)]);   // 兩件事同時做
  const quiz = both[0], user = both[1];
  if (!quiz) return { ok: false, error: 'quiz_not_found' };
  if (!quiz.allowRetake) {                       // 允許重考的測驗根本不用查紀錄
    const rec = await findDone(env, user.userId, quizId);
    if (rec) return { ok: true, submitted: true, score: rec.score, total: rec.total };
  }
  return { ok: true, submitted: false, quiz: publicQuiz(quiz) };
}

/** 給玩家的題目：只有題目與選項，沒有正解、類別。 */
function publicQuiz(q) {
  return {
    quizId: q.quizId,
    title: q.title,
    description: q.description || '',
    questions: q.questions.map(function (x) { return { id: x.id, question: x.question, options: x.options }; })
  };
}

// ===== 玩家：送出答案（後端算分） =====
async function actionSubmit(b, env) {
  const quizId = cleanQuizId(b.quizId);

  if (b.key) {                                   // 管理者預覽：算給他看，不寫入
    await requireAdmin(env, b.key);
    const q = await getQuiz(env, quizId);
    if (!q) throw new Error('quiz_not_found');
    const r = score(q, b.picks);
    return { ok: true, score: r.score, total: r.total, preview: true };
  }

  const both = await Promise.all([getQuiz(env, quizId), verifyUser(b.token)]);
  const quiz = both[0], user = both[1];
  if (!quiz) throw new Error('quiz_not_found');
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
  if (!Array.isArray(picks) || picks.length !== quiz.questions.length) throw new Error('bad_answers');
  let s = 0;
  const answers = quiz.questions.map(function (q, i) {
    const p = Number(picks[i]);
    const pick = Number.isInteger(p) && p >= 0 && p < q.options.length ? p : -1;
    const ok = pick === q.correctIndex;
    if (ok) s++;
    return { id: q.id, pick: pick, text: pick >= 0 ? q.options[pick] : '', ok: ok };
  });
  return { score: s, total: quiz.questions.length, answers: answers };
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
  await requireAdmin(env, b.key);
  const out = await env.DB.batch([
    env.DB.prepare('SELECT name, items FROM categories ORDER BY name'),
    env.DB.prepare('SELECT json, updated_at FROM quizzes ORDER BY updated_at DESC')
  ]);
  const categories = {};
  out[0].results.forEach(function (r) { categories[r.name] = safeParse(r.items, []); });
  const quizzes = [];
  out[1].results.forEach(function (r) {
    const q = safeParse(r.json, null);
    if (q) { q.updatedAt = r.updated_at; quizzes.push(q); }
  });
  return { ok: true, categories: categories, quizzes: quizzes };
}

async function adminSaveCategory(b, env) {
  await requireAdmin(env, b.key);
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
  await requireAdmin(env, b.key);
  const res = await env.DB.prepare('DELETE FROM categories WHERE name = ?').bind(String(b.name || '')).run();
  if (!res.meta.changes) throw new Error('not_found');
  return { ok: true };
}

async function adminSaveQuiz(b, env) {
  await requireAdmin(env, b.key);
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

async function adminDeleteQuiz(b, env) {
  await requireAdmin(env, b.key);
  const id = cleanQuizId(b.quizId);
  const res = await env.DB.prepare('DELETE FROM quizzes WHERE quiz_id = ?').bind(id).run();
  quizCache.delete(id);
  if (!res.meta.changes) throw new Error('not_found');
  return { ok: true };
}

async function actionResults(b, env) {
  await requireAdmin(env, b.key);
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

/** 驗證並整理管理者送來的測驗；只保留我們定義的欄位。 */
function cleanQuiz(q) {
  const quizId = cleanQuizId(q.quizId);
  const title = str(q.title, 100);
  if (!title) throw new Error('missing_title');
  if (!Array.isArray(q.questions) || !q.questions.length || q.questions.length > 100) throw new Error('bad_questions');
  const questions = q.questions.map(function (x, i) {
    const options = Array.isArray(x.options) ? x.options.map(function (o) { return str(o, 200); }) : [];
    if (options.length < 2 || options.length > 10 || options.some(function (o) { return !o; })) throw new Error('bad_options_q' + (i + 1));
    const ci = Number(x.correctIndex);
    if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) throw new Error('bad_correct_q' + (i + 1));
    const out = { id: 'q' + (i + 1), mode: x.mode === 'auto' ? 'auto' : 'manual', question: str(x.question, 500), options: options, correctIndex: ci };
    if (out.mode === 'auto') { out.category = str(x.category, 60); out.answer = str(x.answer, 200); }
    else if (!out.question) throw new Error('missing_question_q' + (i + 1));
    return out;
  });
  return { quizId: quizId, title: title, description: str(q.description, 500), allowRetake: !!q.allowRetake, questions: questions };
}

// ===== 資料存取 =====
async function getQuiz(env, quizId) {
  const hit = quizCache.get(quizId);
  if (hit && hit.exp > Date.now()) return hit.quiz;
  const row = await env.DB.prepare('SELECT json FROM quizzes WHERE quiz_id = ?').bind(quizId).first();
  if (!row) { quizCache.delete(quizId); return null; }
  const quiz = JSON.parse(row.json);
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

/** 管理密碼錯誤或沒設定一律拒絕；錯誤時故意延遲，拖慢暴力猜測。 */
async function requireAdmin(env, key) {
  const real = String(env.ADMIN_KEY || '');
  if (real && safeEqual(await sha256Hex(String(key || '')), await sha256Hex(real))) return;
  await new Promise(function (r) { setTimeout(r, 600); });
  throw new Error('forbidden');
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
