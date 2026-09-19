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
//  題庫與測驗都存在 Google Sheet，不在公開的網頁裡；每次呼叫都帶管理密碼。
// =====================================================================
var ERR = {
  forbidden: '管理密碼不正確',
  conflict: '儲存衝突：這場測驗剛剛被別人（或別的視窗）修改過。請重新整理頁面後再編輯。',
  exists: '這個測驗代碼已經存在，請換一個',
  missing_title: '請輸入測驗名稱',
  bad_quiz_id: '測驗代碼只能用英文、數字、- 與 _',
  bad_category_name: '類別名稱不合法',
  bad_category_items: '類別清單是空的，或超過 300 項'
};
function errText(code) {
  code = String(code || '');
  if (ERR[code]) return ERR[code];
  var m = code.match(/^(bad_options|bad_correct|missing_question)_q(\d+)$/);
  if (m) return '第 ' + m[2] + ' 題有問題：' + { bad_options: '選項不完整', bad_correct: '沒有選定正解', missing_question: '沒有題目文字' }[m[1]];
  return '伺服器回應：' + code;
}
function call(action, payload) {
  if (!cfg.gasUrl) return Promise.reject(new Error('系統尚未設定完成（config.js 缺少 gasUrl）'));
  var body = Object.assign({ action: action, key: S.key }, payload || {});
  // 用 text/plain 送 JSON 可避免瀏覽器做 CORS 預檢，GAS 才收得到
  return fetch(cfg.gasUrl, { method: 'POST', body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }, function () { throw new Error('連線失敗，請檢查網路'); })
    .then(function (j) {
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
      '<div><span class="mono">' + esc(q.id) + '</span>　' + (d.questions || []).length + ' 題　' +
      (d.allowRetake ? '<span class="badge a">可重複作答</span>' : '<span class="badge g">每人限一次</span>') + '</div></div>' +
      '<button class="btn sm" data-act="edit" data-id="' + esc(q.id) + '">編輯</button>' +
      '<button class="btn sm" data-act="pub" data-id="' + esc(q.id) + '">發布 / QRCode</button>' +
      '<button class="btn sm" data-act="copy" data-id="' + esc(q.id) + '">複製</button>' +
      '<button class="btn sm danger" data-act="del" data-id="' + esc(q.id) + '">刪除</button></div></div>';
  }).join('') || '<div class="card"><p class="sub" style="margin:0">還沒有任何測驗。按右上角「建立新測驗」開始。</p></div>';
}

function findQuiz(id) { return S.quizzes.filter(function (q) { return q.id === id; })[0]; }

