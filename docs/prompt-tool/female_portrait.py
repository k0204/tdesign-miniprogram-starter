#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""女性拍照优化 · 提示词分类整理

为什么单独做一版：
全库 2253 条是「摄影参考图分析」，混合了风景、街拍、家庭、儿童、老人。
女性用户上传自己的照片要优化，关心的只有一件事：**我这张怎么变好看**。
所以这里从全库筛出女性单人，并按「优化动作」重新分类，而不是按原来的摄影题材分。

分类是两层，不是一层：

  第一层 优化方向 —— 用户想要的结果（清透 / 暖调 / 暗调 / 黑白 …）
                     决定整张图的影调落点，对应修图页面的效果选项。
  第二层 画面问题 —— 这张照片现在有什么硬伤（逆光 / 硬光 / 顶光 / 暗光 / 偏色 …）
                     决定第一步要救什么。同一张脸，逆光和柔光该做的事完全不同。

两层分开的必要性：
  只有「优化方向」会得出「日系=加青加绿」这种死规则；
  叠加「画面问题」才知道，逆光照片走日系要先把脸提亮，否则只会更黑。
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = HERE / 'library'
OUT = LIB / 'female'
OUT.mkdir(exist_ok=True)

# ------------------------------------------------------------
# 筛选：女性 + 人像 + 单人，剔除儿童 / 老人 / 家庭 / 情侣
# ------------------------------------------------------------
EXCLUDE_GENRE = {'children', 'elderly', 'family', 'couple', 'aerial'}
EXCLUDE_AGE = {'child', 'baby', 'senior'}

# ------------------------------------------------------------
# 第一层：优化方向
# 判定顺序即优先级，先命中先归类（黑白优先于暗调，暗调优先于暖调）
# ------------------------------------------------------------
DIRECTION_RULES = [
    ('mono_art', '黑白质感', lambda r: r.get('tone') == 'mono' or r.get('grade') == 'mono'),
    ('dark_mood', '暗调情绪', lambda r: r.get('grade') == 'dark'),
    ('hk_retro', '港风复古', lambda r: r.get('grade') == 'tinted'),
    ('warm_film', '暖调胶片', lambda r: r.get('tone') == 'warm' and r.get('grade') == 'film'),
    ('low_sat', '低饱和清冷', lambda r: r.get('tone') == 'low_sat'),
    ('cool_cine', '冷调高级', lambda r: r.get('tone') == 'cool'),
    ('vivid', '浓郁出片', lambda r: r.get('tone') == 'high_sat'),
    ('clean_natural', '自然清透', lambda r: r.get('grade') == 'clean'),
]

# name, 优化动作, 适用照片, 可直接执行的修图指令
DIRECTION_DESC = {
    'clean_natural': (
        '自然清透',
        '不改风格，只把照片修干净：去灰、正白平衡、提通透、保皮肤质感',
        '照片本身没大问题，只是看着「闷」「脏」「不够透」',
        '校正白平衡去除偏色，提亮中间调打开暗部，去除灰雾提升通透度，'
        '高光收敛不过曝，阴影保留细节不死黑，肤色自然均匀并保留毛孔与细纹，'
        '不做磨皮不做锐化过度，整体轻微提饱和但保持真实',
    ),
    'warm_film': (
        '暖调胶片',
        '暖黄基调 + 细腻颗粒 + 低对比，柔和不做作',
        '光线偏柔、肤色偏暖、想做出「不像修过」的胶片感',
        '整体转为暖黄基调，高光柔化滚降，阴影微微抬起保留细节，降低整体对比让画面松弛，'
        '加入细腻均匀的胶片颗粒，肤色偏暖但保留血色与真实纹理，颜色柔和克制不套厚滤镜',
    ),
    'low_sat': (
        '低饱和清冷',
        '降饱和、压高光、留一点冷灰，安静不寡淡',
        '画面颜色太杂、太艳，想收一收但不想变黑白',
        '整体饱和度降低约两成，肤色单独保护不跟着变灰，压住高光留一点冷灰，'
        '阴影通透不死黑，颜色克制但层次完整，画面安静不寡淡',
    ),
    'hk_retro': (
        '港风复古',
        '暖黄褪色 + 轻偏色 + 暗部压深，有年代感',
        '室内或夜景、想要「老香港」那种浓一点的氛围',
        '做暖黄偏色，暗部压深并带一点绿，高光轻微褪色发旧，加粗一些的胶片颗粒，'
        '对比适中偏强，肤色暖而不过分修饰，做出年代感但不糊不脏',
    ),
    'dark_mood': (
        '暗调情绪',
        '压暗背景、留亮主体、阴影厚重，画面有故事',
        '背景杂物多、想让人只看脸；或本身就想做情绪片',
        '压暗背景与画面边缘，只保留面部和主体受光区明亮，阴影厚重但保留层次，'
        '高光收敛，中间调压低，整体低调不脏，肤色不被压灰',
    ),
    'cool_cine': (
        '冷调高级',
        '冷青基调 + 低饱和 + 干净高光，克制的电影感',
        '想摆脱甜腻、要「高级感」「清冷感」',
        '整体转冷青基调，降低饱和度，高光干净不发灰，黑位扎实，'
        '肤色保持自然不被染青，中间调细腻，避免夸张青橙和重滤镜感',
    ),
    'mono_art': (
        '黑白质感',
        '去色后靠灰阶和光影立住，质感优先于好看',
        '画面结构强、光影有层次，颜色反而是干扰',
        '移除色彩并建立丰富自然的灰阶，突出原有光线结构与材质层次，'
        '黑位扎实但不死黑，高光保留层次不过曝，加入极轻微的写实颗粒',
    ),
    'vivid': (
        '浓郁出片',
        '提饱和、加对比，颜色饱满有记忆点',
        '旅拍、古风、花丛等本身色彩丰富的场景',
        '提升整体饱和与对比，颜色饱满有记忆点，高光严格不过曝，'
        '肤色单独保护不随整体变艳，暗部保留细节不糊成色块',
    ),
}

