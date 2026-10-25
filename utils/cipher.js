/**
 * 留言内容加密（客户端加解密）
 *
 * 目标：口令 + 留言文字在「传输中」和「数据库里」都不是明文。
 * 云函数只做存储和转发，它拿不到密钥，也就不可能解密；数据库里看到的是
 * `v1.<base64>` 这样的密文。
 *
 * 方案：
 *   密钥  PBKDF2-SHA256(口令, 固定盐, 20000 次) → 64 字节
 *         前 32 字节 = AES-256-CBC 的 key；后 32 字节 = HMAC-SHA256 的 key
 *   载荷  v1.<base64( iv(16) || ciphertext || mac(32) )>
 *         先加密再认证（encrypt-then-MAC），密文被改过会认证失败、直接丢弃。
 *
 * 已知边界（别自欺欺人）：
 *   口令只有 4 位数字（1 万种）。PBKDF2 只是把每次尝试变慢，挡不住拿到密文人
 *   离线穷举 —— 真要更强，得把口令改成更长的随机串。
 *   这个方案能解决的是：抓包/数据库/后台截图看不到留言原文。
 *
 * 只用到 crypto-js 的一个子集，放在 utils/vendor/crypto-js（构建 npm 之前就有的依赖，
 * 不额外装包，主包只多约 118KB）。
 */
const Core = require('./vendor/crypto-js/core');

// 顺序有讲究：hmac 要在 sha256 之前 —— sha256.js 加载时会用 Hasher._createHmacHelper
require('./vendor/crypto-js/hmac');
require('./vendor/crypto-js/sha256');
require('./vendor/crypto-js/sha1');
require('./vendor/crypto-js/md5');
require('./vendor/crypto-js/pbkdf2');
require('./vendor/crypto-js/evpkdf');
require('./vendor/crypto-js/cipher-core');
require('./vendor/crypto-js/enc-base64');
require('./vendor/crypto-js/enc-utf8');
require('./vendor/crypto-js/pad-pkcs7');
require('./vendor/crypto-js/aes');

const CryptoJS = Core;

const PREFIX = 'v1.';
/** 固定盐：口令空间太小，盐主要用来防通用彩虹表，不指望它救强度 */
const SALT = 'konggu.leaveBoard.v1';
/** 迭代次数：解锁时只算一次，20000 次大概几百毫秒，用户感知不明显 */
const ITERATIONS = 20000;
/** PBKDF2 输出 16 words = 64 字节 */
const KEY_WORDS = 16;
const IV_BYTES = 16;
const MAC_BYTES = 32;

/** 同一口令只派生一次，页面保活期间复用 */
let cache = { pin: '', key: null };

/** WordArray -> Uint8Array */
function toBytes(wordArray) {
  const { words, sigBytes } = wordArray;
  const bytes = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i += 1) {
    bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return bytes;
}

/**
 * Uint8Array -> WordArray
 *
 * 注意：不能写 `WordArray.create(uint8array)` —— 没引 lib-typedarrays 时它会把
 * 每个字节当成一个 32 位 word，sigBytes 变 4 倍、内容全乱（踩过）。
 * 这里手工按大端拼 word，稳。
 */
function fromBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const words = [];
  for (let i = 0; i < u8.length; i += 1) {
    words[i >>> 2] |= u8[i] << (24 - (i % 4) * 8);
  }
  return CryptoJS.lib.WordArray.create(words, u8.length);
}

/**
 * 随机 IV。
 *
 * 别用 `wx.getRandomValues`：它只有回调式（success 里拿 randomValues），
 * encrypt 是同步接口，拿不到返回值 —— 直接当 ArrayBuffer 用会得到空 IV，
 * 于是「自己加密自己解不开」（踩过，密文里 iv 段是 0 字节）。
 *
 * 这里用 SHA256(时间 + 自增序号 + Math.random) 取 16 字节：
 * 序号保证同一次运行内绝不重复，时间/Math.random 提供不可预测性。
 * IV 本身是公开随密文存的，不需要保密，只要不重复即可。
 */
let ivSeq = 0;
function randomBytes(size) {
  ivSeq += 1;
  const seed = `${Date.now()}.${ivSeq}.${Math.random()}.${Math.random()}`;
  const hash = toBytes(CryptoJS.SHA256(seed));
  return fromBytes(hash.slice(0, size));
}

