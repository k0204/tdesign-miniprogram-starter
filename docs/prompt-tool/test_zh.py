#!/usr/bin/env python3
"""用列表里的真实中文提示词测一次，确认中文可直接生成。"""
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
CFG = json.loads((HERE / 'config.local.json').read_text(encoding='utf-8'))

code = sys.argv[1] if len(sys.argv) > 1 else 'P0001'
rec = None
for line in (HERE / 'data' / 'prompts.jsonl').read_text(encoding='utf-8').splitlines():
    it = json.loads(line)
    if it['code'] == code:
        rec = it
        break
if not rec:
    sys.exit(f'找不到 {code}')

print(f"{rec['code']}  ratio={rec['ratio']}  chars={rec['chars']}  group={rec['group']}")
print(f"prompt: {rec['prompt'][:80]}...")

body = {
    'model': CFG['model'],
    'prompt': rec['prompt'],
    'size': '1K',
    'ratio': rec['ratio'],
    'extra_body': {'response_format': 'b64_json'},
}
req = urllib.request.Request(
    CFG['endpoint'],
    data=json.dumps(body).encode(),
    headers={'Authorization': f"Bearer {CFG['api_key']}", 'Content-Type': 'application/json'},
    method='POST',
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=240) as r:
        data = json.loads(r.read().decode())
        el = time.time() - t0
        item = (data.get('data') or [{}])[0]
        b64 = item.get('b64_json')
        print(f'HTTP 200  elapsed={el:.1f}s')
        rp = item.get('revised_prompt')
        if rp:
            print(f'revised_prompt: {rp[:200]}')
        if b64:
            out = HERE / 'output' / f'{code}_zh.png'
            out.write_bytes(base64.b64decode(b64))
            print(f'已存 {out}  {out.stat().st_size//1024} KB')
except urllib.error.HTTPError as e:
    print(f'HTTP {e.code}: {e.read().decode()[:500]}')
    sys.exit(1)
