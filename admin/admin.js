(function () {
'use strict';

var cfg = window.APP_CONFIG || {};
var LETTERS = 'ABCDEFGHIJ';
var MAX_OPTIONS = 8;
var $ = function (s, el) { return (el || document).querySelector(s); };
var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k) || ''; if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return ''; }
function toast(msg, isErr) {
  var d = document.createElement('div');
  if (isErr) d.className = 'err';
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(function () { d.remove(); }, isErr ? 6000 : 3000);
}
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function busy(btn, fn) {
  btn.disabled = true;
  return Promise.resolve().then(fn).catch(function (e) { toast(e.message || String(e), true); })
    .then(function () { btn.disabled = false; });
}

// =====================================================================
//  後端 API（Google Apps Script）
//  題庫與測驗都存在後端資料庫，不在公開的網頁裡；每次呼叫都帶管理密碼。
// =====================================================================
var ERR = {
  forbidden: '管理密碼不正確',
  conflict: '儲存衝突：這場測驗剛剛被別人（或別的視窗）修改過。請重新整理頁面後再編輯。',
  exists: '這個測驗代碼已經存在，請換一個',
  missing_title: '請輸入測驗名稱',
  bad_quiz_id: '測驗代碼只能用英文、數字、- 與 _',
  server_error: '伺服器發生錯誤，請稍後再試一次',
  not_found: '找不到這筆資料，可能已經被刪除。請重新整理頁面確認',
  quiz_closed: '這場測驗已經關閉',
  bad_category_name: '類別名稱不合法',
  bad_category_items: '類別清單是空的，或超過 300 項',
  bad_questions: '題目數量不正確（至少 1 大題）',
  bad_total: '各大題配分加總必須剛好 100 分'
};
function errText(code) {
  code = String(code || '');
  if (ERR[code]) return ERR[code];
  var m = code.match(/^(bad_options|bad_correct|bad_partial|no_full_option|bad_points|bad_subsum|bad_items)_q(\d+)(?:_(\d+))?$/);
  if (m) {
    return '第 ' + m[2] + ' 大題' + (m[3] ? '第 ' + m[3] + ' 子題' : '') + '有問題：' + {
      bad_options: '選項不完整', bad_correct: '沒有選定正解', bad_partial: '部分給分的設定不正確',
      no_full_option: '部分給分時，至少要有一個選項拿滿分', bad_points: '配分不正確', bad_subsum: '子題配分加總必須等於大題配分', bad_items: '子題數量不正確'
    }[m[1]];
  }
  return '伺服器回應：' + code;
}
function apiUrl() { return cfg.apiUrl || cfg.gasUrl || ''; }   // 新後端(Cloudflare)用 apiUrl；舊的 gasUrl 只是相容
function call(action, payload) {
  if (!apiUrl()) return Promise.reject(new Error('系統尚未設定完成（config.js 缺少 apiUrl）'));
  var rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  var text = JSON.stringify(Object.assign({ action: action, key: S.key, rid: rid }, payload || {}));
  var attempt = 0;
  // 用 text/plain 送 JSON 可避免瀏覽器做 CORS 預檢，GAS 才收得到。
  // 網路瞬間斷掉，或（舊的 Google 後端）偶爾回一個不是 JSON 的空殼回應：
  // 
  // 自動重試最多 4 次。每次重試帶同一個 rid，後端認得是同一次請求，儲存/刪除不會重複執行。
  function once() {
    return fetch(apiUrl(), { method: 'POST', body: text })
      .then(function (r) { return r.text(); })
      .then(function (t) { return JSON.parse(t); })
      .catch(function () {
        if (++attempt < 4) return new Promise(function (res) { setTimeout(res, 300 * attempt); }).then(once);
        throw new Error('連線不穩定，已自動重試仍失敗，請稍後再試');
      });
  }
  return once().then(function (j) {
    if (!j.ok) { var e = new Error(errText(j.error)); e.code = j.error; throw e; }
    return j;
  });
}

// =====================================================================
//  狀態
// =====================================================================
var S = {
  key: '',
  cats: {},          // name -> {items[], loaded, isNew}
  catNames: [],
  quizzes: [],       // [{id, updatedAt, data}]
  selCat: '',
  ed: null,          // 正在編輯的測驗 {isNew, updatedAt, data}
  dirty: false,
  tab: 'quizzes'
};

// =====================================================================
//  登入 / 連線
// =====================================================================
function showLogin(err) {
  $('#boot').classList.add('hidden');
  $('#tabs').classList.add('hidden'); $('#who').classList.add('hidden');
  $$('main > section').forEach(function (s) { s.classList.toggle('hidden', s.id !== 'p-login'); });
  $('#loginErr').classList.toggle('hidden', !err);
  if (err) $('#loginErr').textContent = err;
}

function applyList(j) {
  S.catNames = Object.keys(j.categories).sort();
  S.cats = {};
  S.catNames.forEach(function (n) { S.cats[n] = { items: j.categories[n], loaded: true }; });
  S.quizzes = j.quizzes.map(function (q) { return { id: q.quizId, updatedAt: q.updatedAt || '', data: q }; })
    .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
}

function connect(key) {
  key = key.trim();
  if (!key) return Promise.reject(new Error('請輸入管理密碼'));
  S.key = key;
  return call('admin_list').then(function (j) {
    applyList(j);
    $('#boot').classList.add('hidden');
    store('quizAdminKey', key);                  // 玩家頁的「預覽」也會用到它
    $('#whoText').textContent = '👤 已登入';
    $('#tabs').classList.remove('hidden'); $('#who').classList.remove('hidden');
    switchTab('quizzes');
  });
}

