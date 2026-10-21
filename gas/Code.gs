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
 * 配信文面は「配信コンテンツ」シート。A 経過日数 / B 配信時刻 / F テキスト / G・H カード。
 * 送信済みは「配信ログ」シートで管理する。
 * エディタで installNurturingTrigger を1回実行すると、30分おきに当日分を送る。
 * 予約シート: A 送信日時 / B 記入者氏名 / C 所属カテゴリー / D 希望日時1 / E 希望日時2 / F 希望日時3 / G 事前の質問・相談・共有事項
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
var CONTENT_SHEET_NAME = '配信コンテンツ';
var LOG_SHEET_NAME = '配信ログ';
var LOG_HEADERS = ['LINEユーザーID', '友だち追加日', '経過日数', '送信日時'];

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
    var addedYmd = sheetDateToYmd_(sheet.getRange(row, 2).getValue());
    sendDueDeliveries_({
      userId: userId,
      addedYmd: addedYmd,
      days: 0,
      replyToken: replyToken,
      immediateOnly: true
    });
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
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var sheet = getFriendsSheet_();
    var values = sheet.getDataRange().getValues();
    var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var ctx = loadDeliveryContext_();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][2] || '').trim() !== '友だち') continue;
      var userId = String(values[i][0] || '').trim();
      var addedYmd = sheetDateToYmd_(values[i][1]);
      if (!userId || !addedYmd) continue;
      sendDueDeliveries_({
        userId: userId,
        addedYmd: addedYmd,
        days: daysBetween_(addedYmd, today),
        replyToken: '',
        immediateOnly: false
      }, ctx);
    }
  } finally {
    lock.releaseLock();
  }
}

function installNurturingTrigger() {
  getFriendsSheet_();
  getDeliveryLogSheet_();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'sendNurturingMessages') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('sendNurturingMessages').timeBased().everyMinutes(30).create();
}

function sendDueDeliveries_(opts, ctx) {
  var userId = String(opts.userId || '').trim();
  var addedYmd = String(opts.addedYmd || '').trim();
  var days = Number(opts.days);
  if (!userId || !addedYmd || isNaN(days) || days < 0) return;
  ctx = ctx || loadDeliveryContext_();
  var bundle = buildDayBundle_(ctx.contents, days);
  if (!bundle || !bundle.messages.length) return;
  if (opts.immediateOnly && !isImmediateTime_(bundle.timeRaw)) return;
  if (!opts.immediateOnly && !isDueTime_(bundle.timeRaw)) return;
  var key = sentKey_(userId, addedYmd, days);
  if (ctx.sent[key]) return;
  var sent = deliverMessages_(userId, bundle.messages, opts.replyToken || '');
  if (!sent.ok) return;
  appendDeliveryLog_(userId, addedYmd, days);
  ctx.sent[key] = true;
}

function loadDeliveryContext_() {
  return {
    contents: loadDeliveryContents_(),
    sent: loadSentKeys_()
  };
}

function loadDeliveryContents_() {
  var sheet = openSpreadsheet_().getSheetByName(CONTENT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) continue;
    var day = Number(values[i][0]);
    if (isNaN(day)) continue;
    var text = values[i][5] === null || values[i][5] === undefined ? '' : String(values[i][5]);
    var cards = [values[i][6], values[i][7]];
    var hasCard = cards.some(function (card) { return String(card || '').trim(); });
    if (text === '' && !hasCard) continue;
    list.push({
      day: day,
      timeRaw: values[i][1],
      text: text,
      cards: cards
    });
  }
  return list;
}

function buildDayBundle_(contents, days) {
  var messages = [];
  var timeRaw = null;
  var found = false;
  contents.forEach(function (item) {
    if (item.day !== days) return;
    if (!found) {
      timeRaw = item.timeRaw;
      found = true;
    }
    if (item.text !== '') messages.push({ type: 'text', text: item.text });
    item.cards.forEach(function (raw) {
      var card = parseCardMessage_(raw);
      if (card) messages.push(card);
    });
  });
  if (!found) return null;
  return { timeRaw: timeRaw, messages: messages };
}

function parseCardMessage_(raw) {
  var source = String(raw || '').trim();
  if (!source) return null;
  var title = matchCardField_(source, 'ラベル/タイトル') || matchCardField_(source, 'タイトル');
  var label = matchCardField_(source, 'ボタン名');
  var uri = extractUrl_(source);
  title = cleanCardText_(title);
  label = cleanCardText_(label) || '開く';
  if (!title || !uri) return null;
  if (title.length > 160) title = title.slice(0, 160);
  if (label.length > 20) label = label.slice(0, 20);
  return {
    type: 'template',
    altText: title.slice(0, 400),
    template: {
      type: 'buttons',
      text: title,
      actions: [{ type: 'uri', label: label, uri: uri }]
    }
  };
}

