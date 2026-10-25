#!/usr/bin/env python3
"""从两份分析 CSV 提取提示词列表。

输出三份：
  data/prompts.txt    纯文本，一行一条，可直接复制去生成
  data/prompts.jsonl  带元数据，供本地工具读取
  data/summary.json   统计摘要

去重策略：提示词文本完全相同的合并成一条，dup 记重复次数。
不删任何来源信息，只合并同一个提示词。
"""

import csv
import json
import re
from collections import OrderedDict
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent

RATIO_MAP = {'横幅构图': '3:2', '竖幅构图': '2:3', '方形构图': '1:1'}

# A 库「风格」实际是题材，B 库「原分组」是流派分组，两者都收进 group/genre
def load(path, kind):
    with open(path, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def norm(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


def build_a(rows):
    for r in rows:
        yield {
            'lib': 'A',
            'src': 'analysis',
            'file': norm(r.get('文件名')),
            'group': norm(r.get('分组')),
            'genre': norm(r.get('风格')),
            'shot': norm(r.get('景别')),
            'light': ' '.join(x for x in (norm(r.get('光线方向')), norm(r.get('光线性质'))) if x),
            'tone': norm(r.get('色调')),
            'ratio': RATIO_MAP.get(norm(r.get('画幅')), '1:1'),
            'prompt': norm(r.get('中文提示词')),
        }


def build_b(rows):
    for r in rows:
        yield {
            'lib': 'B',
            'src': 'images-analysis',
            'file': norm(r.get('文件')),
            'group': norm(r.get('原分组')),
            'genre': norm(r.get('类别')),
            'shot': norm(r.get('景别')),
            'light': ' '.join(x for x in (norm(r.get('光线方向')), norm(r.get('光线性质'))) if x),
            'tone': norm(r.get('色调')),
            'ratio': RATIO_MAP.get(norm(r.get('画幅')), '3:2'),
            'prompt': norm(r.get('中文提示词')),
        }


def main():
    items = list(build_a(load(DOCS / 'analysis.csv', 'A')))
    items += list(build_b(load(DOCS / 'images-analysis.csv', 'B')))

    seen = OrderedDict()
    dropped_empty = 0
    for it in items:
        p = it['prompt']
        if len(p) < 20:
            dropped_empty += 1
            continue
        if p in seen:
            seen[p]['dup'] += 1
            seen[p]['dupFrom'].append(it['file'])
            continue
        it['dup'] = 1
        it['dupFrom'] = []
        seen[p] = it

    records = []
    for i, (prompt, it) in enumerate(seen.items(), 1):
        it['id'] = f'{i:04d}'
        it['code'] = f'P{i:04d}'
        it['chars'] = len(prompt)
        records.append(it)

    with open(OUT / 'data' / 'prompts.jsonl', 'w', encoding='utf-8', newline='\n') as f:
        for it in records:
            f.write(json.dumps(it, ensure_ascii=False) + '\n')

    with open(OUT / 'data' / 'prompts.txt', 'w', encoding='utf-8', newline='\n') as f:
        for it in records:
            f.write(it['prompt'] + '\n')

    from collections import Counter
    summary = {
        'total': len(records),
        'raw': len(items),
        'merged': len(items) - len(records) - dropped_empty,
        'droppedEmpty': dropped_empty,
        'byLib': dict(Counter(it['lib'] for it in records)),
        'byRatio': dict(Counter(it['ratio'] for it in records)),
        'byGroup': dict(Counter(it['group'] for it in records).most_common()),
        'chars': {
            'min': min(it['chars'] for it in records),
            'max': max(it['chars'] for it in records),
            'avg': round(sum(it['chars'] for it in records) / len(records), 1),
        },
    }
    with open(OUT / 'data' / 'summary.json', 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
