const DB_NAME = 'kashitsuke-memo-v1';
const ITERATIONS = 600000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let dbPromise;

function bytesToBase64(bytes) { let value = ''; for (let i = 0; i < bytes.length; i += 1) value += String.fromCharCode(bytes[i]); return btoa(value); }
function base64ToBytes(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }
function toBuffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }

function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('items'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function read(key) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('items', 'readonly').objectStore('items').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(values) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('items', 'readwrite');
    const store = transaction.objectStore('items');
    for (const [key, value] of Object.entries(values)) store.put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function aesKey(bytes) { return crypto.subtle.importKey('raw', toBuffer(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function encrypt(bytes, keyBytes) {
  const iv = randomBytes(12);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyBytes), toBuffer(bytes)));
  return { iv: bytesToBase64(iv), data: bytesToBase64(encrypted) };
}
async function decrypt(sealed, keyBytes) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(sealed.iv) }, await aesKey(keyBytes), toBuffer(base64ToBytes(sealed.data))));
}
async function passwordKey(password, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: base64ToBytes(salt), iterations, hash: 'SHA-256' }, material, 256));
}

export async function getMeta() { return read('meta'); }
export async function initialize(password) {
  if (await getMeta()) throw new Error('設定済みです');
  const master = randomBytes(32);
  const salt = bytesToBase64(randomBytes(16));
  const meta = { version: 1, salt, iterations: ITERATIONS, passwordWrap: await encrypt(master, await passwordKey(password, salt)) };
  const vault = await encrypt(encoder.encode(JSON.stringify({ records: [] })), master);
  await write({ meta, vault });
  return { master, records: [] };
}
export async function unlockWithPassword(password) {
  const meta = await getMeta();
  if (!meta) throw new Error('初期設定が必要です');
  const master = await decrypt(meta.passwordWrap, await passwordKey(password, meta.salt, meta.iterations));
  const records = await decryptVault(master);
  return { master, records };
}
export async function decryptVault(master) {
  const vault = await read('vault');
  const data = JSON.parse(decoder.decode(await decrypt(vault, master)));
  if (!Array.isArray(data.records)) throw new Error('記録を読み込めません');
  return data.records;
}
export async function saveRecords(master, records) {
  const vault = await encrypt(encoder.encode(JSON.stringify({ records })), master);
  await write({ vault });
}
export async function exportBackup() {
  const [meta, vault] = await Promise.all([read('meta'), read('vault')]);
  const { biometricId, biometricSalt, biometricWrap, ...passwordMeta } = meta;
  return { format: 'kashitsuke-memo-backup', version: 1, meta: passwordMeta, vault };
}
export async function restoreBackup(backup, password) {
  if (backup?.format !== 'kashitsuke-memo-backup' || backup.version !== 1 || !backup.meta?.passwordWrap || !backup.vault) throw new Error('対応していないバックアップです');
  const master = await decrypt(backup.meta.passwordWrap, await passwordKey(password, backup.meta.salt, backup.meta.iterations));
  const data = JSON.parse(decoder.decode(await decrypt(backup.vault, master)));
  if (!Array.isArray(data.records)) throw new Error('記録を読み込めません');
  await write({ meta: backup.meta, vault: backup.vault });
  return { master, records: data.records };
}

function prfOptions(salt) { return { prf: { eval: { first: base64ToBytes(salt) } } }; }
async function credentialSecret(id, salt) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: randomBytes(32), allowCredentials: [{ type: 'public-key', id: base64ToBytes(id) }],
    userVerification: 'required', extensions: prfOptions(salt), timeout: 60000
  } });
  const result = assertion?.getClientExtensionResults()?.prf?.results?.first;
  if (!result) throw new Error('この端末ではFace IDによる暗号解除を利用できません');
  return new Uint8Array(result);
}
export async function enableBiometric(master) {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('この環境はFace IDに対応していません');
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: randomBytes(32), rp: { name: '貸付メモ' },
    user: { id: randomBytes(32), name: 'local-user', displayName: '貸付メモ' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    extensions: { prf: {} }, timeout: 60000
  } });
  if (!credential) throw new Error('Face IDの設定を完了できませんでした');
  const biometricId = bytesToBase64(new Uint8Array(credential.rawId));
  const biometricSalt = bytesToBase64(randomBytes(32));
  const secret = await credentialSecret(biometricId, biometricSalt);
  const meta = await getMeta();
  await write({ meta: { ...meta, biometricId, biometricSalt, biometricWrap: await encrypt(master, secret) } });
}
export async function disableBiometric() {
  const meta = await getMeta();
  const { biometricId, biometricSalt, biometricWrap, ...withoutBiometric } = meta;
  await write({ meta: withoutBiometric });
}
export async function unlockWithBiometric() {
  const meta = await getMeta();
  if (!meta?.biometricId) throw new Error('Face IDは設定されていません');
  const secret = await credentialSecret(meta.biometricId, meta.biometricSalt);
  const master = await decrypt(meta.biometricWrap, secret);
  return { master, records: await decryptVault(master) };
}