$('#btnConnect').onclick = function () {
  var btn = this;
  btn.disabled = true;
  connect($('#inKey').value).catch(function (e) {
    S.key = '';
    showLogin(e.message);
  }).then(function () { btn.disabled = false; });
};
$('#inKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnConnect').click(); });
$('#btnLogout').onclick = function () {
  store('quizAdminKey', null); S.key = '';
  $('#inKey').value = '';
  S.ed = null;
  showLogin();
};
// =====================================================================
//  分頁
// =====================================================================
function switchTab(name) {
  if (S.ed && S.dirty && name !== 'quizzes' && !confirm('目前的測驗還沒儲存，確定要離開嗎？')) return;
  stopAuto();
  S.tab = name;
  $$('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
  $$('main > section').forEach(function (s) { s.classList.toggle('hidden', s.id !== 'p-' + name); });
  if (name === 'quizzes') renderQuizList();
  if (name === 'cats') renderCats();
  if (name === 'publish') renderPublish();
  if (name === 'results') renderResultsInit();
}
$('#tabs').onclick = function (e) {
  var b = e.target.closest('button[data-tab]');
  if (b) { if (S.ed && b.dataset.tab !== 'quizzes') { if (S.dirty && !confirm('目前的測驗還沒儲存，確定要離開嗎？')) return; leaveEditor(); } switchTab(b.dataset.tab); }
};

// =====================================================================
//  題庫（類別）
// =====================================================================
function ensureCat(name) { return Promise.resolve(S.cats[name] || null); }
function parseItems(text) {
  var seen = {}, out = [];
  String(text).split(/\r?\n/).forEach(function (l) {
    l = l.trim();
    if (l && !seen[l]) { seen[l] = 1; out.push(l); }
  });
  return out;
}

function renderCats() {
  $('#catList').innerHTML = S.catNames.map(function (n) {
    var c = S.cats[n];
    return '<button data-cat="' + esc(n) + '" class="' + (n === S.selCat ? 'on' : '') + '"><span>' + esc(n) +
      '</span><span class="n">' + (c.loaded || c.isNew ? c.items.length : '') + '</span></button>';
  }).join('') || '<p class="sub">還沒有任何類別</p>';
  renderCatEditor();
}

function renderCatEditor() {
  var box = $('#catEditor');
  var c = S.cats[S.selCat];
  if (!c) { box.innerHTML = '<p class="sub">← 從左邊選一個類別，或新增一個。</p>'; return; }
  if (!c.loaded && !c.isNew) {
    box.innerHTML = '<p class="sub">載入中…</p>';
    ensureCat(S.selCat).then(function () { renderCats(); }).catch(function (e) { toast(e.message, true); });
    return;
  }
  box.innerHTML =
    '<div class="row"><h2 style="font-size:17px">' + esc(S.selCat) + '</h2><span class="badge" id="catCount"></span><span class="sp"></span>' +
    '<button class="btn sm danger" id="btnDelCat">刪除類別</button></div>' +
    '<label class="f" style="margin-top:10px">答案清單 <small>（一行一個項目；空白行與重複會自動移除）</small>' +
    '<textarea id="catText" rows="14" spellcheck="false">' + esc(c.items.join('\n')) + '</textarea></label>' +
    '<div class="row"><button class="btn primary" id="btnSaveCat">儲存</button>' +
    '<span class="sub" style="margin:0">自動生成題需要類別至少有「選項數」個項目（預設 5 個）。</span></div>';
  var upd = function () { $('#catCount').textContent = parseItems($('#catText').value).length + ' 項'; };
  $('#catText').oninput = upd; upd();
}

$('#catList').onclick = function (e) {
  var b = e.target.closest('[data-cat]');
  if (!b) return;
  S.selCat = b.dataset.cat;
  renderCats();
};
$('#btnNewCat').onclick = function () {
  var name = $('#newCatName').value.trim();
  if (!name) return toast('請輸入類別名稱', true);
  if (/[\\/:*?"<>|.#%]/.test(name) || name.length > 30) return toast('類別名稱不能含 \\ / : * ? " < > | . # % ，且不超過 30 字', true);
  if (S.cats[name]) return toast('已經有這個類別了', true);
  S.cats[name] = { items: [], loaded: true, isNew: true };
  S.catNames.push(name); S.catNames.sort();
  S.selCat = name;
  $('#newCatName').value = '';
  renderCats();
  toast('已建立「' + name + '」，輸入項目後按儲存');
};
$('#catEditor').onclick = function (e) {
  var name = S.selCat, c = S.cats[name];
  if (e.target.id === 'btnSaveCat') {
    busy(e.target, function () {
      var items = parseItems($('#catText').value);
      if (!items.length) throw new Error('清單是空的，至少要有一個項目');
      return call('admin_saveCategory', { name: name, items: items }).then(function (j) {
        c.items = j.items; c.isNew = false; c.loaded = true;
        renderCats();
        toast('已儲存「' + name + '」（' + j.items.length + ' 項）' + (j.items.length < 5 ? '。注意：少於 5 項，無法用來自動生成 5 選項的題目' : ''));
      });
    });
  }
  if (e.target.id === 'btnDelCat') {
    if (!confirm('確定刪除類別「' + name + '」？\n（已建立的測驗不受影響，因為選項已經寫進測驗裡了）')) return;
    busy(e.target, function () {
      var p = c.isNew ? Promise.resolve() : call('admin_deleteCategory', { name: name });
      return p.then(function () {
        delete S.cats[name]; S.catNames = S.catNames.filter(function (n) { return n !== name; });
        S.selCat = ''; renderCats(); toast('已刪除');
      });
    });
  }
};

// =====================================================================
//  測驗列表
// =====================================================================
function renderQuizList() {
  $('#quizListView').classList.toggle('hidden', !!S.ed);
  $('#quizEditView').classList.toggle('hidden', !S.ed);
  if (S.ed) return;
  $('#quizList').innerHTML = S.quizzes.map(function (q) {
    var d = q.data;
    return '<div class="card"><div class="qrow"><div class="t"><b>' + esc(d.title || q.id) + '</b>' +
      '<div><span class="mono">' + esc(q.id) + '</span>　' + countText(d) + '　' +
      (d.allowRetake ? '<span class="badge a">可重複作答</span>' : '<span class="badge g">每人限一次</span>') +
      (d.closed ? '　<span class="badge r">🔒 已關閉</span>' : '') + '</div></div>' +
      '<button class="btn sm" data-act="toggle" data-id="' + esc(q.id) + '">' + (d.closed ? '重新開放' : '關閉作答') + '</button>' +
      '<button class="btn sm" data-act="edit" data-id="' + esc(q.id) + '">編輯</button>' +
      '<button class="btn sm" data-act="pub" data-id="' + esc(q.id) + '">發布 / QRCode</button>' +
      '<button class="btn sm" data-act="copy" data-id="' + esc(q.id) + '">複製</button>' +
      '<button class="btn sm danger" data-act="del" data-id="' + esc(q.id) + '">刪除</button></div></div>';
  }).join('') || '<div class="card"><p class="sub" style="margin:0">還沒有任何測驗。按右上角「建立新測驗」開始。</p></div>';
}

function countText(d) {
  var qs = d.questions || [], items = 0;
  qs.forEach(function (Q) { items += Array.isArray(Q.items) ? Q.items.length : 1; });
  return qs.length + ' 大題' + (items !== qs.length ? '（共 ' + items + ' 個小題）' : '') + '・滿分 100';
}

function findQuiz(id) { return S.quizzes.filter(function (q) { return q.id === id; })[0]; }

$('#quizList').onclick = function (e) {
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var q = findQuiz(b.dataset.id);
  if (!q) return;
  if (b.dataset.act === 'edit') openEditor(false, q);
  if (b.dataset.act === 'toggle') {
    var closing = !q.data.closed;
    if (closing && !confirm('確定關閉「' + (q.data.title || q.id) + '」？\n關閉後，玩家掃碼只會看到「這場測驗已結束」。題目和作答紀錄都會保留，隨時可以重新開放。')) return;
    busy(b, function () {
      return call('admin_setClosed', { quizId: q.id, closed: closing }).then(function (j) {
        q.data.closed = j.closed; q.updatedAt = j.updatedAt; q.data.updatedAt = j.updatedAt;
        renderQuizList(); toast(closing ? '已關閉作答（幾秒內生效）' : '已重新開放作答');
      });
    });
  }
  if (b.dataset.act === 'pub') { switchTab('publish'); $('#pubQuiz').value = q.id; renderPubBody(); }
  if (b.dataset.act === 'copy') {
    var d = clone(q.data);
    d.title = (d.title || q.id) + '（副本）';
    openEditor(true, { id: newQuizId(), updatedAt: '', data: d });
  }
  if (b.dataset.act === 'del') {
    if (!confirm('確定刪除測驗「' + (q.data.title || q.id) + '」？\n已經印出去的 QRCode 會失效（作答紀錄仍會保留）。')) return;
    busy(b, function () {
      return call('admin_deleteQuiz', { quizId: q.id }).then(function () {
        S.quizzes = S.quizzes.filter(function (x) { return x.id !== q.id; });
        renderQuizList(); toast('已刪除');
      });
    });
  }
};
function newQuizId() {
  var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
  return 'quiz-' + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + Math.random().toString(36).slice(2, 5);
}
$('#btnNewQuiz').onclick = function () {
  openEditor(true, { id: newQuizId(), updatedAt: '', data: { title: '', description: '', allowRetake: false, scoring: 'equal', questions: [] } });
};

// =====================================================================
//  測驗編輯器
//  一份測驗 = 多個「大題」；大題可以有「子題」。滿分固定 100 分。
//  編輯中的資料形狀（S.ed.data）：
//    { title, description, allowRetake, closed, scoring:'equal'|'custom',
//      questions:[ { title, multi, subScoring:'equal'|'custom', points,
//        items:[ { mode, question, options[], correctIndex, points, partialOn, partialPts[], category?, answer?, optionCount? } ] } ] }
//  儲存時才轉成後端的格式（部分給分：每個選項拿題目配分的幾成）。
// =====================================================================
var TOTAL = 100;
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function pnum(x) { return typeof x === 'number' && isFinite(x) ? round1(x) : NaN; }   // 使用者輸入的配分：到小數第一位
function fmt(n) { n = Number(n); return isFinite(n) ? String(round2(n)) : '?'; }
/** 把 total 平均分給 n 份（到小數第一位；零頭 0.1 從前面補），加起來剛好 = total */
function distribute(total, n) {
  var out = [];
  if (!(n >= 1) || !(total > 0)) { for (var z = 0; z < n; z++) out.push(NaN); return out; }
  var T = Math.round(total * 10), base = Math.floor(T / n), rem = T - base * n;
  for (var i = 0; i < n; i++) out.push((base + (i < rem ? 1 : 0)) / 10);
  return out;
}

/** 後端的測驗 → 編輯用的資料（舊格式：每題直接有 options，也能讀） */
function toEditor(d) {
  var qs = (d.questions || []).map(function (Q) {
    var hasItems = Array.isArray(Q.items);
    var raw = hasItems ? Q.items : [Q];
    var multi = hasItems && !!Q.multi;
    return {
      title: multi ? (Q.title || '') : '', multi: multi,
      subScoring: Q.subScoring === 'custom' ? 'custom' : 'equal',
      points: typeof Q.points === 'number' ? Q.points : null,
      items: raw.map(function (I) {
        var options = (I.options || []).slice();
        var it = { mode: I.mode === 'auto' ? 'auto' : 'manual', question: I.question || '', options: options,
          correctIndex: typeof I.correctIndex === 'number' ? I.correctIndex : -1,
          points: typeof I.points === 'number' ? I.points : null,
          partialOn: Array.isArray(I.partial),
          partialPts: options.map(function () { return 0; }) };
        if (Array.isArray(I.partial) && typeof I.points === 'number') it.partialPts = I.partial.map(function (r) { return round2(r * I.points); });
        if (it.mode === 'auto') { it.category = I.category || ''; it.answer = I.answer || ''; it.optionCount = options.length || 5; }
        return it;
      })
    };
  });
  return { quizId: d.quizId, title: d.title || '', description: d.description || '', allowRetake: !!d.allowRetake, closed: !!d.closed,
    scoring: d.scoring === 'custom' ? 'custom' : 'equal', questions: qs };
}

function newItem(mode) {
  return mode === 'auto'
    ? { mode: 'auto', question: '', category: '', answer: '', optionCount: 5, options: [], correctIndex: -1, points: null, partialOn: false, partialPts: [] }
    : { mode: 'manual', question: '', options: ['', '', '', '', ''], correctIndex: -1, points: null, partialOn: false, partialPts: [0, 0, 0, 0, 0] };
}
function newBig(mode) { return { title: '', multi: false, subScoring: 'equal', points: null, items: [newItem(mode)] }; }

// ---- 配分計算（畫面上顯示的分數、驗證都用這幾個函式） ----
function bigPts(i) {
  var d = S.ed.data;
  return d.scoring === 'equal' ? distribute(TOTAL, d.questions.length)[i] : pnum(d.questions[i].points);
}
function itemPts(i, j) {
  var Q = S.ed.data.questions[i], b = bigPts(i);
  if (!Q.multi) return b;
  if (Q.subScoring === 'custom') return pnum(Q.items[j].points);
  return b > 0 ? distribute(b, Q.items.length)[j] : NaN;
}

function refreshPts() {
  if (!S.ed) return;
  var d = S.ed.data;
  $$('[data-pt]').forEach(function (el) {
    var k = el.dataset.pt.split('-');
    el.textContent = fmt(k.length > 1 ? itemPts(+k[0], +k[1]) : bigPts(+k[0]));
  });
  $$('[data-subsum]').forEach(function (el) {
    var i = +el.dataset.subsum, Q = d.questions[i], s = 0, b = bigPts(i);
    Q.items.forEach(function (it) { var p = pnum(it.points); if (!isNaN(p)) s += p; });
    var diff = round1(b - s);
    el.textContent = isNaN(b) ? '請先填這個大題的配分'
      : '子題合計 ' + fmt(s) + ' / ' + fmt(b) + ' 分' + (diff === 0 ? ' ✓' : diff > 0 ? '（還差 ' + fmt(diff) + ' 分）' : '（超過 ' + fmt(-diff) + ' 分）');
    el.className = 'badge ' + (diff === 0 ? 'g' : 'r');
  });
  var box = $('#scoreSum');
  if (!d.questions.length) { box.textContent = ''; box.className = 'badge'; return; }
  if (d.scoring === 'equal') { box.textContent = '滿分 100 分（每大題自動平均分配）'; box.className = 'badge g'; return; }
  var sum = 0, missing = false;
  d.questions.forEach(function (Q, i) { var p = bigPts(i); if (isNaN(p)) missing = true; else sum += p; });
  var diff2 = round1(TOTAL - sum);
  box.textContent = '目前合計 ' + fmt(sum) + ' / 100 分' + (diff2 === 0 && !missing ? ' ✓' : diff2 > 0 ? '（還差 ' + fmt(diff2) + ' 分）' : diff2 < 0 ? '（超過 ' + fmt(-diff2) + ' 分）' : '');
  box.className = 'badge ' + (diff2 === 0 && !missing ? 'g' : 'r');
}

function openEditor(isNew, q) {
  S.ed = { isNew: isNew, updatedAt: q.updatedAt || '', data: toEditor(clone(q.data)) };
  S.ed.data.quizId = q.id;
  S.dirty = false;
  $('#edTitleH').textContent = isNew ? '建立新測驗' : '編輯測驗';
  $('#edTitle').value = S.ed.data.title || '';
  $('#edDesc').value = S.ed.data.description || '';
  $('#edRetake').checked = !!S.ed.data.allowRetake;
  $('#edOpen').checked = !S.ed.data.closed;
  $('#edId').value = q.id;
  $('#edId').disabled = !isNew;
  $('#idHint').textContent = isNew ? '（英文字母、數字、- _；建立後不能改）' : '（不能修改）';
  $('#edStatus').textContent = '';
  renderQuestions();
  renderQuizList();
  window.scrollTo(0, 0);
}
function leaveEditor() { S.ed = null; S.dirty = false; renderQuizList(); }

$('#btnEdBack').onclick = function () {
  if (S.dirty && !confirm('還沒儲存，確定要離開嗎？')) return;
  leaveEditor();
};
['#edTitle', '#edDesc', '#edRetake', '#edOpen', '#edId'].forEach(function (sel) {
  $(sel).addEventListener('input', function () { S.dirty = true; });
});
window.addEventListener('beforeunload', function (e) { if (S.ed && S.dirty) { e.preventDefault(); e.returnValue = ''; } });

$('#edScoring').onchange = function () {
  var d = S.ed.data;
  if (this.value === 'custom') {                 // 切到自訂時，先帶入目前的平均分數，再讓使用者改
    var ps = distribute(TOTAL, d.questions.length);
    d.questions.forEach(function (Q, i) { Q.points = isNaN(ps[i]) ? null : ps[i]; });
  }
  d.scoring = this.value; S.dirty = true; renderQuestions();
};

$('#btnAddAuto').onclick = function () { S.ed.data.questions.push(newBig('auto')); S.dirty = true; renderQuestions(); scrollLast(); };
$('#btnAddManual').onclick = function () { S.ed.data.questions.push(newBig('manual')); S.dirty = true; renderQuestions(); scrollLast(); };
function scrollLast() { var c = $$('#qList .qcard'); if (c.length) c[c.length - 1].scrollIntoView({ block: 'center', behavior: 'smooth' }); }

function rollAuto(it) {
  var c = S.cats[it.category];
  it.partialPts = [];
  if (!c || !it.answer) return;
  var pool = c.items.filter(function (x) { return x !== it.answer; });
  var need = it.optionCount - 1;
  if (pool.length < need) {
    it.options = []; it.correctIndex = -1;
    toast('類別「' + it.category + '」扣掉正解後只剩 ' + pool.length + ' 個項目，不夠抽 ' + need + ' 個干擾選項。請減少選項數，或到題庫補充項目。', true);
    return;
  }
  it.options = shuffle([it.answer].concat(shuffle(pool).slice(0, need)));
  it.correctIndex = it.options.indexOf(it.answer);
  it.partialPts = it.options.map(function () { return 0; });
}

function renderQuestions() {
  var d = S.ed.data, qs = d.questions;
  $('#qCount').textContent = qs.length + ' 大題';
  $('#edScoring').value = d.scoring;
  $('#qList').innerHTML = qs.map(function (Q, i) { return bigHtml(Q, i, qs.length); }).join('') ||
    '<div class="card"><p class="sub" style="margin:0">還沒有題目，按下方按鈕新增。</p></div>';
  refreshPts();
  // 自動題需要類別內容：沒載入的補載入後重畫
  var need = {};
  qs.forEach(function (Q) { Q.items.forEach(function (it) { if (it.mode === 'auto' && it.category && S.cats[it.category] && !S.cats[it.category].loaded && !S.cats[it.category].isNew) need[it.category] = 1; }); });
  var names = Object.keys(need);
  if (names.length) Promise.all(names.map(ensureCat)).then(function () { if (S.ed) renderQuestions(); }).catch(function (e) { toast(e.message, true); });
}

function kindBadge(it) { return '<span class="badge ' + (it.mode === 'auto' ? 'g' : 'a') + '">' + (it.mode === 'auto' ? '自動生成' : '手動輸入') + '</span>'; }
function numInput(q, val) {
  return '<input type="number" class="numin" min="0" max="100" step="0.1" data-q="' + q + '" value="' + (val == null || isNaN(val) ? '' : esc(val)) + '">';
}

function bigHtml(Q, i, n) {
  var custom = S.ed.data.scoring === 'custom';
  var pts = custom ? '<label class="pin">配分 ' + numInput('bigpts', Q.points) + ' 分</label>'
    : '<span class="badge g"><span data-pt="' + i + '"></span> 分</span>';
  var h = '<div class="qcard" data-i="' + i + '"><div class="qhead"><span class="handle" title="拖曳排序">⠿</span><b>第 ' + (i + 1) + ' 大題</b>' +
    (Q.multi ? '<span class="badge a">' + Q.items.length + ' 個子題</span>' : kindBadge(Q.items[0])) + pts + '<span class="sp"></span>' +
    '<button class="btn sm" data-act="up"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
    '<button class="btn sm" data-act="down"' + (i === n - 1 ? ' disabled' : '') + '>▼</button>' +
    '<button class="btn sm danger" data-act="del">刪除</button></div>' +
    '<label class="chk"><input type="checkbox" data-q="multi"' + (Q.multi ? ' checked' : '') + '> 這題有子題 <small>（大題底下分成幾個小題，各自配分；玩家仍是一頁看完這個大題）</small></label>';
  if (!Q.multi) return h + itemHtml(Q.items[0], i, 0, false) + '</div>';
  h += '<label class="f">大題說明 <small>（選填，顯示在子題上方）</small><textarea data-q="bigtitle" rows="2" placeholder="例如：請依照展示的岩石回答下面 3 個小題">' + esc(Q.title) + '</textarea></label>' +
    '<div class="row" style="margin:0 0 10px"><label class="pin">子題配分 <select data-q="subScoring" class="inl">' +
    '<option value="equal"' + (Q.subScoring === 'equal' ? ' selected' : '') + '>平均分配</option>' +
    '<option value="custom"' + (Q.subScoring === 'custom' ? ' selected' : '') + '>自訂</option></select></label>' +
    (Q.subScoring === 'custom' ? '<span class="badge" data-subsum="' + i + '"></span>' : '') + '</div>';
  Q.items.forEach(function (it, j) { h += itemHtml(it, i, j, true); });
  return h + '<div class="row"><button class="btn sm" data-act="addsub" data-mode="auto">＋ 自動生成子題</button>' +
    '<button class="btn sm" data-act="addsub" data-mode="manual">＋ 手動輸入子題</button></div></div>';
}

function itemHtml(it, i, j, isSub) {
  var Q = S.ed.data.questions[i], custom = Q.multi && Q.subScoring === 'custom';
  var h = '<div class="ibox' + (isSub ? ' scard' : '') + '" data-i="' + i + '" data-j="' + j + '">';
  if (isSub) {
    h += '<div class="qhead"><b>(' + (j + 1) + ') 子題</b>' + kindBadge(it) +
      (custom ? '<label class="pin">配分 ' + numInput('itempts', it.points) + ' 分</label>' : '<span class="badge g"><span data-pt="' + i + '-' + j + '"></span> 分</span>') +
      '<span class="sp"></span>' +
      '<button class="btn sm" data-act="subup"' + (j === 0 ? ' disabled' : '') + '>▲</button>' +
      '<button class="btn sm" data-act="subdown"' + (j === Q.items.length - 1 ? ' disabled' : '') + '>▼</button>' +
      '<button class="btn sm danger" data-act="delsub">刪除</button></div>';
  }
  if (it.mode === 'auto') {
    var cat = S.cats[it.category];
    var items = cat ? cat.items : [];
    if (it.answer && items.indexOf(it.answer) < 0) items = [it.answer].concat(items);
    var catOpts = '<option value="">請選擇類別</option>' + S.catNames.map(function (nm) {
      return '<option value="' + esc(nm) + '"' + (nm === it.category ? ' selected' : '') + '>' + esc(nm) + '</option>';
    }).join('');
    if (it.category && S.catNames.indexOf(it.category) < 0) catOpts += '<option value="' + esc(it.category) + '" selected>' + esc(it.category) + '（已刪除）</option>';
    var ansOpts = '<option value="">請選擇正解</option>' + items.map(function (x) {
      return '<option value="' + esc(x) + '"' + (x === it.answer ? ' selected' : '') + '>' + esc(x) + '</option>';
    }).join('');
    var cnt = ''; for (var k = 2; k <= MAX_OPTIONS; k++) cnt += '<option' + (k === it.optionCount ? ' selected' : '') + '>' + k + '</option>';
    var chips = it.options.map(function (o, m) {
      return '<span class="chip' + (m === it.correctIndex ? ' ok' : '') + '">' + LETTERS[m] + '. ' + esc(o) + (m === it.correctIndex ? ' ✓' : '') + '</span>';
    }).join('');
    h += '<label class="f">題目文字 <small>（選填，留空會顯示「請選出正確答案」）</small><input type="text" data-q="question" value="' + esc(it.question) + '" placeholder="請選出正確答案"></label>' +
      '<div class="grid3"><label class="f">類別<select data-q="category">' + catOpts + '</select></label>' +
      '<label class="f">正解<select data-q="answer">' + ansOpts + '</select></label>' +
      '<label class="f">選項數<select data-q="optionCount">' + cnt + '</select></label></div>' +
      '<div class="chips">' + (chips || '<span class="sub">選好類別與正解後，這裡會顯示自動抽出的選項</span>') + '</div>' +
      '<button class="btn sm" data-act="reroll"' + (it.answer ? '' : ' disabled') + '>🎲 重抽選項</button>';
  } else {
    var rows = it.options.map(function (o, m) {
      return '<div class="orow"><input type="radio" name="c' + i + '_' + j + '" data-act="correct" data-j="' + m + '"' + (m === it.correctIndex ? ' checked' : '') + ' title="設為正解">' +
        '<b>' + LETTERS[m] + '</b><input type="text" data-q="opt" data-j="' + m + '" value="' + esc(o) + '" placeholder="選項 ' + LETTERS[m] + '">' +
        '<button class="btn sm" data-act="delopt" data-j="' + m + '"' + (it.options.length <= 2 ? ' disabled' : '') + '>✕</button></div>';
    }).join('');
    h += '<label class="f">題目 <small>（選填，留空會顯示「請選出正確答案」；例如題目是看實物或圖片時）</small><textarea data-q="question" rows="2" placeholder="例如：以下哪種酒精飲料的酒精濃度最低？">' + esc(it.question) + '</textarea></label>' +
      '<div class="sub" style="margin:0 0 4px">選項（點左邊圓點 = 正解）</div>' + rows +
      '<button class="btn sm" data-act="addopt"' + (it.options.length >= MAX_OPTIONS ? ' disabled' : '') + '>＋ 新增選項</button>';
  }
  return h + partialHtml(it, i, j) + '</div>';
}

/** 部分給分：預設只有正解拿滿分；勾選後，其他選項可以各自設定拿幾分 */
function partialHtml(it, i, j) {
  if (!it.options.length) return '';
  var h = '<label class="chk"><input type="checkbox" data-q="partial"' + (it.partialOn ? ' checked' : '') +
    '> 部分給分 <small>（預設只有正解拿分。勾選後，特定的錯誤選項也可以拿到一部分分數）</small></label>';
  if (!it.partialOn) return h;
  var pt = (S.ed.data.questions[i].multi ? i + '-' + j : String(i));
  h += '<div class="pbox">';
  if (it.correctIndex < 0) h += '<div class="sub" style="margin:0 0 6px">請先選定正解（拿滿分的選項）。</div>';
  h += it.options.map(function (o, k) {
    var lab = '<b>' + LETTERS[k] + '</b><span class="ptxt">' + esc(o || '（尚未輸入）') + '</span>';
    if (k === it.correctIndex) return '<div class="prow ok" data-k="' + k + '">' + lab + '<span class="badge g">正解：<span data-pt="' + pt + '"></span> 分</span></div>';
    return '<div class="prow" data-k="' + k + '">' + lab + '<span><input type="number" class="numin" min="0" step="0.1" data-q="ppts" data-k="' + k + '" value="' + esc(it.partialPts[k] || 0) + '"> 分</span></div>';
  }).join('');
  return h + '<div class="sub" style="margin:6px 0 0">沒有填的選項 = 0 分；每個選項的分數不能超過本題配分。</div></div>';
}

// ---- 題目區事件（委派） ----
var qList = $('#qList');
function ctx(t) {
  var card = t.closest('.qcard');
  if (!card) return null;
  var i = +card.dataset.i, Q = S.ed.data.questions[i], ib = t.closest('.ibox');
  return { card: card, i: i, Q: Q, ib: ib, it: ib ? Q.items[+ib.dataset.j] : null };
}
qList.addEventListener('input', function (e) {
  var t = e.target, c = ctx(t);
  if (!c) return;
  var k = t.dataset.q;
  if (k === 'bigtitle') c.Q.title = t.value;
  else if (k === 'bigpts') { c.Q.points = t.value === '' ? null : parseFloat(t.value); refreshPts(); }
  else if (c.it) {
    if (k === 'question') c.it.question = t.value;
    else if (k === 'opt') {
      c.it.options[+t.dataset.j] = t.value;
      var tx = c.ib.querySelector('.prow[data-k="' + t.dataset.j + '"] .ptxt');
      if (tx) tx.textContent = t.value || '（尚未輸入）';
    }
    else if (k === 'itempts') { c.it.points = t.value === '' ? null : parseFloat(t.value); refreshPts(); }
    else if (k === 'ppts') c.it.partialPts[+t.dataset.k] = parseFloat(t.value) || 0;
  }
  S.dirty = true;
  c.card.classList.remove('bad');
  if (c.ib) c.ib.classList.remove('bad');
});
qList.addEventListener('change', function (e) {
  var t = e.target, c = ctx(t);
  if (!c || (t.tagName !== 'SELECT' && t.type !== 'checkbox')) return;
  var k = t.dataset.q, Q = c.Q, it = c.it;
  S.dirty = true;
  if (k === 'multi') {
    if (t.checked) { Q.multi = true; Q.subScoring = 'equal'; }
    else {
      if (Q.items.length > 1 && !confirm('取消「這題有子題」後，只會保留第 1 個子題，其餘的子題會被刪除。確定嗎？')) { t.checked = true; return; }
      Q.multi = false; Q.items = Q.items.slice(0, 1); Q.title = '';
    }
  } else if (k === 'subScoring') {
    if (t.value === 'custom') {                  // 切到自訂時，先帶入目前的平均分數
      var b = bigPts(c.i), ps = b > 0 ? distribute(b, Q.items.length) : [];
      Q.items.forEach(function (x, j) { x.points = ps[j] != null && !isNaN(ps[j]) ? ps[j] : null; });
    }
    Q.subScoring = t.value;
  } else if (!it) { return; }
  else if (k === 'partial') {
    it.partialOn = t.checked;
    if (it.partialPts.length !== it.options.length) it.partialPts = it.options.map(function () { return 0; });
  } else if (k === 'category') {
    it.category = t.value; it.answer = ''; it.options = []; it.correctIndex = -1; it.partialPts = [];
    ensureCat(it.category).then(renderQuestions).catch(function (er) { toast(er.message, true); });
    return;
  } else if (k === 'answer') { it.answer = t.value; rollAuto(it); }
  else if (k === 'optionCount') { it.optionCount = +t.value; rollAuto(it); }
  renderQuestions();
});
qList.addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT' && b.type !== 'radio') return;
  var c = ctx(b);
  if (!c) return;
  var i = c.i, qs = S.ed.data.questions, Q = c.Q, it = c.it, act = b.dataset.act;
  var j = c.ib ? +c.ib.dataset.j : 0;
  if (act === 'correct') {
    it.correctIndex = +b.dataset.j; S.dirty = true; c.card.classList.remove('bad'); c.ib.classList.remove('bad');
    if (it.partialOn) renderQuestions();          // 正解換了：那個選項改成「拿滿分」
    return;
  }
  S.dirty = true;
  if (act === 'up' && i > 0) { qs.splice(i - 1, 0, qs.splice(i, 1)[0]); }
  if (act === 'down' && i < qs.length - 1) { qs.splice(i + 1, 0, qs.splice(i, 1)[0]); }
  if (act === 'del') { if (!confirm('刪除第 ' + (i + 1) + ' 大題？')) return; qs.splice(i, 1); }
  if (act === 'subup' && j > 0) { Q.items.splice(j - 1, 0, Q.items.splice(j, 1)[0]); }
  if (act === 'subdown' && j < Q.items.length - 1) { Q.items.splice(j + 1, 0, Q.items.splice(j, 1)[0]); }
  if (act === 'delsub') {
    if (Q.items.length <= 1) { toast('至少要有 1 個子題（不需要子題的話，可以取消勾選「這題有子題」）', true); return; }
    if (!confirm('刪除第 ' + (i + 1) + ' 大題的第 ' + (j + 1) + ' 個子題？')) return;
    Q.items.splice(j, 1);
  }
  if (act === 'addsub') Q.items.push(newItem(b.dataset.mode));
  if (act === 'reroll') rollAuto(it);
  if (act === 'addopt' && it.options.length < MAX_OPTIONS) { it.options.push(''); it.partialPts.push(0); }
  if (act === 'delopt' && it.options.length > 2) {
    var m = +b.dataset.j;
    it.options.splice(m, 1); it.partialPts.splice(m, 1);
    if (it.correctIndex === m) it.correctIndex = -1; else if (it.correctIndex > m) it.correctIndex--;
  }
  renderQuestions();
});

// 拖曳排序（大題；手機請用 ▲▼）
var dragFrom = -1;
qList.addEventListener('mousedown', function (e) {
  var h = e.target.closest('.handle');
  if (h) h.closest('.qcard').draggable = true;
});
document.addEventListener('mouseup', function () { $$('#qList .qcard').forEach(function (c) { c.draggable = false; }); });
qList.addEventListener('dragstart', function (e) {
  var c = e.target.closest('.qcard');
  if (!c || !c.draggable) return;
  dragFrom = +c.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
  c.classList.add('dragging');
});
qList.addEventListener('dragover', function (e) {
  if (dragFrom < 0) return;
  e.preventDefault();
  $$('#qList .over').forEach(function (x) { x.classList.remove('over'); });
  var c = e.target.closest('.qcard');
  if (c) c.classList.add('over');
});
qList.addEventListener('drop', function (e) {
  e.preventDefault();
  var c = e.target.closest('.qcard');
  if (!c || dragFrom < 0) return;
  var to = +c.dataset.i, qs = S.ed.data.questions;
  if (to !== dragFrom) { qs.splice(to, 0, qs.splice(dragFrom, 1)[0]); S.dirty = true; }
});
qList.addEventListener('dragend', function () { dragFrom = -1; if (S.ed) renderQuestions(); });

// ---- 儲存測驗：先在這裡檢查，再轉成後端格式 ----
function validateAndBuild() {
  var d = S.ed.data, errs = [], bad = {};
  var title = $('#edTitle').value.trim();
  var id = $('#edId').value.trim();
  if (!title) errs.push('請輸入測驗名稱');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) errs.push('測驗代碼只能用英文、數字、- 與 _（最多 40 字）');
  if (S.ed.isNew && findQuiz(id)) errs.push('測驗代碼「' + id + '」已經存在，請換一個');
  if (!d.questions.length) errs.push('至少要有 1 個大題');

  var custom = d.scoring === 'custom', sum = 0, bigOk = true;
  var out = d.questions.map(function (Q, i) {
    var n = '第 ' + (i + 1) + ' 大題', bp = bigPts(i);
    if (!(bp > 0)) { if (custom) { errs.push(n + '：請填配分（要大於 0）'); bad[i] = 1; } bigOk = false; }
    else sum += bp;

    if (Q.multi && bp > 0) {
      if (Q.subScoring === 'custom') {
        var s = 0, all = true;
        Q.items.forEach(function (it, j) {
          var p = pnum(it.points);
          if (!(p > 0)) { errs.push(n + ' 第 ' + (j + 1) + ' 子題：請填配分（要大於 0）'); bad[i + '-' + j] = 1; all = false; } else s += p;
        });
        if (all && Math.abs(s - bp) > 0.05) { errs.push(n + '：子題配分加總是 ' + fmt(s) + ' 分，必須等於這個大題的 ' + fmt(bp) + ' 分'); bad[i] = 1; }
      } else if (bp / Q.items.length < 0.1) {
        errs.push(n + '：配分只有 ' + fmt(bp) + ' 分，無法平均分給 ' + Q.items.length + ' 個子題'); bad[i] = 1;
      }
    }

    var items = Q.items.map(function (it, j) {
      var lab = Q.multi ? n + ' 第 ' + (j + 1) + ' 子題' : n, key = Q.multi ? i + '-' + j : String(i);
      function fail(msg) { errs.push(lab + '：' + msg); bad[key] = 1; }
      var ip = itemPts(i, j), opts = it.options.map(function (o) { return o.trim(); }), ok = true;
      if (it.mode === 'auto') {
        if (!it.category) { fail('請選擇類別'); ok = false; }
        else if (!it.answer) { fail('請選擇正解'); ok = false; }
        else if (it.options.length < 2 || it.correctIndex < 0) { fail('選項還沒抽出來（類別項目不足？）'); ok = false; }
      } else {
        if (opts.some(function (o) { return !o; })) { fail('有選項是空的'); ok = false; }
        else if (new Set(opts).size !== opts.length) { fail('有重複的選項'); ok = false; }
        if (it.correctIndex < 0) { fail('請勾選正解'); ok = false; }
      }
      var res = { mode: it.mode, question: (it.question || '').trim(), options: opts, correctIndex: it.correctIndex, points: ip };
      if (it.mode === 'auto') { res.category = it.category; res.answer = it.answer; }
      if (it.partialOn && ok) {
        res.partial = opts.map(function (o, k) {
          if (k === it.correctIndex) return 1;
          var v = it.partialPts[k] || 0;
          if (v < 0 || (ip > 0 && v > ip + 0.001)) { fail('選項 ' + LETTERS[k] + ' 的部分分數要在 0 ～ ' + fmt(ip) + ' 分之間'); return 0; }
          return ip > 0 ? Math.round(v / ip * 1e6) / 1e6 : 0;
        });
      }
      return res;
    });
    return { title: Q.multi ? (Q.title || '').trim() : '', multi: !!Q.multi, subScoring: Q.subScoring, points: bp, items: items };
  });
  if (custom && bigOk && Math.abs(sum - TOTAL) > 0.05) errs.unshift('各大題配分加總是 ' + fmt(sum) + ' 分，必須剛好 100 分（目前' + (sum < TOTAL ? '還差 ' : '超過 ') + fmt(Math.abs(TOTAL - sum)) + ' 分）');
  return { errs: errs, bad: bad, quiz: {
    quizId: id, title: title, description: $('#edDesc').value.trim(), allowRetake: $('#edRetake').checked, closed: !$('#edOpen').checked,
    scoring: d.scoring, updatedAt: new Date().toISOString(), questions: out } };
}

