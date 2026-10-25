#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从归一化记录里提取「提示词组合库」。

思路：一条提示词不是一整句话，是五个包的拼接。
  [镜头包] + [场景包] + [人物包] + [风格包] + [叙事包]

其中风格/镜头/场景/叙事四包有统计依据（同现频次高 = 稳定配方），
所以给「预设」；人物包是内容槽，用户要自由换，所以给「词表」。

预设的算法：
  1. 按包的主维分组（风格包按影调、镜头包按景别、场景包按环境）
  2. 组内其余维度取众数，作为该组的典型搭配
  3. 组内记录数 = 这个配方的出现次数，占比过低的不算配方（长尾噪声）

渲染文本取「该归一值出现最多的原始短语」，不手写，保证和原库措辞一致。

输出：
  library/packs.json   组合库（结构化）
  library/render_map.json  归一值 -> 中文短语
"""

import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent
LIB = HERE / 'library'

# 包定义：(id, 中文名, 用途, 主维, 副维, 渲染顺序)
PACKS = [
    (
        'style', '风格包', '决定这张图拍成什么样',
        ['styleKey'],
        ['lightDir', 'lightQuality', 'colorTemp', 'mood'],
        ['lightDir', 'lightQuality', 'colorTemp', 'styleKey', 'mood'],
    ),
    (
        # 焦段(lens)被剔除：交叉检验显示 A 库 207 条「面部特写」里 194 条焦段标成「广角」，
        # 摄影上不成立（广角拍特写会透视畸变），说明该字段与景别不联动，不可信。
        'lens', '镜头包', '决定怎么取景、站多高',
        ['shot'],
        ['angle', 'dof', 'composition', 'frame'],
        ['shot', 'angle', 'dof', 'composition', 'frame'],
    ),
    (
        'scene', '场景包', '决定在哪拍、什么季节天气、有没有前景',
        ['scene'],
        ['weather', 'foreground', 'background'],
        ['scene', 'weather', 'foreground', 'background'],
    ),
    (
        'story', '叙事包', '决定这张图在讲什么',
        ['narrative'],
        ['mood'],
        ['narrative', 'mood'],
    ),
]

# 人物包不做预设，给词表：内容槽本来就要用户自己换
SUBJECT_DIMS = ['gender', 'age', 'people', 'pose', 'expression', 'gaze', 'styling', 'outfit', 'prop']

# 字段 -> 原始 CSV 列名（用来统计渲染文本）
FIELD_TO_COLUMN = {
    'scene': '环境',
    'background': '背景处理',
    'foreground': '前景遮挡',
    'pose': '姿势',
    'expression': '表情',
    'gaze': '视线',
    'styling': '造型',
    'outfit': '服装',
    'prop': '道具',
    'shot': '景别',
    'angle': '机位',
    'dof': '景深',
    'composition': '构图手法',
    'frame': '画幅',
    'lens': '焦段',
    'lightDir': '光线方向',
    'lightQuality': '光线性质',
    'colorTemp': '色温',
    'tone': '色调',
    'grade': '后期质感',
    'mood': '情绪',
    'narrative': '叙事氛围',
    'weather': '天气时间',
    'motion': '动态',
}

DIM_NAMES = {
    'styleKey': '影调', 'lightDir': '光位', 'lightQuality': '光质', 'colorTemp': '色温',
    'tone': '色调', 'grade': '后期', 'mood': '情绪', 'shot': '景别', 'angle': '机位',
    'lens': '焦段', 'dof': '景深', 'composition': '构图', 'frame': '画幅',
    'scene': '环境', 'weather': '天气时间', 'foreground': '前景', 'background': '背景',
    'gender': '性别', 'age': '年龄', 'people': '人数', 'pose': '姿势',
    'expression': '表情', 'gaze': '视线', 'styling': '造型', 'outfit': '服装',
    'prop': '道具', 'narrative': '叙事',
}

VALUE_NAMES = {
    'shot': {'wide': '远景', 'full': '全景', 'medium': '中景',
             'medium_close': '近景', 'closeup': '特写'},
    'angle': {'eye_level': '平视', 'high': '俯拍', 'low': '仰拍',
              'aerial': '航拍', 'selfie': '自拍视角', 'phone': '手机视角'},
    'gender': {'female': '女性', 'male': '男性', 'mixed': '混合', 'unspecified': '未指定'},
    'age': {'baby': '婴儿', 'child': '儿童', 'teen': '少年', 'young': '青年',
            'middle': '中年', 'senior': '老年'},
    'people': {'single': '单人', 'two': '双人', 'group': '群体'},
    'styleKey': {
        'warm_film': '暖调胶片', 'clean_natural': '自然通透', 'low_sat_film': '低饱和胶片',
        'black_white': '黑白', 'dark_neutral': '暗调中性', 'dark_vivid': '暗调浓郁',
        'vivid_film': '浓郁胶片', 'cool_clean': '冷调清透', 'vivid_clean': '高饱和清透',
        'warm_dark': '暖调暗部', 'neutral_film': '中性胶片', 'soft_neutral': '柔和中性',
        'cool_dark': '冷调暗部', 'warm_soft': '暖调柔和', 'low_sat_soft': '低饱和柔和',
        'cool_film': '冷调胶片', 'vivid_soft': '浓郁柔和', 'cool_soft': '冷调柔和',
        'neutral_contrast': '中性高反差',
    },
}


# 副维取众数的门槛：(最低覆盖率, 众数最低占比)
# 覆盖率不足 = 这条维度大多没标；众数占比不足 = 组内本来就分散，硬填会误导。
# 光位单独放宽：它天然分散（6 个方向），但恰恰是风格包最关键的信息。
SECONDARY_THRESHOLD = {
    'lightDir': (0.5, 0.18),
    'lightQuality': (0.5, 0.40),
    'colorTemp': (0.5, 0.35),
    'tone': (0.5, 0.40),
    'grade': (0.5, 0.40),
    'mood': (0.5, 0.30),
    'angle': (0.5, 0.60),
    'lens': (0.5, 0.30),
    'dof': (0.5, 0.60),
    'composition': (0.5, 0.40),
    'frame': (0.5, 0.40),
    'weather': (0.5, 0.40),
    'foreground': (0.5, 0.60),
    'background': (0.5, 0.50),
}
DEFAULT_THRESHOLD = (0.5, 0.40)

# 这些值表示「没有信息」，不能当配方用
DROP_VALUES = {'generic'}


def pick_secondary(rows, dim):
    """副维取众数，但过了门槛才填。返回 None 表示这一维在该组里没有稳定倾向。"""
    min_cover, min_share = SECONDARY_THRESHOLD.get(dim, DEFAULT_THRESHOLD)
    vals = [r.get(dim) for r in rows if r.get(dim)]
    if len(vals) < len(rows) * min_cover:
        return None
    top, n = Counter(vals).most_common(1)[0]
    if n < len(vals) * min_share:
        return None
    if top in DROP_VALUES:
        return None
    return top


def build_render_map():
    """归一值 -> 最高频的原始短语。不手写，保证和原库措辞一致。

    styleKey 特殊处理：它由 (色调, 后期) 合成，单独查任一侧都会出错。
    比如「低饱和胶片」若只取后期众数会拿到「暖调胶片质感」（这个词本身带"暖"），
    和「中性色调」撞车。所以按 (色调原文 + 后期原文) 的完整组合取众数。
    """
    pairs = defaultdict(lambda: defaultdict(Counter))   # dim -> value -> Counter(rawText)
    style_pairs = defaultdict(Counter)                  # (tone,grade) -> Counter(完整短语)

    def load(name):
        with open(DOCS / name, encoding='utf-8-sig') as f:
            return list(csv.DictReader(f))

    # 复用归一化脚本的规则，避免两处逻辑漂移
    import normalize as N

    rows = load('analysis.csv') + load('images-analysis.csv')
    for r in rows:
        for field, column in FIELD_TO_COLUMN.items():
            raw = (r.get(column) or '').strip()
            if not raw or raw in N.EMPTY:
                continue
            value = N.normalize(field, raw)
            if value is N.NOT_FOUND or value is None:
                continue
            pairs[field][value][raw] += 1

        tone_raw = (r.get('色调') or '').strip()
        grade_raw = (r.get('后期质感') or '').strip()
        tone_v = N.normalize('tone', tone_raw)
        grade_v = N.normalize('grade', grade_raw)
        if tone_v and grade_v and N.NOT_FOUND not in (tone_v, grade_v):
            style_pairs[(tone_v, grade_v)][f'{tone_raw}，{grade_raw}'] += 1

    out = {field: {v: c.most_common(1)[0][0] for v, c in counter.items()}
           for field, counter in pairs.items()}

    # styleKey 的值是 "warm_film" 这种，用 TONE_GRADE 反查不到组合，
    # 所以按 (tone, grade) 建索引，由调用方传 tone/grade 进来查。
    out['__styleByToneGrade'] = {
        f'{t}|{g}': counter.most_common(1)[0][0]
        for (t, g), counter in style_pairs.items()
    }
    return out


def render(render_map, dims, values):
    parts = []
    seen = []
    for dim in dims:
        value = values.get(dim)
        if not value:
            continue
        if dim == 'styleKey':
            combo = f"{values.get('tone')}|{values.get('grade')}"
            text = render_map.get('__styleByToneGrade', {}).get(combo)
        else:
            text = render_map.get(dim, {}).get(value)
        if not text:
            continue
        # 短语级去重：不同维度的原文常常撞词
        # （「中近景，背景虚化」+「浅景深，背景虚化」、「黄昏时分」+「黄昏」），
        # 按逗号拆开逐个比对，比整句比对彻底。
        for piece in text.split('，'):
            piece = piece.strip()
            if not piece or piece in seen:
                continue
            seen.append(piece)
            parts.append(piece)
    return '，'.join(parts)


STYLE_KEY_TO_TONE_GRADE = {}


def main():
    import normalize as N
    STYLE_KEY_TO_TONE_GRADE.update({v[0]: k for k, v in N.TONE_GRADE_TO_STYLE.items()})

    records = [json.loads(line) for line in (LIB / 'prompts.jsonl').read_text(encoding='utf-8').splitlines() if line]
    render_map = build_render_map()
    total = len(records)

    packs_out = {}
    for pack_id, name, desc, primary, secondary, order in PACKS:
        groups = defaultdict(list)
        for r in records:
            key = tuple(r.get(p) for p in primary)
            if all(k for k in key):
                groups[key].append(r)

        presets = []
        for key, rows in groups.items():
            if len(rows) < 12:      # 少于 12 条不算配方，只是长尾
                continue
            if any(k in DROP_VALUES for k in key):   # generic 组没有配方意义
                continue

            values = dict(zip(primary, key))

            # 风格包由影调反查出 tone/grade，渲染时才拼得对
            if pack_id == 'style':
                tone_grade = STYLE_KEY_TO_TONE_GRADE.get(key[0])
                if tone_grade:
                    values['tone'], values['grade'] = tone_grade

            for dim in secondary:
                picked = pick_secondary(rows, dim)
                if picked:
                    values[dim] = picked
                elif dim == 'tone':
                    values.setdefault(dim, None)

            label = (VALUE_NAMES.get(primary[0], {}).get(key[0])
                     or render_map.get(primary[0], {}).get(key[0])
                     or str(key[0]))
            presets.append({
                'label': label,
                'count': len(rows),
                'share': round(len(rows) / total * 100, 1),
                'values': values,
                'phrase': render(render_map, order, values),
                'example': rows[0]['file'].split('/')[-1],
            })

        presets.sort(key=lambda x: -x['count'])
        for i, p in enumerate(presets, 1):
            p['id'] = f'{pack_id}-{i:02d}'

        packs_out[pack_id] = {
            'name': name,
            'desc': desc,
            'primary': primary,
            'dims': primary + secondary,
            'presets': presets,
        }

    # 人物包：词表
    subject_options = {}
    for dim in SUBJECT_DIMS:
        counter = Counter(r.get(dim) for r in records if r.get(dim))
        if not counter:
            continue
        subject_options[dim] = {
            'name': DIM_NAMES.get(dim, dim),
            'options': [
                {
                    'value': v,
                    'label': VALUE_NAMES.get(dim, {}).get(v, v),
                    'count': n,
                    'render': render_map.get(dim, {}).get(v, ''),
                }
                for v, n in counter.most_common()
            ],
        }

    out = {
        'version': '1.0',
        'generatedAt': '2026-10-25',
        'total': total,
        'packs': packs_out,
        'subjectOptions': subject_options,
        'recipe': {
            'order': ['lens', 'scene', 'subject', 'style', 'story'],
            'skeleton': '【景别+机位+焦段+景深+构图+画幅】+【环境+天气+前景】+【主体+造型+服装+姿势+表情+视线+道具】+【光位+光质+色温+色调+后期+情绪】+【叙事】',
            'note': '前 20 个字决定构图，景别与机位要最先说；情绪放最后，给 1-2 个词的落点。',
        },
    }

    (LIB / 'packs.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    (LIB / 'render_map.json').write_text(
        json.dumps(render_map, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8'
    )

    print(f'记录 {total} 条\n')
    for pack_id, pack in packs_out.items():
        print(f'[{pack["name"]}] {len(pack["presets"])} 个预设')
        for p in pack['presets'][:4]:
            print(f'    {p["id"]} {p["label"]:6s} {p["count"]:4d} ({p["share"]:4.1f}%)  {p["phrase"][:52]}')
        print()
    print('[人物包] 词表:', {k: len(v['options']) for k, v in subject_options.items()})


if __name__ == '__main__':
    main()
