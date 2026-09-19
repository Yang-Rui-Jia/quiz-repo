/*
 * 全站共用設定檔 —— 只有「系統擁有者」需要改這個檔案，而且只需要改一次。
 * 這裡的內容都不是機密（LIFF ID、網址本來就是公開的），可以放心存在公開的 GitHub Repo。
 *
 * 機密資料（Channel Access Token、管理密碼）絕對不要寫在這裡，
 * 它們只放在 Google Apps Script 的「指令碼屬性」裡。
 * 題目與正解也不在這個 repo 裡：它們存在你的 Google Sheet，只有後端拿得到。
 *
 * 填寫教學請看 docs/01-管理者建置教學.md
 */
window.APP_CONFIG = {
  // LIFF ID：LINE Developers → LINE Login channel → LIFF 分頁，格式像 "1234567890-AbcdEfgh"
  liffId: "2011670857-3KSWiVfK",

  // Google Apps Script 網頁應用程式網址：部署後取得，結尾是 /exec
  gasUrl: "https://script.google.com/macros/s/AKfycbyaZFLNaqWJzQ5nIC_qsb2W6WpN6pWy5k01HvNuH_EJRwOzbwnQOZAsPbSYJBivxx5S/exec",

  // LINE 官方帳號的 Basic ID（要含 @），例如 "@123abcde"
  // 在 LINE Official Account Manager 左上角、或「設定 → 帳號設定」可以看到
  oaId: "@254dxsyq",

  // （選填）Google Sheet 的網址，管理後台會顯示「開啟 Google Sheet」連結
  sheetUrl: ""
};