$('#quizList').onclick = function (e) {
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var q = findQuiz(b.dataset.id);
  if (!q) return;
  if (b.dataset.act === 'edit') openEditor(false, q);
  if (b.dataset.act === 'pub') { switchTab('publish'); $('#pubQuiz').value = q.id; renderPubBody(); }
  if (b.dataset.act === 'copy') {
    var d = clone(q.data);
    d.title = (d.title || q.id) + '（副本）';
    openEditor(true, { id: newQuizId(), updatedAt: '', data: d });
  }
  if (b.dataset.act === 'del') {
    if (!confirm('確定刪除測驗「' + (q.data.title || q.id) + '」？\n已經印出去的 QRCode 會失效（作答紀錄仍保留在 Google Sheet）。')) return;
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
  openEditor(true, { id: newQuizId(), updatedAt: '', data: { title: '', description: '', allowRetake: false, questions: [] } });
};

// =====================================================================
//  測驗編輯器
// =====================================================================
function openEditor(isNew, q) {
  S.ed = { isNew: isNew, updatedAt: q.updatedAt || '', data: clone(q.data) };
  S.ed.data.quizId = q.id;
  S.ed.data.questions = S.ed.data.questions || [];
  S.dirty = false;
  $('#edTitleH').textContent = isNew ? '建立新測驗' : '編輯測驗';
  $('#edTitle').value = S.ed.data.title || '';
  $('#edDesc').value = S.ed.data.description || '';
  $('#edRetake').checked = !!S.ed.data.allowRetake;
  $('#edId').value = q.id;
  $('#edId').disabled = !isNew;
  $('#idHint').textContent = isNew ? '（英數字與 - _，建立後不能改）' : '（不能修改）';
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
['#edTitle', '#edDesc', '#edRetake', '#edId'].forEach(function (sel) {
  $(sel).addEventListener('input', function () { S.dirty = true; });
});
window.addEventListener('beforeunload', function (e) { if (S.ed && S.dirty) { e.preventDefault(); e.returnValue = ''; } });

function newAuto() { return { mode: 'auto', question: '', category: '', answer: '', optionCount: 5, options: [], correctIndex: -1 }; }
function newManual() { return { mode: 'manual', question: '', options: ['', '', '', '', ''], correctIndex: -1 }; }

$('#btnAddAuto').onclick = function () { S.ed.data.questions.push(newAuto()); S.dirty = true; renderQuestions(); scrollLast(); };
$('#btnAddManual').onclick = function () { S.ed.data.questions.push(newManual()); S.dirty = true; renderQuestions(); scrollLast(); };
function scrollLast() { var c = $$('#qList .qcard'); if (c.length) c[c.length - 1].scrollIntoView({ block: 'center', behavior: 'smooth' }); }

function rollAuto(q) {
  var c = S.cats[q.category];
  if (!c || !q.answer) return;
  var pool = c.items.filter(function (x) { return x !== q.answer; });
  var need = q.optionCount - 1;
  if (pool.length < need) {
    q.options = []; q.correctIndex = -1;
    toast('類別「' + q.category + '」扣掉正解後只剩 ' + pool.length + ' 個項目，不夠抽 ' + need + ' 個干擾選項。請減少選項數，或到題庫補充項目。', true);
    return;
  }
  q.options = shuffle([q.answer].concat(shuffle(pool).slice(0, need)));
  q.correctIndex = q.options.indexOf(q.answer);
}

function renderQuestions() {
  var qs = S.ed.data.questions;
  $('#qCount').textContent = qs.length + ' 題';
  $('#qList').innerHTML = qs.map(function (q, i) { return qHtml(q, i, qs.length); }).join('') ||
    '<div class="card"><p class="sub" style="margin:0">還沒有題目，按下方按鈕新增。</p></div>';
  // 自動題需要類別內容：沒載入的補載入後重畫
  var need = {};
  qs.forEach(function (q) { if (q.mode === 'auto' && q.category && S.cats[q.category] && !S.cats[q.category].loaded && !S.cats[q.category].isNew) need[q.category] = 1; });
  var names = Object.keys(need);
  if (names.length) Promise.all(names.map(ensureCat)).then(function () { if (S.ed) renderQuestions(); }).catch(function (e) { toast(e.message, true); });
}

function qHtml(q, i, n) {
  var head = '<div class="qcard" data-i="' + i + '"><div class="qhead"><span class="handle" title="拖曳排序">⠿</span><b>第 ' + (i + 1) + ' 題</b>' +
    '<span class="badge ' + (q.mode === 'auto' ? 'g' : 'a') + '">' + (q.mode === 'auto' ? '自動生成' : '手動輸入') + '</span><span class="sp"></span>' +
    '<button class="btn sm" data-act="up"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
    '<button class="btn sm" data-act="down"' + (i === n - 1 ? ' disabled' : '') + '>▼</button>' +
    '<button class="btn sm danger" data-act="del">刪除</button></div>';
  if (q.mode === 'auto') {
    var cat = S.cats[q.category];
    var items = cat ? cat.items : [];
    if (q.answer && items.indexOf(q.answer) < 0) items = [q.answer].concat(items);
    var catOpts = '<option value="">請選擇類別</option>' + S.catNames.map(function (nm) {
      return '<option value="' + esc(nm) + '"' + (nm === q.category ? ' selected' : '') + '>' + esc(nm) + '</option>';
    }).join('');
    if (q.category && S.catNames.indexOf(q.category) < 0) catOpts += '<option value="' + esc(q.category) + '" selected>' + esc(q.category) + '（已刪除）</option>';
    var ansOpts = '<option value="">請選擇正解</option>' + items.map(function (x) {
      return '<option value="' + esc(x) + '"' + (x === q.answer ? ' selected' : '') + '>' + esc(x) + '</option>';
    }).join('');
    var cnt = ''; for (var k = 2; k <= MAX_OPTIONS; k++) cnt += '<option' + (k === q.optionCount ? ' selected' : '') + '>' + k + '</option>';
    var chips = q.options.map(function (o, j) {
      return '<span class="chip' + (j === q.correctIndex ? ' ok' : '') + '">' + LETTERS[j] + '. ' + esc(o) + (j === q.correctIndex ? ' ✓' : '') + '</span>';
    }).join('');
    return head +
      '<label class="f">題目文字 <small>（選填，留空會顯示「請選出正確答案」）</small><input type="text" data-q="question" value="' + esc(q.question) + '" placeholder="請選出正確答案"></label>' +
      '<div class="grid3"><label class="f">類別<select data-q="category">' + catOpts + '</select></label>' +
      '<label class="f">正解<select data-q="answer">' + ansOpts + '</select></label>' +
      '<label class="f">選項數<select data-q="optionCount">' + cnt + '</select></label></div>' +
      '<div class="chips">' + (chips || '<span class="sub">選好類別與正解後，這裡會顯示自動抽出的選項</span>') + '</div>' +
      '<button class="btn sm" data-act="reroll"' + (q.answer ? '' : ' disabled') + '>🎲 重抽選項</button></div>';
  }
  var rows = q.options.map(function (o, j) {
    return '<div class="orow"><input type="radio" name="c' + i + '" data-act="correct" data-j="' + j + '"' + (j === q.correctIndex ? ' checked' : '') + ' title="設為正解">' +
      '<b>' + LETTERS[j] + '</b><input type="text" data-q="opt" data-j="' + j + '" value="' + esc(o) + '" placeholder="選項 ' + LETTERS[j] + '">' +
      '<button class="btn sm" data-act="delopt" data-j="' + j + '"' + (q.options.length <= 2 ? ' disabled' : '') + '>✕</button></div>';
  }).join('');
  return head +
    '<label class="f">題目<textarea data-q="question" rows="2" placeholder="例如：以下哪種酒精飲料的酒精濃度最低？">' + esc(q.question) + '</textarea></label>' +
    '<div class="sub" style="margin:0 0 4px">選項（點左邊圓點 = 正解）</div>' + rows +
    '<button class="btn sm" data-act="addopt"' + (q.options.length >= MAX_OPTIONS ? ' disabled' : '') + '>＋ 新增選項</button></div>';
}

// 題目區事件（委派）
var qList = $('#qList');
qList.addEventListener('input', function (e) {
  var t = e.target, card = t.closest('.qcard');
  if (!card) return;
  var q = S.ed.data.questions[+card.dataset.i];
  if (t.dataset.q === 'question') q.question = t.value;
  if (t.dataset.q === 'opt') q.options[+t.dataset.j] = t.value;
  S.dirty = true;
  card.classList.remove('bad');
});
qList.addEventListener('change', function (e) {
  var t = e.target, card = t.closest('.qcard');
  if (!card || t.tagName !== 'SELECT') return;
  var q = S.ed.data.questions[+card.dataset.i];
  S.dirty = true;
  if (t.dataset.q === 'category') {
    q.category = t.value; q.answer = ''; q.options = []; q.correctIndex = -1;
    ensureCat(q.category).then(renderQuestions).catch(function (er) { toast(er.message, true); });
    return;
  }
  if (t.dataset.q === 'answer') { q.answer = t.value; rollAuto(q); }
  if (t.dataset.q === 'optionCount') { q.optionCount = +t.value; rollAuto(q); }
  renderQuestions();
});
qList.addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT' && b.type !== 'radio') return;
  var card = b.closest('.qcard'), i = +card.dataset.i, qs = S.ed.data.questions, q = qs[i], act = b.dataset.act;
  if (act === 'correct') { q.correctIndex = +b.dataset.j; S.dirty = true; card.classList.remove('bad'); return; }
  S.dirty = true;
  if (act === 'up' && i > 0) { qs.splice(i - 1, 0, qs.splice(i, 1)[0]); }
  if (act === 'down' && i < qs.length - 1) { qs.splice(i + 1, 0, qs.splice(i, 1)[0]); }
  if (act === 'del') { if (!confirm('刪除第 ' + (i + 1) + ' 題？')) return; qs.splice(i, 1); }
  if (act === 'reroll') rollAuto(q);
  if (act === 'addopt' && q.options.length < MAX_OPTIONS) q.options.push('');
  if (act === 'delopt' && q.options.length > 2) {
    var j = +b.dataset.j;
    q.options.splice(j, 1);
    if (q.correctIndex === j) q.correctIndex = -1; else if (q.correctIndex > j) q.correctIndex--;
  }
  renderQuestions();
});

