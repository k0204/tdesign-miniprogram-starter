#!/usr/bin/env python3
"""探活 Agnes key：一次最小请求，只验证 200 与响应结构。"""
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CFG = json.loads((Path(__file__).parent / 'config.local.json').read_text(encoding='utf-8'))
PROMPT = 'a red apple on a wooden table, natural window light, photorealistic'
BODY = {
    'model': CFG['model'],
    'prompt': PROMPT,
    'size': '1K',
    'ratio': '1:1',
    'extra_body': {'response_format': 'b64_json'},
}

req = urllib.request.Request(
    CFG['endpoint'],
    data=json.dumps(BODY).encode(),
    headers={'Authorization': f"Bearer {CFG['api_key']}", 'Content-Type': 'application/json'},
    method='POST',
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read().decode()
        elapsed = time.time() - t0
        data = json.loads(raw)
        item = (data.get('data') or [{}])[0]
        b64 = item.get('b64_json')
        print(f'HTTP 200  elapsed={elapsed:.1f}s')
        print('响应 keys:', list(data.keys()))
        print('data[0] keys:', list(item.keys()))
        if b64:
            out = Path(__file__).parent / 'output' / '_probe.png'
            out.write_bytes(base64.b64decode(b64))
            print(f'b64 长度={len(b64)}  已存 {out}  文件 {out.stat().st_size//1024} KB')
        else:
            print('无 b64，url =', item.get('url'))
        usage = data.get('usage')
        if usage:
            print('usage:', usage)
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f'HTTP {e.code}  elapsed={time.time()-t0:.1f}s')
    print(body[:600])
    sys.exit(1)
except Exception as e:
    print(f'{type(e).__name__}: {e}  elapsed={time.time()-t0:.1f}s')
    sys.exit(1)
