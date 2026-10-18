/**
 * 無料相談の予約バックエンド
 *
 * 保護者が送った希望内容を、指定スプレッドシートの先頭シート（gid=0）へ追記し、
 * NOTIFY_LINE_USER_ID にだけ LINE で通知する。
 * Googleカレンダーは使わない。
 *
 * デプロイ:
 * 1. このコードを、対象スプレッドシートを編集できる Google アカウントの Apps Script に貼る
 * 2. プロジェクトの設定 → スクリプト プロパティ
 *    - LINE_CHANNEL_ACCESS_TOKEN … Messaging API のチャネルアクセストークン
 *    - SPREADSHEET_ID … 省略時は下の定数
 * 3. デプロイ → 新しいデプロイ → ウェブアプリ
 *    - 次のユーザーとして実行: 自分
 *    - アクセスできるユーザー: 全員
 * 4. HTML ファイルを追加し、名前を index にする。中身はリポジトリの index.html
 * 5. デプロイを管理 → 鉛筆 → バージョン「新バージョン」で更新する
 *    ウェブアプリの URL を開くと予約画面になる
 *
 * シートが空のときだけ、1行目に見出しを書く。
 * A 送信日時 / B 記入者氏名 / C 所属カテゴリー / D 希望日時1 / E 希望日時2 / F 希望日時3 / G 事前の質問・相談・共有事項
 */

var TZ = 'Asia/Tokyo';
var SPREADSHEET_ID = '1lD7nEz-AuRXTzSql2fH6FIGyVJxt2JcIXp-kRFc7-9c';
var NOTIFY_LINE_USER_ID = 'U9de56864ced4187e6270d26ece292bcd';
var CATEGORIES = ['U-18', 'U-15', 'U-12', 'U-10', 'その他'];
var HORIZON_DAYS = 90;
var HEADERS = [
  '送信日時',
  '記入者氏名',
  '所属カテゴリー',
  '希望日時1',
  '希望日時2',
  '希望日時3',
  '事前の質問・相談・共有事項'
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('無料相談予約')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    var data = JSON.parse((e.postData && e.postData.contents) || '{}');
    return json_(submitConsultation(data));
  } catch (err) {
    return json_({ success: false, message: '送信できませんでした。時間をおいて、もう一度お試しください。' });
  }
}

function submitConsultation(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var parsed = parseRequest_(data || {});
    if (parsed.error) return { success: false, message: parsed.error };

    appendRequest_(parsed);
    var line = notifyLine_();
    if (!line.ok) {
      return {
        success: true,
        message: '希望は保存しました。LINE通知は送れませんでした。\n' + line.message
      };
    }
    return {
      success: true,
      message: '希望を送信しました。内容を確認のうえ、ご連絡します。'
    };
  } catch (err) {
    return { success: false, message: '送信できませんでした。時間をおいて、もう一度お試しください。' };
  } finally {
    lock.releaseLock();
  }
}

function parseRequest_(data) {
  var name = String(data.name || '').trim();
  var category = String(data.category || '').trim();
  var note = String(data.note || '').trim();
  var preferences = data.preferences;

  if (!name || name.length > 80) {
    return { error: '記入者の氏名を入力してください。' };
  }
  if (CATEGORIES.indexOf(category) === -1) {
    return { error: '選手の所属カテゴリーを選択してください。' };
  }
  if (note.length > 2000) {
    return { error: '事前の質問・相談・共有事項は2000文字以内で入力してください。' };
  }
  if (!preferences || preferences.length !== 3) {
    return { error: '希望日時を3つ選択してください。' };
  }

  var slots = [];
  var seen = {};
  for (var i = 0; i < preferences.length; i++) {
    var slot = preferences[i] || {};
    var date = String(slot.date || '').trim();
    var time = String(slot.time || '').trim();
    var reason = invalidSlotReason_(date, time, seen);
    if (reason) return { error: reason };
    seen[date + ' ' + time] = true;
    slots.push({ date: date, time: time });
  }

  return {
    name: name,
    category: category,
    note: note,
    slots: slots
  };
}

function invalidSlotReason_(date, time, seen) {
  if (!isValidYmd_(date) || allowedTimes_().indexOf(time) === -1) {
    return '希望日時を選び直してください。';
  }
  if (seen[date + ' ' + time]) {
    return '同じ日時が重複しています。別の日時を選んでください。';
  }

  var start = slotStart_(date, time);
  var now = new Date();
  if (start.getTime() <= now.getTime()) {
    return '過去の日時は選択できません。別の日時を選んでください。';
  }
  if (date > tokyoPlusDays_(HORIZON_DAYS)) {
    return '希望日時は' + HORIZON_DAYS + '日以内で選択してください。';
  }
  return '';
}

function allowedTimes_() {
  var times = [];
  for (var minutes = 8 * 60; minutes <= 23 * 60; minutes += 30) {
    times.push(pad2_(Math.floor(minutes / 60)) + ':' + pad2_(minutes % 60));
  }
  return times;
}

function appendRequest_(parsed) {
  var sheet = getSheet_();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }

  var submittedAt = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([
    submittedAt,
    safeCell_(parsed.name),
    parsed.category,
    formatSlot_(parsed.slots[0]),
    formatSlot_(parsed.slots[1]),
    formatSlot_(parsed.slots[2]),
    safeCell_(parsed.note)
  ]);
}

function notifyLine_() {
  return sendLine_(
    NOTIFY_LINE_USER_ID,
    'Kepty English U-18の無料相談の予約希望が送信されました。ご確認ください。'
  );
}

function getSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  var spreadsheet = SpreadsheetApp.openById(id);
  var sheet = spreadsheet.getSheetById(0) || spreadsheet.getSheets()[0];
  if (!sheet) throw new Error('シートが見つかりません');
  return sheet;
}

function sendLine_(userId, text) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  token = token ? String(token).trim() : '';
  if (!token || !userId) {
    return { ok: false, message: 'LINEのトークンが読み取れていません。スクリプトプロパティの名前を確認してください。' };
  }
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, message: '' };
  return { ok: false, message: 'LINEからエラーが返りました（' + code + '）。通知先のIDが、この公式LINEのIDか確認してください。' };
}

function safeCell_(value) {
  var text = String(value || '');
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function formatSlot_(slot) {
  return slot.date + ' ' + slot.time;
}

function isValidYmd_(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  return Utilities.formatDate(slotStart_(ymd, '12:00'), TZ, 'yyyy-MM-dd') === ymd;
}

function slotStart_(date, time) {
  return new Date(date + 'T' + time + ':00+09:00');
}

function tokyoPlusDays_(days) {
  var parts = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd').split('-');
  var utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days));
  return utc.toISOString().slice(0, 10);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