// 拖曳排序（手機請用 ▲▼）
var dragFrom = -1;
qList.addEventListener('mousedown', function (e) {
  var h = e.target.closest('.handle');
  if (h) h.closest('.qcard').draggable = true;
});
document.addEventListener('mouseup', function () { $$('#qList .qcard').forEach(function (c) { c.draggable = false; }); });
qList.addEventListener('dragstart', function (e) {
  var c = e.target.closest('.qcard');
  if (!c) return;
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

// 儲存測驗
function validateAndBuild() {
  var d = S.ed.data, errs = [], bad = {};
  var title = $('#edTitle').value.trim();
  var id = $('#edId').value.trim();
  if (!title) errs.push('請輸入測驗名稱');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) errs.push('測驗代碼只能用英文、數字、- 與 _（最多 40 字）');
  if (S.ed.isNew && findQuiz(id)) errs.push('測驗代碼「' + id + '」已經存在，請換一個');
  if (!d.questions.length) errs.push('至少要有 1 題');

  var out = d.questions.map(function (q, i) {
    var n = '第 ' + (i + 1) + ' 題';
    if (q.mode === 'auto') {
      if (!q.category) { errs.push(n + '：請選擇類別'); bad[i] = 1; }
      else if (!q.answer) { errs.push(n + '：請選擇正解'); bad[i] = 1; }
      else if (q.options.length < 2 || q.correctIndex < 0) { errs.push(n + '：選項還沒抽出來（類別項目不足？）'); bad[i] = 1; }
      return { id: 'q' + (i + 1), mode: 'auto', question: (q.question || '').trim(), category: q.category, answer: q.answer,
        optionCount: q.options.length, options: q.options, correctIndex: q.correctIndex };
    }
    var opts = q.options.map(function (o) { return o.trim(); });
    if (!(q.question || '').trim()) { errs.push(n + '：請輸入題目'); bad[i] = 1; }
    if (opts.some(function (o) { return !o; })) { errs.push(n + '：有選項是空的'); bad[i] = 1; }
    else if (new Set(opts).size !== opts.length) { errs.push(n + '：有重複的選項'); bad[i] = 1; }
    if (q.correctIndex < 0) { errs.push(n + '：請勾選正解'); bad[i] = 1; }
    return { id: 'q' + (i + 1), mode: 'manual', question: q.question.trim(), options: opts, correctIndex: q.correctIndex };
  });
  return { errs: errs, bad: bad, quiz: {
    quizId: id, title: title, description: $('#edDesc').value.trim(), allowRetake: $('#edRetake').checked,
    updatedAt: new Date().toISOString(), questions: out } };
}

$('#btnEdSave').onclick = function () {
  var btn = this;
  var r = validateAndBuild();
  $$('#qList .qcard').forEach(function (c, i) { c.classList.toggle('bad', !!r.bad[i]); });
  if (r.errs.length) {
    toast(r.errs[0] + (r.errs.length > 1 ? '（還有 ' + (r.errs.length - 1) + ' 個問題）' : ''), true);
    var first = $('#qList .qcard.bad'); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  busy(btn, function () {
    $('#edStatus').textContent = '儲存中…';
    return call('admin_saveQuiz', { quiz: r.quiz, isNew: S.ed.isNew, baseUpdatedAt: S.ed.updatedAt })
      .then(function (j) {
        var saved = j.quiz; saved.updatedAt = j.updatedAt;
        var entry = findQuiz(saved.quizId);
        if (entry) { entry.updatedAt = j.updatedAt; entry.data = saved; } else { S.quizzes.unshift({ id: saved.quizId, updatedAt: j.updatedAt, data: saved }); }
        S.ed.isNew = false; S.ed.updatedAt = j.updatedAt; S.ed.data = clone(saved);
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
  var link = $('#sheetLink');
  link.classList.toggle('hidden', !cfg.sheetUrl);
  if (cfg.sheetUrl) link.href = cfg.sheetUrl;
  $('#resErr').classList.add('hidden');
  if (!cfg.gasUrl) { showResErr('系統還沒設定 Apps Script 網址。請系統擁有者打開 config.js 填入 gasUrl。'); }
}
function showResErr(msg) { var e = $('#resErr'); e.textContent = msg; e.classList.remove('hidden'); }

function loadResults() {
  if (!cfg.gasUrl) return Promise.resolve();
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
    stat(lat.length ? avg.toFixed(1) + (quizId ? ' / ' + total : '') : '-', '平均分（每人最新一次）') +
    stat(lat.length ? maxS : '-', '最高分') + '</div>';

  if (quizId && lat.length) {
    var acc = {};
    lat.forEach(function (r) { (r.answers || []).forEach(function (a) { var x = acc[a.id] || (acc[a.id] = { ok: 0, n: 0 }); x.n++; if (a.ok) x.ok++; }); });
    var ids = Object.keys(acc).sort(function (a, b) { return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10); });
    html += '<div class="card"><h2 style="font-size:16px;margin-bottom:8px">每題答對率</h2>' + ids.map(function (id) {
      var x = acc[id], p = Math.round(x.ok / x.n * 100), qq = quiz && quiz.data.questions.filter(function (q) { return q.id === id; })[0];
      var label = '第 ' + id.slice(1) + ' 題' + (qq ? '：' + (qq.mode === 'auto' ? qq.answer : (qq.question || '')) : '');
      return '<div class="acc' + (p < 40 ? ' low' : '') + '"><span class="l" title="' + esc(label) + '">' + esc(label) + '</span><span class="b"><i style="width:' + p + '%"></i></span><span class="p">' + p + '%</span></div>';
    }).join('') + '</div>';
  }

  var sorted = rows.slice().reverse();
  html += '<div class="card"><div class="row" style="margin-bottom:8px"><h2 style="font-size:16px">作答紀錄</h2><span class="sp"></span>' +
    '<button class="btn sm" id="btnCsv">下載 CSV</button></div><div style="max-height:480px;overflow:auto"><table><thead><tr><th>時間</th><th>暱稱</th><th>成績</th><th>備註</th>' +
    (quizId ? '' : '<th>測驗</th>') + '</tr></thead><tbody>' +
    (sorted.map(function (r) {
      return '<tr><td>' + esc(r.time) + '</td><td>' + esc(r.name) + '</td><td><b>' + r.score + '</b> / ' + r.total + '</td><td>' +
        (r._n > 1 ? '<span class="badge a">第 ' + r._n + ' 次作答</span>' : '') + '</td>' + (quizId ? '' : '<td class="mono">' + esc(r.quizId) + '</td>') + '</tr>';
    }).join('') || '<tr><td colspan="5" class="sub">還沒有作答紀錄</td></tr>') + '</tbody></table></div></div>';
  $('#resBody').innerHTML = html;

  var csvBtn = $('#btnCsv');
  if (csvBtn) csvBtn.onclick = function () {
    var lines = [['時間', '測驗', '暱稱', '分數', '總題數', '第幾次作答']].concat(rows.map(function (r) { return [r.time, r.quizId, r.name, r.score, r.total, r._n]; }));
    var csv = '﻿' + lines.map(function (l) { return l.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'results-' + (quizId || 'all') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  };
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
  if (saved) connect(saved).catch(function (e) { store('quizAdminKey', null); showLogin(e.message); });
  else showLogin();
})();

})();