$('#btnEdSave').onclick = function () {
  var btn = this;
  var r = validateAndBuild();
  $$('#qList .qcard').forEach(function (c) { c.classList.toggle('bad', !!r.bad[c.dataset.i]); });
  $$('#qList .scard').forEach(function (c) { c.classList.toggle('bad', !!r.bad[c.dataset.i + '-' + c.dataset.j]); });
  if (r.errs.length) {
    toast(r.errs[0] + (r.errs.length > 1 ? '（還有 ' + (r.errs.length - 1) + ' 個問題）' : ''), true);
    var first = $('#qList .scard.bad') || $('#qList .qcard.bad'); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  busy(btn, function () {
    $('#edStatus').textContent = '儲存中…';
    return call('admin_saveQuiz', { quiz: r.quiz, isNew: S.ed.isNew, baseUpdatedAt: S.ed.updatedAt })
      .then(function (j) {
        var saved = j.quiz; saved.updatedAt = j.updatedAt;
        var entry = findQuiz(saved.quizId);
        if (entry) { entry.updatedAt = j.updatedAt; entry.data = saved; } else { S.quizzes.unshift({ id: saved.quizId, updatedAt: j.updatedAt, data: saved }); }
        S.ed.isNew = false; S.ed.updatedAt = j.updatedAt; S.ed.data = toEditor(clone(saved));
        $('#edId').disabled = true; $('#edTitleH').textContent = '編輯測驗';
        S.dirty = false;
        $('#edStatus').textContent = '✓ 已儲存 ' + new Date().toLocaleTimeString() + '（已立即生效）';
        toast('已儲存，玩家端立即生效');
        renderQuestions();
      });
  }).then(function () { if (!S.dirty) return; $('#edStatus').textContent = ''; });
};

// =====================================================================
//  發布 / QRCode
// =====================================================================
function liffUrl(quizId) { return 'https://liff.line.me/' + cfg.liffId + '?quizId=' + encodeURIComponent(quizId); }
function pageBase() { return location.href.replace(/admin\/.*$/, ''); }

function renderPublish() {
  var sel = $('#pubQuiz'), cur = sel.value;
  sel.innerHTML = S.quizzes.map(function (q) { return '<option value="' + esc(q.id) + '">' + esc(q.data.title || q.id) + '（' + esc(q.id) + '）</option>'; }).join('');
  if (cur && findQuiz(cur)) sel.value = cur;
  if (!S.quizzes.length) { $('#pubBody').innerHTML = '<p class="sub">還沒有測驗，請先到「測驗」分頁建立一場。</p>'; return; }
  renderPubBody();
}
$('#pubQuiz').onchange = function () { renderPubBody(); };

function drawQR(canvas, text, px) {
  var qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  var n = qr.getModuleCount(), quiet = 4, cell = Math.max(2, Math.floor(px / (n + quiet * 2))), size = cell * (n + quiet * 2);
  canvas.width = canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
}

function renderPubBody() {
  var id = $('#pubQuiz').value, q = findQuiz(id), body = $('#pubBody');
  if (!q) return;
  if (!cfg.liffId) {
    body.innerHTML = '<div class="notice err">系統還沒設定 LIFF ID。請系統擁有者打開 <code>config.js</code> 填入 <code>liffId</code> 後再回來。</div>';
    return;
  }
  var url = liffUrl(id);
  var preview = pageBase() + 'play/?quizId=' + encodeURIComponent(id) + '&preview=1';
  body.innerHTML =
    '<div class="qrbox"><canvas id="qrCanvas"></canvas><div style="flex:1;min-width:260px">' +
    '<label class="f">玩家掃描的網址（QRCode 的內容）<div class="urlbox"><input type="text" id="pubUrl" readonly value="' + esc(url) + '"><button class="btn" id="btnCopy">複製</button></div></label>' +
    '<div class="row" style="margin:12px 0"><button class="btn primary" id="btnDl">下載 QRCode（PNG）</button><button class="btn" id="btnPoster">列印海報</button></div>' +
    (q.data.closed ? '<div class="notice err">🔒 這場測驗目前是「已關閉」，玩家掃碼只會看到「這場測驗已結束」。要讓人作答，請先回「測驗」列表按「重新開放」。</div>' : '') +
    '<div class="notice">⚠️ <b>印出去之前請先測試：</b>用手機 LINE 掃這個 QRCode，確認能開到測驗、題目正確。</div>' +
    '<p class="sub" style="margin:0"><a href="' + esc(preview) + '" target="_blank" rel="noopener">開啟「預覽」</a>（用這場測驗的真實題目，在電腦瀏覽器就能作答一次；不會連 LINE、不會記錄成績）</p>' +
    '</div></div>';
  drawQR($('#qrCanvas'), url, 720);
  $('#btnCopy').onclick = function () {
    var inp = $('#pubUrl'); inp.select();
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).catch(function () { document.execCommand('copy'); }).then(function () { toast('已複製'); });
  };
  $('#btnDl').onclick = function () {
    $('#qrCanvas').toBlob(function (blob) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'qrcode-' + id + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    });
  };
  $('#btnPoster').onclick = function () {
    var w = window.open('', '_blank');
    if (!w) return toast('瀏覽器擋住了彈出視窗，請允許後再試', true);
    var title = esc(q.data.title || id), img = $('#qrCanvas').toDataURL('image/png');
    w.document.write('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>' + title + '</title><style>' +
      '@page{margin:14mm}body{font-family:"Microsoft JhengHei","PingFang TC",sans-serif;text-align:center;margin:0;padding:24px}' +
      'h1{font-size:44px;margin:10px 0 4px}p{font-size:24px;color:#333;margin:6px 0}img{width:70vmin;max-width:520px;margin:18px auto;display:block}' +
      '.s{font-size:20px;color:#555}</style></head><body><h1>' + title + '</h1><p>用 LINE 掃描 QRCode，開始作答</p>' +
      '<img src="' + img + '" alt="QRCode"><p class="s">① 開啟 LINE → 掃描 QRCode　② 完成作答　③ 按「查詢成績」取得分數</p>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>');
    w.document.close();
  };
}

