import { getMeta, initialize, unlockWithPassword, unlockWithBiometric, saveRecords, enableBiometric, disableBiometric, exportBackup, restoreBackup } from './vault.js';
import { loanSummary } from './loanMath.js';

const $ = id => document.getElementById(id);
const yen = value => `¥${Math.round(value).toLocaleString('ja-JP')}`;
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const displayDate = value => value ? value.replaceAll('-', '/') : '—';
let master = null;
let records = [];
let editingId = null;
let draftPhotos = [];
let hiddenAt = 0;
let toastTimer;

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500);
}
function errorMessage(error, fallback) { return error?.name === 'OperationError' ? 'パスワードが違うか、データを読み込めません。' : error?.message || fallback; }
function secureAvailable() { return Boolean(window.isSecureContext && window.crypto?.subtle && window.indexedDB); }

async function showAuth() {
  const meta = await getMeta();
  const setup = !meta;
  $('auth-screen').hidden = false;
  $('app').hidden = true;
  $('auth-description').textContent = setup ? '最初にパスワードを設定します。記録はこの端末内で暗号化されます。' : 'パスワードを入力して記録を開きます。';
  $('auth-submit').textContent = setup ? '利用を始める' : '開く';
  $('confirm-wrap').hidden = !setup;
  $('password-confirm').required = setup;
  $('face-unlock').hidden = !meta?.biometricId;
  $('password').autocomplete = setup ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
  $('auth-form').reset();
}
function openApp(result) {
  master = result.master;
  records = result.records;
  $('auth-screen').hidden = true;
  $('app').hidden = false;
  $('auth-error').textContent = '';
  renderRecords();
  updateFaceButton();
}
function lock() {
  master = null;
  records = [];
  draftPhotos = [];
  editingId = null;
  if ($('record-dialog').open) $('record-dialog').close();
  if ($('settings-dialog').open) $('settings-dialog').close();
  $('record-list').replaceChildren();
  $('photo-preview').replaceChildren();
  showAuth().catch(() => {});
}

function calculation() {
  const principal = Number($('calc-principal').value);
  const rate = Number($('calc-rate').value);
  const period = Number($('calc-period').value);
  if ([$('calc-principal').value, $('calc-rate').value, $('calc-period').value].some(value => value === '') || ![principal, rate, period].every(Number.isFinite) || [principal, rate, period].some(value => value < 0)) return null;
  const interest = Math.round(principal * rate / 100 * period);
  return { principal, interest, total: principal + interest };
}
function updateCalculator() {
  const result = calculation();
  $('calc-period-unit').textContent = $('calc-mode').value === 'daily' ? '日' : 'か月';
  $('calc-interest').textContent = result ? yen(result.interest) : '—';
  $('calc-total').textContent = result ? yen(result.total) : '—';
}
function updateFormTotal() {
  const summary = loanSummary({
    principal: Number($('principal').value || 0), interest: Number($('interest').value || 0),
    interestIntervalDays: $('interest-interval').value || null,
    lentDate: $('lent-date').value, dueDate: $('due-date').value
  });
  $('form-total').textContent = yen(summary.total);
  $('form-interest').textContent = yen(summary.accruedInterest);
  $('interest-label').textContent = summary.cycles === null ? '利息' : '利息（1回あたり）';
  $('form-total-label').textContent = summary.cycles === null ? '元金＋利息' : `返済日までの合計（利息 ${summary.cycles}回）`;
  $('form-total-detail').textContent = summary.cycles === null ? '' : `${summary.elapsedDays}日間 ÷ ${$('interest-interval').value}日ごと → ${summary.cycles}回加算、利息合計 ${yen(summary.accruedInterest)}`;
}