function matchCardField_(text, name) {
  var pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var matched = text.match(new RegExp(pattern + '\\s*[:：]\\s*([^\\n\\r]+)'));
  return matched ? matched[1].trim() : '';
}

function cleanCardText_(value) {
  return String(value || '').replace(/[\u0000-\u001F]/g, '').trim();
}

function extractUrl_(text) {
  var matched = String(text || '').match(/https?:\/\/[^\s　]+/);
  if (!matched) return '';
  return matched[0].replace(/[)）】、。,.]+$/g, '');
}

function isImmediateTime_(timeRaw) {
  if (timeRaw === '' || timeRaw === null || timeRaw === undefined) return true;
  if (Object.prototype.toString.call(timeRaw) === '[object Date]') return false;
  if (typeof timeRaw === 'number') return false;
  return /即時|直後/.test(String(timeRaw));
}

function isDueTime_(timeRaw) {
  if (isImmediateTime_(timeRaw)) return true;
  var target = scheduledMinutes_(timeRaw);
  if (target === null) return false;
  return nowMinutes_() >= target;
}

function scheduledMinutes_(timeRaw) {
  if (Object.prototype.toString.call(timeRaw) === '[object Date]' && !isNaN(timeRaw.getTime())) {
    return Number(Utilities.formatDate(timeRaw, TZ, 'H')) * 60 + Number(Utilities.formatDate(timeRaw, TZ, 'm'));
  }
  if (typeof timeRaw === 'number' && isFinite(timeRaw)) {
    var fraction = timeRaw % 1;
    if (fraction < 0) fraction += 1;
    return Math.round(fraction * 24 * 60) % (24 * 60);
  }
  var matched = String(timeRaw || '').trim().match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!matched) return null;
  var minutes = Number(matched[1]) * 60 + Number(matched[2]);
  if (minutes < 0 || minutes >= 24 * 60) return null;
  return minutes;
}

function nowMinutes_() {
  return Number(Utilities.formatDate(new Date(), TZ, 'H')) * 60 + Number(Utilities.formatDate(new Date(), TZ, 'm'));
}

function loadSentKeys_() {
  var sheet = getDeliveryLogSheet_();
  var values = sheet.getDataRange().getValues();
  var sent = {};
  for (var i = 1; i < values.length; i++) {
    var userId = String(values[i][0] || '').trim();
    var ymd = sheetDateToYmd_(values[i][1]);
    var day = values[i][2];
    if (!userId || !ymd || day === '' || day === null) continue;
    sent[sentKey_(userId, ymd, day)] = true;
  }
  return sent;
}

function appendDeliveryLog_(userId, addedYmd, days) {
  getDeliveryLogSheet_().appendRow([
    userId,
    addedYmd,
    days,
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss')
  ]);
}

function sentKey_(userId, ymd, day) {
  return userId + '\t' + ymd + '\t' + String(Number(day));
}

function getDeliveryLogSheet_() {
  var spreadsheet = openSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function deliverMessages_(userId, messages, replyToken) {
  if (!messages.length) return { ok: true, message: '' };
  if (replyToken) {
    var first = messages.slice(0, 5);
    var rest = messages.slice(5);
    var replied = postLineMessages_('https://api.line.me/v2/bot/message/reply', {
      replyToken: replyToken,
      messages: first
    });
    if (replied.ok) {
      if (!rest.length) return replied;
      return pushMessages_(userId, rest);
    }
  }
  return pushMessages_(userId, messages);
}

function pushMessages_(userId, messages) {
  if (!userId) return { ok: false, message: '送信先がありません。' };
  for (var i = 0; i < messages.length; i += 5) {
    var posted = postLineMessages_('https://api.line.me/v2/bot/message/push', {
      to: userId,
      messages: messages.slice(i, i + 5)
    });
    if (!posted.ok) return posted;
  }
  return { ok: true, message: '' };
}

function postLineMessages_(url, body) {
  var token = lineToken_();
  if (!token) {
    return { ok: false, message: 'LINEのトークンが読み取れていません。スクリプトプロパティの名前を確認してください。' };
  }
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, message: '' };
  return { ok: false, message: 'LINEからエラーが返りました（' + code + '）。' };
}

function openSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

function getFriendsSheet_() {
  var spreadsheet = openSpreadsheet_();
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
  var spreadsheet = openSpreadsheet_();
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
  var sent = pushMessages_(userId, [{ type: 'text', text: text }]);
  if (sent.ok) return sent;
  if (sent.message && sent.message.indexOf('エラー') !== -1) {
    return { ok: false, message: sent.message + '通知先のIDが、この公式LINEのIDか確認してください。' };
  }
  return sent;
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