# ------------------------------------------------------------
# 第二层：画面问题
#
# 只保留「能从数据判定、且真的是问题」的项。
# 第一版试过 background=detailed → 「环境杂乱」79.5%、
# dof=deep → 「景深过深」98.8%，这两个都是标注的默认值（A 库 97% 标大景深），
# 等于说所有人都有病，没有诊断价值，已删除。
#
# 留下的是光位/光质相关的五项：它们分布合理，且每项对应完全不同的修法。
# 偏色改成「色温与色调互相矛盾」才判，暖色调本身不是偏色。
# ------------------------------------------------------------
ISSUE_RULES = [
    ('backlight', '逆光欠曝', '面部整体偏暗、背景过曝。先救脸再谈风格，否则任何滤镜都只会让脸更黑。',
     lambda r: r.get('lightDir') == 'back'),
    ('hard_light', '硬光阴阳脸', '一侧过曝一侧死黑、亮暗交界生硬。先压高光提阴影，把过渡做软。',
     lambda r: r.get('lightQuality') == 'hard'),
    ('top_light', '顶光眼窝阴影', '额头鼻梁过亮、眼窝和法令纹压暗。要单独提亮面中，不是整体提亮。',
     lambda r: r.get('lightDir') == 'top'),
    ('flat_light', '平光无层次', '光太平、脸像贴纸。要靠轮廓光和中间调找回立体，不能只加对比。',
     lambda r: r.get('lightDir') == 'front' and r.get('lightQuality') == 'soft'),
    ('bottom_light', '底光怪异', '下巴和鼻底过亮，五官比例被拉歪。属于必须修的结构问题。',
     lambda r: r.get('lightDir') == 'bottom'),
]

# 这四项属于「必须先修」的硬伤，修不好再谈风格也是白搭
RESCUE_ISSUES = {'backlight', 'hard_light', 'top_light', 'bottom_light'}

ISSUE_PRIORITY = [k for k, *_ in ISSUE_RULES]

# ------------------------------------------------------------
# 场景：决定优化时要不要动环境色
# ------------------------------------------------------------
SCENE_GROUP = {
    'indoor': '室内', 'studio_wall': '影棚纯色', 'street': '城市街拍', 'urban': '城市建筑',
    'nature_green': '绿植户外', 'water': '水边', 'mountain': '山野', 'snow': '雪地',
    'garden': '园林庭院', 'night': '夜景', 'outdoor': '户外', 'mirror': '镜面',
    'aerial_land': '高空', 'rain': '雨天', 'dusk_outdoor': '黄昏', 'generic': '场景未指定',
}


def classify(r):
    direction = None
    for key, _, test in DIRECTION_RULES:
        if test(r):
            direction = key
            break
    if direction is None:
        direction = 'clean_natural'   # 兜底：其余归入自然清透

    issues = [k for k, _, _, test in ISSUE_RULES if test(r)]
    issues.sort(key=lambda k: ISSUE_PRIORITY.index(k))
    return direction, issues