// =====================================================================
//  作答結果
// =====================================================================
var autoTimer = null;
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } $('#resAuto').checked = false; }

function renderResultsInit() {

  var sel = $('#resQuiz'), cur = sel.value;
  sel.innerHTML = S.quizzes.map(function (q) { return '<option value="' + esc(q.id) + '">' + esc(q.data.title || q.id) + '（' + esc(q.id) + '）</option>'; }).join('') +
    '<option value="">（全部測驗）</option>';
  if (cur !== undefined && Array.prototype.some.call(sel.options, function (o) { return o.value === cur; })) sel.value = cur;
  $('#resErr').classList.add('hidden');
  if (!apiUrl()) { showResErr('系統還沒設定後端網址。請系統擁有者打開 config.js 填入 apiUrl。'); }
}
function showResErr(msg) { var e = $('#resErr'); e.textContent = msg; e.classList.remove('hidden'); }

function loadResults() {
  if (!apiUrl()) return Promise.resolve();
  $('#resErr').classList.add('hidden');
  return call('results', { quizId: $('#resQuiz').value })
    .then(function (j) { renderResults(j.rows); })
    .catch(function (e) { showResErr(e.message); });
}

function renderResults(rows) {
  var quizId = $('#resQuiz').value, quiz = quizId ? findQuiz(quizId) : null;
  // 每位玩家取最新一筆作為成績
  var latest = {}, count = {};
  rows.forEach(function (r) {
    var k = r.userId + '|' + r.quizId;
    count[k] = (count[k] || 0) + 1; r._n = count[k]; latest[k] = r;
  });
  var lat = Object.keys(latest).map(function (k) { return latest[k]; });
  var avg = lat.length ? lat.reduce(function (s, r) { return s + r.score; }, 0) / lat.length : 0;
  var maxS = lat.length ? Math.max.apply(null, lat.map(function (r) { return r.score; })) : 0;
  var total = rows.length ? rows[0].total : 0;
  var repeats = rows.length - lat.length;

  var html = '<div class="stats">' +
    stat(lat.length, '參加人數') + stat(rows.length, '作答筆數' + (repeats ? '（含 ' + repeats + ' 筆重複）' : '')) +
    stat(lat.length ? fmt(round1(avg)) + (quizId ? ' / ' + fmt(total) : '') : '-', '平均分（每人最新一次）') +
    stat(lat.length ? fmt(maxS) : '-', '最高分') + '</div>';

  if (quizId && lat.length) {
    var acc = {};
    lat.forEach(function (r) {
      (r.answers || []).forEach(function (a) {
        var x = acc[a.id] || (acc[a.id] = { got: 0, max: 0 });
        x.max += typeof a.max === 'number' ? a.max : 1;                        // 舊紀錄沒有配分：答對 = 1、答錯 = 0
        x.got += typeof a.earned === 'number' ? a.earned : (a.ok ? 1 : 0);
      });
    });
    var ids = Object.keys(acc).sort(function (a, b) { return itemOrder(a) - itemOrder(b); });
    html += '<div class="card"><h2 style="font-size:16px;margin-bottom:8px">每題得分率 <small style="font-weight:400;color:var(--muted)">（全部作答者拿到的分數 ÷ 該題滿分）</small></h2>' + ids.map(function (id) {
      var x = acc[id], p = x.max ? Math.round(x.got / x.max * 100) : 0, label = itemLabel(quiz, id);
      return '<div class="acc' + (p < 40 ? ' low' : '') + '"><span class="l" title="' + esc(label) + '">' + esc(label) + '</span><span class="b"><i style="width:' + p + '%"></i></span><span class="p">' + p + '%</span></div>';
    }).join('') + '</div>';
  }

  var sorted = rows.slice().reverse();
  html += '<div class="card"><div class="row" style="margin-bottom:8px"><h2 style="font-size:16px">作答紀錄</h2><span class="sp"></span>' +
    '<button class="btn sm" id="btnCsv">下載 CSV</button></div><div style="max-height:480px;overflow:auto"><table><thead><tr><th>時間</th><th>暱稱</th><th>成績</th><th>備註</th>' +
    (quizId ? '' : '<th>測驗</th>') + '</tr></thead><tbody>' +
    (sorted.map(function (r) {
      return '<tr><td>' + esc(r.time) + '</td><td>' + esc(r.name) + '</td><td><b>' + fmt(r.score) + '</b> / ' + fmt(r.total) + '</td><td>' +
        (r._n > 1 ? '<span class="badge a">第 ' + r._n + ' 次作答</span>' : '') + '</td>' + (quizId ? '' : '<td class="mono">' + esc(r.quizId) + '</td>') + '</tr>';
    }).join('') || '<tr><td colspan="5" class="sub">還沒有作答紀錄</td></tr>') + '</tbody></table></div></div>';
  $('#resBody').innerHTML = html;

  var csvBtn = $('#btnCsv');
  if (csvBtn) csvBtn.onclick = function () {
    var lines = [['時間', '測驗', '暱稱', '分數', '滿分', '第幾次作答']].concat(rows.map(function (r) { return [r.time, r.quizId, r.name, r.score, r.total, r._n]; }));
    var csv = '﻿' + lines.map(function (l) { return l.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'results-' + (quizId || 'all') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  };
}
/** 作答紀錄裡的題目編號：q3 = 第 3 大題，q3-2 = 第 3 大題的第 2 個子題 */
function itemOrder(id) { var m = String(id).match(/^q(\d+)(?:-(\d+))?$/); return m ? +m[1] * 1000 + (m[2] ? +m[2] : 0) : 0; }
function itemLabel(quiz, id) {
  var m = String(id).match(/^q(\d+)(?:-(\d+))?$/);
  if (!m) return id;
  var Q = quiz && quiz.data.questions[+m[1] - 1], it = Q && (Array.isArray(Q.items) ? Q.items[m[2] ? +m[2] - 1 : 0] : Q);
  var text = it ? (it.mode === 'auto' ? it.answer : it.question) : '';
  return '第 ' + m[1] + ' 大題' + (m[2] ? ' (' + m[2] + ')' : '') + (text ? '：' + text : '');
}
function stat(v, k) { return '<div class="stat"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>'; }

$('#btnLoadRes').onclick = function () { busy(this, loadResults); };
$('#resAuto').onchange = function () {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (this.checked) { loadResults(); autoTimer = setInterval(loadResults, 10000); }
};

// =====================================================================
//  啟動
// =====================================================================
(function init() {
  var saved = store('quizAdminKey');
  if (!saved) return showLogin();
  connect(saved).catch(function (e) {
    if (e.code === 'forbidden') {                // 密碼確實錯了（例如被換掉）：才清除記住的密碼
      store('quizAdminKey', null);
      showLogin('管理密碼已失效，請重新輸入。');
    } else {                                     // 網路不穩、後端剛好慢等暫時性問題：保留密碼，讓使用者按一下重試
      S.key = '';
      $('#inKey').value = saved;
      showLogin(e.message + '（已幫你保留密碼，按「登入」重試即可）');
    }
  });
})();

})();