/**
 * 从口令派生密钥。
 * @param {string} pin 4 位数字口令（原样使用，不做归一化，避免与服务端口径不一致）
 * @returns {{ encKey: any, macKey: any }}
 */
function deriveKey(pin) {
  const value = String(pin == null ? '' : pin);
  if (cache.pin === value && cache.key) return cache.key;

  const started = Date.now();
  const all = CryptoJS.PBKDF2(value, CryptoJS.enc.Utf8.parse(SALT), {
    keySize: KEY_WORDS,
    iterations: ITERATIONS,
    hasher: CryptoJS.algo.SHA256,
  });
  const bytes = toBytes(all);
  cache = {
    pin: value,
    key: {
      encKey: fromBytes(bytes.slice(0, 32)),
      macKey: fromBytes(bytes.slice(32, 64)),
    },
  };
  console.log('[cipher] 派生密钥用时', Date.now() - started, 'ms');
  return cache.key;
}

/** 丢弃缓存（上锁时调用，别让密钥留在内存里） */
function clearKey() {
  cache = { pin: '', key: null };
}

/**
 * 加密一段文字。
 * @param {{encKey:any,macKey:any}} key deriveKey 的返回值
 * @param {string} text 明文
 * @returns {string} `v1.<base64>`；空串原样返回空串
 */
function encrypt(key, text) {
  const plain = String(text == null ? '' : text);
  if (!plain) return '';
  if (!key) throw new Error('缺少密钥，请重新输入口令');

  const iv = randomBytes(IV_BYTES);
  if (!iv || iv.sigBytes !== IV_BYTES) {
    // 防呆：IV 长度不对时 CBC 会产出「自己能加密、自己解不开」的密文
    throw new Error('IV 生成异常，拒绝加密');
  }
  const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(plain), key.encKey, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const ciphertext = encrypted.ciphertext;
  const mac = CryptoJS.HmacSHA256(iv.clone().concat(ciphertext), key.macKey);
  const payload = iv.clone().concat(ciphertext).concat(mac);
  return PREFIX + CryptoJS.enc.Base64.stringify(payload);
}

/**
 * 解密。历史数据（没有 v1. 前缀）当明文原样返回，保证老留言还能看。
 * 认证失败/格式不对返回空串，调用方自己决定显示什么。
 */
function decrypt(key, payload) {
  const text = String(payload == null ? '' : payload);
  if (!text) return '';
  if (text.indexOf(PREFIX) !== 0) return text;
  if (!key) return '';

  try {
    const bytes = toBytes(CryptoJS.enc.Base64.parse(text.slice(PREFIX.length)));
    if (bytes.length < IV_BYTES + 16 + MAC_BYTES) {
      console.error('[cipher] 密文长度异常：', bytes.length);
      return '';
    }
    const iv = fromBytes(bytes.slice(0, IV_BYTES));
    const ciphertext = fromBytes(bytes.slice(IV_BYTES, bytes.length - MAC_BYTES));
    const mac = fromBytes(bytes.slice(bytes.length - MAC_BYTES));

    if (!iv.sigBytes || ciphertext.sigBytes % 16 !== 0) {
      console.error('[cipher] 载荷结构不对，iv=', iv.sigBytes, 'ct=', ciphertext.sigBytes);
      return '';
    }

    const expected = CryptoJS.HmacSHA256(iv.clone().concat(ciphertext), key.macKey);
    if (expected.toString() !== mac.toString()) {
      // 口令不对 / 数据被改过
      console.error('[cipher] 校验失败，丢弃这条内容');
      return '';
    }

    const plain = CryptoJS.AES.decrypt({ ciphertext }, key.encKey, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }).toString(CryptoJS.enc.Utf8);
    return plain || '';
  } catch (err) {
    console.error('[cipher] 解密异常：', err);
    return '';
  }
}

/** 是不是密文（历史明文返回 false） */
function isCipher(text) {
  return String(text == null ? '' : text).indexOf(PREFIX) === 0;
}

module.exports = {
  PREFIX,
  deriveKey,
  clearKey,
  encrypt,
  decrypt,
  isCipher,
};
