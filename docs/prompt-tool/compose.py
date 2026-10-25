#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把组合库拼成可直接使用的提示词。

组合库本身是「零件」（4 包 42 预设 + 人物包 72 值）。本脚本负责拼装，
并批量产出三组现成组合，省掉手动拼的麻烦：

  1. 单包变体  —— 固定其余为中位选择，遍历某一包的每个预设
                  用途：只换风格 / 只换场景 / 只换镜头，看清每个预设的差别
  2. 经典组合  —— Top3 风格 × Top3 镜头 × Top3 场景
                  用途：直接拿去出图，覆盖最主流的三类成片
  3. 姿态变体  —— 固定风格+镜头+场景，遍历人物包的姿势
                  用途：同一套调子下拍一组不同动作

输出：
  library/combos.txt    一行一条，可直接投喂文生图
  library/combos.jsonl  带标签与来源，供程序使用
"""

import json
from itertools import product
from pathlib import Path

LIB = Path(__file__).resolve().parent / 'library'


def load():
    packs = json.loads((LIB / 'packs.json').read_text(encoding='utf-8'))
    return packs


AGE_WORD = {'baby': '婴儿', 'child': '儿童', 'teen': '少年', 'young': '年轻',
            'middle': '中年', 'senior': '年长'}
GENDER_WORD = {'female': '女性', 'male': '男性', 'mixed': '人物', 'unspecified': '人物'}


def subject_phrase(picks):
    """合成主体短语。

    原库的主体育儿是「一位年轻女性」这种整体写法，归一化时拆成了三维，
    渲染时要拼回去，否则提示词里会缺掉「拍的是谁」，只剩姿势和表情。
    """
    people = picks.get('people') or 'single'
    gender = picks.get('gender')
    age = picks.get('age')

    if people == 'group':
        return '一群人'
    if people == 'two':
        return '一对情侣' if gender == 'mixed' else '两个人'

    word = GENDER_WORD.get(gender or 'unspecified', '人物')
    if word == '人物':
        return '一位人物'
    return f'一位{AGE_WORD.get(age, "")}{word}'


def render_subject(packs, picks):
    """按 主体·造型·服装·姿势·表情·视线 的顺序渲染人物包"""
    opts = packs['subjectOptions']
    parts = [subject_phrase(picks)]
    for dim in ['styling', 'outfit', 'pose', 'expression', 'gaze']:
        value = picks.get(dim)
        if not value:
            continue
        entry = opts.get(dim, {}).get('options', [])
        text = next((o['render'] for o in entry if o['value'] == value), None)
        if text:
            parts.append(text)
    return parts


DEFAULT_SUBJECT = {
    'gender': 'female',
    'people': 'single',
    'pose': 'generic',
    'expression': 'calm',
    'gaze': 'generic',
    'styling': 'natural',
}


def compose(packs, style_id, lens_id, scene_id, story_id, subject=None):
    subject = subject or DEFAULT_SUBJECT
    by_id = {}
    for pack in packs['packs'].values():
        for preset in pack['presets']:
            by_id[preset['id']] = preset

    parts = []
    for pid in (lens_id, scene_id):
        preset = by_id.get(pid)
        if preset:
            parts.append(preset['phrase'])
    parts.extend(render_subject(packs, subject))
    preset = by_id.get(style_id)
    if preset:
        parts.append(preset['phrase'])
    preset = by_id.get(story_id)
    if preset:
        parts.append(preset['phrase'])

    # 短语之间可能重复（跨包撞词），再过滤一次
    deduped = []
    for part in parts:
        if any(part in p or p in part for p in deduped):
            continue
        deduped.append(part)
    return '，'.join(deduped)


def main():
    packs = load()
    presets = packs['packs']

    styles = presets['style']['presets']
    lenses = presets['lens']['presets']
    scenes = presets['scene']['presets']
    stories = presets['story']['presets']

    rows = []

    # 中位选择：各包取占比最高的那个
    base = {
        'style': styles[0]['id'],
        'lens': lenses[0]['id'],
        'scene': scenes[0]['id'],
        'story': stories[0]['id'],
    }

    # 1. 单包变体
    for pack_key, group in (('style', styles), ('lens', lenses), ('scene', scenes), ('story', stories)):
        for preset in group:
            kwargs = dict(base)
            kwargs[pack_key] = preset['id']
            rows.append({
                'tag': f'{group[0]["id"].split("-")[0]}-var-{preset["id"]}',
                'group': '单包变体',
                'change': f'{packs["packs"][pack_key]["name"]} → {preset["label"]}',
                'packs': kwargs,
                'prompt': compose(packs, kwargs['style'], kwargs['lens'], kwargs['scene'], kwargs['story']),
            })

    # 2. 经典组合：Top3 × Top3 × Top3
    for s, l, sc in product(styles[:3], lenses[:3], scenes[:3]):
        kwargs = {'style': s['id'], 'lens': l['id'], 'scene': sc['id'], 'story': stories[0]['id']}
        rows.append({
            'tag': f'classic-{s["id"]}-{l["id"]}-{sc["id"]}',
            'group': '经典组合',
            'change': f'{s["label"]} / {l["label"]} / {sc["label"]}',
            'packs': kwargs,
            'prompt': compose(packs, s['id'], l['id'], sc['id'], stories[0]['id']),
        })

    # 3. 姿态变体：遍历人物包的姿势
    poses = packs['subjectOptions'].get('pose', {}).get('options', [])
    for pose in poses:
        if pose['value'] == 'generic':
            continue
        subject = dict(DEFAULT_SUBJECT)
        subject['pose'] = pose['value']
        rows.append({
            'tag': f'pose-{pose["value"]}',
            'group': '姿态变体',
            'change': f'姿势 → {pose["render"]}',
            'packs': dict(base),
            'prompt': compose(packs, base['style'], base['lens'], base['scene'], base['story'], subject),
        })

    # 去重（同一句不重复出现）
    seen = set()
    unique = []
    for row in rows:
        if row['prompt'] in seen:
            continue
        seen.add(row['prompt'])
        unique.append(row)

    with open(LIB / 'combos.jsonl', 'w', encoding='utf-8', newline='\n') as f:
        for row in unique:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')

    with open(LIB / 'combos.txt', 'w', encoding='utf-8', newline='\n') as f:
        for row in unique:
            f.write(row['prompt'] + '\n')

    print(f'共 {len(unique)} 条（去重前 {len(rows)}）\n')
    for group in ('单包变体', '经典组合', '姿态变体'):
        subset = [r for r in unique if r['group'] == group]
        print(f'[{group}] {len(subset)} 条')
        for row in subset[:2]:
            print(f'    {row["change"]}')
            print(f'    {row["prompt"][:100]}…')
        print()


if __name__ == '__main__':
    main()
