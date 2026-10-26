/**
 * 探活 Agnes 的两个接口域名，判断「这把 key 属于哪个站」。
 *
 *   node .workbuddy/scripts/probe-agnes-endpoints.mjs
 *
 * 为什么需要：云函数缺省打 `api.agnes-ai.cn`，而 docs/prompt-tool 用的是
 * `apihub.agnes-ai.com`。两个站是独立集群，token plan 只在买的那一边生效，
 * 打到另一边就会撞「image queue is full」而不是 401 —— 这正是要排除的可能。
 *
 * 判定方法：故意传空 prompt。
 *   401/403 → 这个站的 key 不认（说明云函数配的是另一把）
 *   400/422 → key 通过鉴权，只是参数不对 → 这把 key 属于这个站
 * 空 prompt 不会出图，不消耗额度。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const configPath = path.join(root, 'docs/prompt-tool/config.local.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const key = cfg.api_key;
if (!key) {
  console.error('config.local.json 里没有 api_key');
  process.exit(1);
}

const MODEL = 'agnes-image-2.5-flash';
const HOSTS = [
  { host: 'api.agnes-ai.cn', note: '云函数缺省值' },
  { host: 'apihub.agnes-ai.com', note: 'docs/prompt-tool 在用' },
];

const mask = (k) => `${k.slice(0, 8)}…(${k.length} 字符)`;

function post(host, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: host,
        path: '/v1/images/generations',
        method: 'POST',
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${key}`,
          'User-Agent': 'Mozilla/5.0 (probe)',
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, text: text.slice(0, 240) }));
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('timeout 20s')));
    req.on('error', (err) => resolve({ status: 0, text: String(err.message) }));
    req.write(payload);
    req.end();
  });
}

const verdict = (r) => {
  if (r.status === 401 || r.status === 403) return '❌ key 不被这个站认可';
  if (r.status === 400 || r.status === 422) return '✅ key 有效（只是参数不合法）';
  if (r.status === 429 || /queue is full/i.test(r.text)) return '⚠️ 鉴权通过，但撞队列/限流';
  if (r.status === 200 || r.status === 201) return '⚠️ 竟然成功了（不应该，prompt 是空的）';
  if (r.status === 0) return '❌ 连不上';
  return `⚠️ HTTP ${r.status}`;
};

console.log(`key: ${mask(key)}   model: ${MODEL}\n`);

for (const { host, note } of HOSTS) {
  const r = await post(host, { model: MODEL, prompt: '', size: '1K' });
  console.log(`${host}  (${note})`);
  console.log(`  → ${verdict(r)}  [HTTP ${r.status}]`);
  console.log(`  ${r.text.replace(/\s+/g, ' ').slice(0, 200)}\n`);
}