def main():
    recs = [json.loads(line) for line in
            (LIB / 'prompts.jsonl').read_text(encoding='utf-8').splitlines() if line]

    picked = []
    for r in recs:
        if r.get('gender') != 'female':
            continue
        if r.get('category') != 'portrait':
            continue
        if r.get('people') != 'single':
            continue
        if r.get('subjectGenre') in EXCLUDE_GENRE:
            continue
        if r.get('age') in EXCLUDE_AGE:
            continue
        direction, issues = classify(r)
        row = dict(r)
        row['direction'] = direction
        row['directionName'] = DIRECTION_DESC[direction][0]
        row['issues'] = issues
        row['sceneGroup'] = SCENE_GROUP.get(r.get('scene'), r.get('scene'))
        picked.append(row)

    with open(OUT / 'records.jsonl', 'w', encoding='utf-8', newline='\n') as f:
        for row in picked:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')

    # ---------- 汇总 ----------
    total = len(picked)
    by_dir = defaultdict(list)
    for row in picked:
        by_dir[row['direction']].append(row)

    summary = {
        'total': total,
        'source': len(recs),
        'filter': {
            'gender': 'female', 'category': 'portrait', 'people': 'single',
            'excludeGenre': sorted(EXCLUDE_GENRE), 'excludeAge': sorted(EXCLUDE_AGE),
        },
        'directions': [],
        'issues': [],
    }

    for key, rows in sorted(by_dir.items(), key=lambda kv: -len(kv[1])):
        name, action, fit, instruction = DIRECTION_DESC[key]
        issue_counter = Counter(i for r in rows for i in r['issues'])
        scene_counter = Counter(r['sceneGroup'] for r in rows)
        shot_counter = Counter(r['shot'] for r in rows)
        rescue = sum(1 for r in rows if RESCUE_ISSUES & set(r['issues']))
        summary['directions'].append({
            'id': key,
            'name': name,
            'count': len(rows),
            'share': round(len(rows) / total * 100, 1),
            'action': action,
            'fit': fit,
            'instruction': instruction,
            'needRescue': rescue,
            'rescueShare': round(rescue / len(rows) * 100, 1),
            'topIssues': [{'id': i, 'count': n} for i, n in issue_counter.most_common(5)],
            'scenes': [{'name': s, 'count': n} for s, n in scene_counter.most_common(6)],
            'shots': dict(shot_counter),
            'exampleFiles': [r['file'].split('/')[-1] for r in rows[:3]],
            # 该方向在库里的真实提示词，作为 few-shot 参考
            'samples': [r['prompt'] for r in rows[:3]],
        })

    for key, name, note, _ in ISSUE_RULES:
        hits = [r for r in picked if key in r['issues']]
        summary['issues'].append({
            'id': key, 'name': name, 'count': len(hits),
            'share': round(len(hits) / total * 100, 1), 'note': note,
        })

    (OUT / 'categories.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8'
    )

    # 每个方向一份纯提示词
    for key, rows in by_dir.items():
        with open(OUT / f'{key}.txt', 'w', encoding='utf-8', newline='\n') as f:
            for r in rows:
                f.write(r['prompt'] + '\n')

    # 全局
    with open(OUT / 'prompts.txt', 'w', encoding='utf-8', newline='\n') as f:
        for r in picked:
            f.write(r['prompt'] + '\n')

    print(f'女性单人（拍照优化向）: {total} / {len(recs)}\n')
    print(f'{"优化方向":12s} {"条数":>5s} {"占比":>6s} {"需先救片":>8s}  前三类画面问题')
    for d in summary['directions']:
        top = '、'.join(f"{next(x['name'] for x in summary['issues'] if x['id'] == i['id'])}({i['count']})"
                       for i in d['topIssues'][:3])
        print(f'{d["name"]:12s} {d["count"]:5d} {d["share"]:5.1f}% {d["rescueShare"]:7.1f}%  {top}')
    print()
    print(f'{"画面问题":12s} {"条数":>5s} {"占比":>6s}')
    for i in summary['issues']:
        print(f'{i["name"]:12s} {i["count"]:5d} {i["share"]:5.1f}%')
    print()
    no_issue = sum(1 for r in picked if not r['issues'])
    print(f'无任何画面问题（可直接套风格）: {no_issue} ({no_issue/total*100:.1f}%)')


if __name__ == '__main__':
    main()
