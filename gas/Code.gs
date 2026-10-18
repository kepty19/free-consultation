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
 * 友だち追加の記録は、先頭シートの右隣の「友だち」シートへ追記する。
 * LINE Developers の Messaging API で、Webhook URL にこのウェブアプリの URL を設定する。
 * 翌日・翌々日の送信は、エディタで installNurturingTrigger を1回実行すると、毎日10時に動く。
 * 3通の文面は下の NURTURE_IMMEDIATE / NURTURE_NEXT_DAY / NURTURE_DAY_AFTER。
 * A 送信日時 / B 記入者氏名 / C 所属カテゴリー / D 希望日時1 / E 希望日時2 / F 希望日時3 / G 事前の質問・相談・共有事項
 */

var TZ = 'Asia/Tokyo';
var SPREADSHEET_ID = '1lD7nEz-AuRXTzSql2fH6FIGyVJxt2JcIXp-kRFc7-9c';
var NOTIFY_LINE_USER_ID = 'U29caba1286e1cd99e35c796af844c042';
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
var FRIEND_SHEET_NAME = '友だち';
var FRIEND_HEADERS = [
  'LINEユーザーID',
  '友だち追加日時',
  '状態',
  '登録直後_送信日時',
  '翌日_送信日時',
  '翌々日_送信日時'
];
var NURTURE_IMMEDIATE = '友だち追加ありがとうございます。';
var NURTURE_NEXT_DAY = '昨日は友だち追加ありがとうございました。';
var NURTURE_DAY_AFTER = 'ご登録から2日が経ちました。';

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'linecheck') {
    return json_(checkLine_());
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('無料相談予約')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    var data = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (data.events) return json_(handleLineWebhook_(data));
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

function handleLineWebhook_(data) {
  var events = data.events || [];
  events.forEach(function (event) {
    if (!event || !event.source || event.source.type !== 'user') return;
    var userId = String(event.source.userId || '').trim();
    if (!userId) return;
    if (event.type === 'follow') recordFollow_(userId, event.timestamp, event.replyToken);
    if (event.type === 'unfollow') markUnfollow_(userId);
  });
  return { ok: true };
}

function recordFollow_(userId, timestamp, replyToken) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getFriendsSheet_();
    var row = findFriendRow_(sheet, userId);
    var when = timestamp ? new Date(Number(timestamp)) : new Date();
    var whenText = Utilities.formatDate(when, TZ, 'yyyy-MM-dd HH:mm:ss');
    if (!row) {
      sheet.appendRow([userId, whenText, '友だち', '', '', '']);
      row = sheet.getLastRow();
    } else {
      sheet.getRange(row, 2, 1, 5).setValues([[whenText, '友だち', '', '', '']]);
    }
    if (sheet.getRange(row, 4).getValue()) return;
    var sent = replyToken ? replyLine_(replyToken, NURTURE_IMMEDIATE) : { ok: false };
    if (!sent.ok) sent = sendLine_(userId, NURTURE_IMMEDIATE);
    if (sent.ok) {
      sheet.getRange(row, 4).setValue(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'));
    }
  } finally {
    lock.releaseLock();
  }
}

function markUnfollow_(userId) {
  var sheet = getFriendsSheet_();
  var row = findFriendRow_(sheet, userId);
  if (!row) return;
  sheet.getRange(row, 3).setValue('ブロック');
}

function sendNurturingMessages() {
  var sheet = getFriendsSheet_();
  var values = sheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var sentAt = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][2] || '').trim() !== '友だち') continue;
    var userId = String(values[i][0] || '').trim();
    var added = sheetDateToYmd_(values[i][1]);
    if (!userId || !added) continue;
    var days = daysBetween_(added, today);
    if (!values[i][3]) {
      if (sendLine_(userId, NURTURE_IMMEDIATE).ok) sheet.getRange(i + 1, 4).setValue(sentAt);
    }
    if (days === 1 && !values[i][4]) {
      if (sendLine_(userId, NURTURE_NEXT_DAY).ok) sheet.getRange(i + 1, 5).setValue(sentAt);
    }
    if (days === 2 && !values[i][5]) {
      if (sendLine_(userId, NURTURE_DAY_AFTER).ok) sheet.getRange(i + 1, 6).setValue(sentAt);
    }
  }
}

function installNurturingTrigger() {
  getFriendsSheet_();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'sendNurturingMessages') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('sendNurturingMessages').timeBased().atHour(10).everyDays(1).create();
}

function getFriendsSheet_() {
  var spreadsheet = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID
  );
  var sheet = spreadsheet.getSheetByName(FRIEND_SHEET_NAME);
  if (!sheet) {
    var first = spreadsheet.getSheetById(0) || spreadsheet.getSheets()[0];
    var index = Math.max(spreadsheet.getSheets().indexOf(first), 0);
    sheet = spreadsheet.insertSheet(FRIEND_SHEET_NAME, index + 1);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, FRIEND_HEADERS.length).setValues([FRIEND_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findFriendRow_(sheet, userId) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === userId) return i + 1;
  }
  return 0;
}

function sheetDateToYmd_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  }
  var match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function daysBetween_(fromYmd, toYmd) {
  var from = new Date(fromYmd + 'T00:00:00+09:00').getTime();
  var to = new Date(toYmd + 'T00:00:00+09:00').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function getSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  var spreadsheet = SpreadsheetApp.openById(id);
  var sheet = spreadsheet.getSheetById(0) || spreadsheet.getSheets()[0];
  if (!sheet) throw new Error('シートが見つかりません');
  return sheet;
}

function checkLine_() {
  var token = lineToken_();
  if (!token) {
    return { ok: false, message: 'トークンが読み取れていません。' };
  }
  var bot = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var profile = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + NOTIFY_LINE_USER_ID, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  return {
    ok: profile.getResponseCode() === 200,
    botStatus: bot.getResponseCode(),
    bot: bot.getContentText(),
    profileStatus: profile.getResponseCode(),
    profile: profile.getContentText()
  };
}

function sendLine_(userId, text) {
  var token = lineToken_();
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

function replyLine_(replyToken, text) {
  var token = lineToken_();
  if (!token || !replyToken) return { ok: false, message: '' };
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, message: '' };
  return { ok: false, message: '' };
}

function lineToken_() {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  return token ? String(token).trim() : '';
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
