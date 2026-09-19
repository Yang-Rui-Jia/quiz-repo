/*
 * 全站共用設定檔 —— 只有「系統擁有者」需要改這個檔案，而且只需要改一次。
 * 這裡的內容都不是機密（LIFF ID、網址本來就是公開的），可以放心存在公開的 GitHub Repo。
 *
 * 機密資料（Channel Access Token、管理密碼）絕對不要寫在這裡，
 * 它們只放在後端（Cloudflare Worker）的「機密」設定裡。
 * 題目與正解也不在這個 repo 裡：它們存在後端的資料庫，只有後端拿得到。
 *
 * 填寫教學請看 docs/01-管理者建置教學.md
 */
window.APP_CONFIG = {
  // LIFF ID：LINE Developers → LINE Login channel → LIFF 分頁，格式像 "1234567890-AbcdEfgh"
  liffId: "2011670857-3KSWiVfK",

  // 後端（Cloudflare Worker）的網址，例如 "https://quiz-api.你的名稱.workers.dev"
  apiUrl: "https://quiz-api.examquiz.workers.dev",

  // 舊版後端（Google Apps Script）的網址。只有 apiUrl 留空時才會用到；換到 Cloudflare 之後可以刪掉這行。
  gasUrl: "https://script.google.com/macros/s/AKfycbyaZFLNaqWJzQ5nIC_qsb2W6WpN6pWy5k01HvNuH_EJRwOzbwnQOZAsPbSYJBivxx5S/exec",

  // LINE 官方帳號的 Basic ID（要含 @），例如 "@123abcde"
  // 在 LINE Official Account Manager 左上角、或「設定 → 帳號設定」可以看到
  oaId: "@254dxsyq"
};
