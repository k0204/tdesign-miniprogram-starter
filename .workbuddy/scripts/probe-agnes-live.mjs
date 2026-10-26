/**
 * 用 token plan 那把 key 真实出一次图，判断「队列满」到底跟 key 有没有关系。
 *
 *   node .workbuddy/scripts/probe-agnes-live.mjs
 *
 * 成本：1 张图（1K）。只跑一次，不做重试——重试会把「对方拒了我几次」这个信号抹平。
 *
 * 判定：
 *   200 + 有图     → 这把 key 正常出图，云函数用的那把 key 有问题（等级/plan 不同）
 *   503 queue full → 与 key 无关，是 apihub 侧的共享队列真满了
 *   401/403        → key 失效
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'docs/prompt-tool/config.local.json'), 'utf8'));
const key = cfg.api_key;
const HOST = 'apihub.agnes-ai.com';
const MODEL = 'agnes-image-2.5-flash';

const body = {
  model: MODEL,
  prompt: '一位女性站在窗边，自然柔光，中性色温，暖调胶片质感，半身构图',
  size: '1K',
};

const payload = JSON.stringify(body);
const startedAt = Date.now();

const req = https.request(
  {
    hostname: HOST,
    path: '/v1/images/generations',
    method: 'POST',
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
    res.on('end', () => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const first = (() => {
        try {
          const j = JSON.parse(text);
          return (j.data && j.data[0]) || null;
        } catch (err) {
          return null;
        }
      })();

      const hasImage = Boolean(first && (first.b64_json || first.url));
      let verdict;
      if (res.statusCode === 200 && hasImage) verdict = '✅ 正常出图（这把 key 没排队）';
      else if (res.statusCode === 401 || res.statusCode === 403) verdict = '❌ key 无效';
      else if (res.statusCode === 429 || /queue is full/i.test(text)) verdict = '⚠️ 同样撞队列满（与 key 无关）';
      else verdict = `⚠️ HTTP ${res.statusCode}`;

      console.log(`key: ${key.slice(0, 8)}…(${key.length})   host: ${HOST}`);
      console.log(`${verdict}   耗时 ${elapsed}s   [HTTP ${res.statusCode}]`);
      if (hasImage) {
        console.log(`图: ${first.url ? String(first.url).slice(0, 120) : 'b64_json 已返回'}`);
      } else {
        console.log(`响应: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    });
  },
);

req.setTimeout(150000, () => req.destroy(new Error('本地 150s 超时')));
req.on('error', (err) => {
  console.log(`❌ 请求失败: ${err.message}`);
  process.exitCode = 1;
});
req.write(payload);
req.end();