function dueBadge(date) {
  const days = Math.ceil((new Date(`${date}T00:00:00`) - new Date(`${localDate()}T00:00:00`)) / 86400000);
  if (days < 0) return { label: `${Math.abs(days)}日超過`, overdue: true };
  if (days === 0) return { label: '今日が返済日', overdue: false };
  if (days <= 7) return { label: `あと${days}日`, overdue: false };
  return null;
}
function renderRecords() {
  const query = $('search').value.trim().normalize('NFKC').toLocaleLowerCase('ja');
  const list = records.filter(record => `${record.person} ${record.reading || ''}`.normalize('NFKC').toLocaleLowerCase('ja').includes(query));
  if ($('sort').value === 'name') list.sort((a,b) => (a.reading || a.person).localeCompare(b.reading || b.person, 'ja'));
  else list.sort((a,b) => a.dueDate.localeCompare(b.dueDate) || a.person.localeCompare(b.person, 'ja'));
  $('record-count').textContent = records.length;
  const container = $('record-list');
  container.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('b');
    title.textContent = query ? '該当する人が見つかりません' : 'まだ記録がありません';
    const detail = document.createElement('span');
    detail.textContent = query ? '名前やよみがなを変えて検索してください。' : '「新しく記録」から貸付を登録できます。';
    empty.append(title, detail);
    container.append(empty);
    return;
  }
  for (const record of list) {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'record-card';
    const person = document.createElement('div'); person.className = 'person-cell';
    const name = document.createElement('strong'); name.textContent = record.person;
    const lent = document.createElement('small'); lent.textContent = `貸した日 ${displayDate(record.lentDate)}${record.interestIntervalDays ? ` · 利息 ${record.interestIntervalDays}日ごと` : ''}`;
    person.append(name, lent);
    const amount = document.createElement('div');
    const amountCaption = document.createElement('small'); amountCaption.textContent = '元金＋利息';
    const summary = loanSummary(record);
    const amountValue = document.createElement('div'); amountValue.className = 'amount total'; amountValue.textContent = yen(summary.total);
    amount.append(amountCaption, amountValue);
    if (summary.cycles !== null) { const times = document.createElement('small'); times.textContent = `利息 ${summary.cycles}回 · ${yen(summary.accruedInterest)}`; amount.append(times); }
    const due = document.createElement('div');
    const dueCaption = document.createElement('small'); dueCaption.textContent = '返済日';
    const dueValue = document.createElement('div'); dueValue.className = 'amount'; dueValue.textContent = displayDate(record.dueDate);
    due.append(dueCaption, dueValue);
    const badge = dueBadge(record.dueDate);
    if (badge) { const el = document.createElement('span'); el.className = `due-badge${badge.overdue ? ' overdue' : ''}`; el.textContent = badge.label; due.append(el); }
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
    card.append(person, amount, due, arrow);
    card.addEventListener('click', () => openRecord(record.id));
    container.append(card);
    if (record.dueDate <= localDate()) {
      const shift = document.createElement('button');
      shift.type = 'button'; shift.className = 'button button-outline shift-button'; shift.textContent = `返済日を来月（${displayDate(nextMonth(record.dueDate))}）にずらす`;
      shift.addEventListener('click', () => shiftToNextMonth(record.id));
      container.append(shift);
    }
  }
}
function nextMonth(date) {
  const [year, month, day] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
async function shiftToNextMonth(id) {
  const record = records.find(item => item.id === id);
  if (!record) return;
  const to = nextMonth(record.dueDate);
  if (!window.confirm(`「${record.person}」の返済日を ${displayDate(record.dueDate)} から ${displayDate(to)} にずらしますか？`)) return;
  const updated = { ...record, dueDate: to, dueHistory: [...(record.dueHistory || []), { from: record.dueDate, to, changedAt: new Date().toISOString() }] };
  try { await persist(records.map(item => item.id === id ? updated : item)); toast('返済日を来月にずらしました'); }
  catch (error) { toast(`保存できませんでした: ${errorMessage(error, '容量を確認してください')}`); }
}

function renderPhotos() {
  const container = $('photo-preview'); container.replaceChildren();
  draftPhotos.forEach((photo, index) => {
    const item = document.createElement('div'); item.className = 'photo-item';
    const img = document.createElement('img'); img.src = photo.data; img.alt = photo.name || `添付写真 ${index + 1}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `写真 ${index + 1} を削除`);
    remove.addEventListener('click', () => { draftPhotos.splice(index, 1); renderPhotos(); });
    item.append(img, remove); container.append(item);
  });
}
function renderHistory(history = []) {
  $('due-history-wrap').hidden = history.length === 0;
  const container = $('due-history'); container.replaceChildren();
  for (const entry of history) { const row = document.createElement('div'); row.textContent = `${displayDate(entry.from)} → ${displayDate(entry.to)}（${displayDate(localDate(new Date(entry.changedAt)))}）`; container.append(row); }
}
function openRecord(id = null) {
  editingId = id;
  $('record-form').reset();
  const record = records.find(item => item.id === id);
  $('record-dialog-title').textContent = record ? '記録を編集' : '新しい記録';
  $('delete-record').hidden = !record;
  $('shift-month').hidden = !(record && record.dueDate <= localDate());
  $('person').value = record?.person || '';
  $('reading').value = record?.reading || '';
  $('principal').value = record?.principal ?? '';
  $('interest').value = record?.interest ?? '';
  $('interest-interval').value = record?.interestIntervalDays ?? '';
  $('lent-date').value = record?.lentDate || localDate();
  $('due-date').value = record?.dueDate || '';
  $('memo').value = record?.memo || '';
  draftPhotos = structuredClone(record?.photos || []);
  renderPhotos(); renderHistory(record?.dueHistory || []); updateFormTotal();
  $('record-dialog').showModal();
}
async function persist(next) { await saveRecords(master, next); records = next; renderRecords(); }
function validMoney(input) { const value = Number(input.value); return input.value !== '' && Number.isFinite(value) && value >= 0 ? value : null; }
async function saveRecord(event) {
  event.preventDefault();
  const person = $('person').value.trim();
  const principal = validMoney($('principal'));
  const interest = validMoney($('interest'));
  const intervalInput = $('interest-interval').value.trim();
  const interestIntervalDays = intervalInput === '' ? null : Number(intervalInput);
  const dueDate = $('due-date').value;
  if (!person || principal === null || interest === null || !dueDate || (interestIntervalDays !== null && (!Number.isSafeInteger(interestIntervalDays) || interestIntervalDays < 1))) { toast('名前・金額・日数・返済日を確認してください'); return; }
  const previous = records.find(item => item.id === editingId);
  const dueHistory = [...(previous?.dueHistory || [])];
  if (previous && previous.dueDate !== dueDate) dueHistory.push({ from: previous.dueDate, to: dueDate, changedAt: new Date().toISOString() });
  const record = { id: previous?.id || crypto.randomUUID(), person, reading: $('reading').value.trim(), principal, interest, interestIntervalDays, lentDate: previous?.lentDate || localDate(), dueDate, memo: $('memo').value, photos: draftPhotos, dueHistory, createdAt: previous?.createdAt || new Date().toISOString() };
  const next = previous ? records.map(item => item.id === record.id ? record : item) : [...records, record];
  try { await persist(next); $('record-dialog').close(); draftPhotos = []; toast('保存しました'); }
  catch (error) { toast(`保存できませんでした: ${errorMessage(error, '容量を確認してください')}`); }
}
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { try {
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ name: file.name, data: canvas.toDataURL('image/jpeg', .82) });
    } catch(error) { reject(error); } finally { URL.revokeObjectURL(url); } };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}
async function addPhotos(event) {
  const files = [...event.target.files]; event.target.value = '';
  if (draftPhotos.length + files.length > 4) { toast('写真は最大4枚です'); return; }
  try { for (const file of files) { if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選んでください'); draftPhotos.push(await compressImage(file)); } renderPhotos(); }
  catch(error) { toast(errorMessage(error, '写真を追加できませんでした')); }
}
async function updateFaceButton() {
  const meta = await getMeta();
  $('face-toggle').textContent = meta?.biometricId ? '解除する' : '設定する';
}
async function toggleFace() {
  const button = $('face-toggle'); button.disabled = true;
  try {
    const meta = await getMeta();
    if (meta.biometricId) { await disableBiometric(); toast('Face IDを解除しました'); }
    else { await enableBiometric(master); toast('Face IDを設定しました'); }
    await updateFaceButton();
  } catch(error) { toast(errorMessage(error, 'Face IDを設定できませんでした')); }
  finally { button.disabled = false; }
}
async function downloadBackup() {
  try {
    const backup = await exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `貸付メモ-暗号化バックアップ-${localDate()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000); toast('暗号化バックアップを書き出しました');
  } catch(error) { toast(errorMessage(error, '書き出せませんでした')); }
}
async function importBackup(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  let backup; try { backup = JSON.parse(await file.text()); } catch { toast('バックアップファイルを読み込めません'); return; }
  const password = window.prompt('バックアップ作成時のパスワードを入力してください'); if (password === null) return;
  if (!window.confirm('現在の記録をバックアップの内容で置き換えます。続けますか？')) return;
  try { const result = await restoreBackup(backup, password); openApp(result); $('settings-dialog').close(); toast('復元しました'); }
  catch(error) { toast(errorMessage(error, '復元できませんでした')); }
}

function wireEvents() {
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault(); $('auth-error').textContent = '';
    const button = $('auth-submit'); button.disabled = true;
    try {
      const password = $('password').value;
      const meta = await getMeta();
      if (!meta && password !== $('password-confirm').value) throw new Error('パスワードが一致しません');
      if (!meta && password.length < 8) throw new Error('パスワードは8文字以上にしてください');
      openApp(meta ? await unlockWithPassword(password) : await initialize(password));
      toast(meta ? 'ロックを解除しました' : '利用を開始しました');
    } catch(error) { $('auth-error').textContent = errorMessage(error, '開けませんでした'); }
    finally { button.disabled = false; $('password').value = ''; $('password-confirm').value = ''; }
  });
  $('face-unlock').addEventListener('click', async () => { const button = $('face-unlock'); button.disabled = true; try { openApp(await unlockWithBiometric()); toast('ロックを解除しました'); } catch(error) { $('auth-error').textContent = errorMessage(error, 'Face IDで開けませんでした'); } finally { button.disabled = false; } });
  for (const id of ['calc-principal','calc-rate','calc-period','calc-mode']) $(id).addEventListener('input', updateCalculator);
  for (const id of ['principal','interest','interest-interval','due-date']) $(id).addEventListener('input', updateFormTotal);
  $('due-date').addEventListener('change', updateFormTotal);
  $('search').addEventListener('input', renderRecords); $('sort').addEventListener('change', renderRecords);
  $('new-button').addEventListener('click', () => openRecord());
  $('record-close').addEventListener('click', () => $('record-dialog').close());
  $('record-form').addEventListener('submit', saveRecord);
  for (const button of document.querySelectorAll('[data-wari]')) button.addEventListener('click', () => { const principal = validMoney($('principal')); if (!principal) { toast('先に元金を入力してください'); return; } $('interest').value = Math.round(principal * Number(button.dataset.wari) / 10); updateFormTotal(); });
  $('shift-month').addEventListener('click', () => { if (!$('due-date').value) { toast('先に返済日を入力してください'); return; } $('due-date').value = nextMonth($('due-date').value); updateFormTotal(); toast('返済日を来月にしました。「保存する」で確定します'); });
  $('photo-input').addEventListener('change', addPhotos);
  $('delete-record').addEventListener('click', async () => { const record = records.find(item => item.id === editingId); if (!record || !window.confirm(`「${record.person}」の記録を削除しますか？`)) return; try { await persist(records.filter(item => item.id !== editingId)); $('record-dialog').close(); toast('削除しました'); } catch(error) { toast(errorMessage(error, '削除できませんでした')); } });
  $('settings-open').addEventListener('click', () => { updateFaceButton(); $('settings-dialog').showModal(); });
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  $('face-toggle').addEventListener('click', toggleFace);
  $('export-button').addEventListener('click', downloadBackup);
  $('import-button').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', importBackup);
  $('lock-button').addEventListener('click', lock);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else if (master && hiddenAt && Date.now() - hiddenAt > 60000) lock(); });
}
async function start() {
  if (!secureAvailable()) { $('auth-description').textContent = 'HTTPSまたはlocalhostで開いてください。この環境では暗号化保存を使用できません。'; $('auth-form').hidden = true; return; }
  wireEvents();
  for (const [from, to] of [['15','10'],['10','7'],['8','5'],['5.5','3.8'],['5','3'],['3','2'],['2','1']]) {
    const row = document.createElement('div'); row.className = 'rate-row';
    const left = document.createElement('span'); left.textContent = `${from}枠`;
    const right = document.createElement('span'); right.textContent = `▷▶︎▷ ${to}`;
    row.append(left, right); $('rate-rows').append(row);
  }
  updateCalculator();
  try { await showAuth(); } catch(error) { $('auth-description').textContent = errorMessage(error, '保存領域を開けませんでした'); $('auth-form').hidden = true; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
start();
