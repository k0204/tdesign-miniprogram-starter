#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把两库归一化成统一的「组合库」结构。

设计要点（都是被数据逼出来的，不是拍脑袋）：

1. **主体拆成三个正交维**（性别 / 年龄 / 人数）
   A 库主体有 126 个取值，其实是「一位年轻女性」「一位女孩」「一位女性」
   这种同义重复 + 「一位人物，穿着眼镜」这种把造型混进来的脏数据。
   拆成正交维后，126 个值收敛成 3 个维度各自 4-6 个值，且能组合表达。

2. **占位符显式标记为 generic**
   A 库「环境细节丰富的场景中」占 71%、「自然放松的姿态」占 77%、
   「自然视线」占 93%。这些不是真实取值，是标注时的默认填充。
   当成真实值参与统计，会把所有组合都拉向它。所以单独标 generic，
   组合库统计时排除。

3. **景别/构图/画幅/景深分离**
   B 库的 `构图手法` 是「环境人像构图，主体居中，大景深，环境清晰，竖幅构图」
   这种四维粘连的复合串，必须拆开才能跨库比较。

4. **黑白从「光线性质」里挪走**
   B 库有 116 条 `光线性质` = 「黑白光影」。黑白是影调不是光型，
   混在光线里会让「黑白」这个风格包无法被检索到。

输出：
  library/prompts.jsonl   归一化后的 2253 条
  library/vocab.json      全部维度词表 + 频次 + 映射来源
  library/unmapped.json   没被映射规则覆盖的原始值（用于迭代补规则）
"""

import csv
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent
OUT = HERE / 'library'
OUT.mkdir(exist_ok=True)

EMPTY = {'', '—', '-', '无', '无人物'}
SKIP = object()
NOT_FOUND = object()

# ============================================================
# 映射规则
# ============================================================
# 每条规则 (正则, 归一值)。按顺序匹配，先具体后笼统。
# 命中不了的会进 unmapped.json，不猜。

RULES = {
    # ---------- 主体：拆成 性别 / 年龄 / 人数 ----------
    'gender': [
        (r'情侣|夫妻|新郎|新娘|伴侣|双人同框', 'mixed'),
        (r'一家人|家庭|亲子|母婴|父子|母子|父母|母女|父女', 'mixed'),
        (r'一群|人群|路人|朋友们|团队', 'mixed'),
        (r'女性|女孩|母亲|姐姐|妹妹|女士|新娘|孕妇|女模|少女|女童|女子', 'female'),
        (r'男性|男孩|父亲|哥哥|弟弟|先生|新郎|男模|少年|男童|男子', 'male'),
        (r'婴儿|宝宝|幼儿', 'unspecified'),
        (r'人物|模特|舞者|儿童|老人|孩子|个体|人们', 'unspecified'),
    ],
    'age': [
        (r'婴儿|宝宝|幼儿', 'baby'),
        (r'幼年|年幼|儿童|孩子|男孩|女孩|儿童', 'child'),
        (r'少年|青少年|学生', 'teen'),
        (r'年轻|少女|青年', 'young'),
        (r'老人|年长|老年|长者', 'senior'),
        (r'中年', 'middle'),
    ],
    'peopleCount': [
        (r'一群|人群|路人|朋友们|团队|一家人|家庭', 'group'),
        (r'情侣|夫妻|双人|一对|相拥|亲子|母婴|人物与孩子', 'two'),
        (r'一位|单人|一个', 'single'),
    ],

    # ---------- 环境：先判 generic 占位符 ----------
    'scene': [
        (r'^环境细节丰富的场景|^环境细节清晰，信息层次|^生活场景中|^自然环境中|^环境细节', 'generic'),
        (r'影棚|棚拍|纯色|渐变背景|砖墙|水泥墙|墙面前|背景前', 'studio_wall'),
        (r'城市街头|城市街道|街头|街巷|市井|集市|古镇|老城|巷弄|骑楼|电车', 'street'),
        (r'城市建筑|建筑间|楼宇|屋顶|天桥|地铁|车站|车厢|桥', 'urban'),
        (r'山|峰|云海|云雾|高原|雪山|草原|田野|戈壁|沙漠|峡谷', 'mountain'),
        (r'海边|海滩|水岸|湖畔|湖边|河流|溪|泳池|湿地|海面|码头', 'water'),
        (r'森林|树林|竹林|树影|树林|林间|枝叶|花园|花丛|草地|公园', 'nature_green'),
        (r'雪|冬', 'snow'),
        (r'室内|窗边|床边|沙发|家居|厨房|办公室|房间|室内空间|客厅|卧室|室内窗边|咖啡馆|书店|店里', 'indoor'),
        (r'园林|庭院|寺庙|古建|牌坊|回廊|亭|院', 'garden'),
        (r'夜色|夜景|灯光中|霓虹', 'night'),
        (r'镜面|镜子前', 'mirror'),
        (r'雨中|雨天', 'rain'),
        (r'户外', 'outdoor'),
    ],
    'background': [
        (r'环境细节清晰|信息层次丰富', 'detailed'),
        (r'简洁|干净|纯色|渐变', 'clean'),
        (r'虚化|虚|分离', 'blurred'),
        (r'图案化|视觉节奏', 'patterned'),
    ],
    'foreground': [
        (r'无|—', 'none'),
        (r'窗框|门框|框', 'frame'),
        (r'枝叶|植物|花|草', 'foliage'),
        (r'纱|帘|纱帘|薄纱', 'fabric'),
        (r'镜|反射', 'mirror'),
        (r'栏杆|扶手', 'rail'),
    ],
    'weather': [
        (r'^—$', None),
        (r'春', 'spring'),
        (r'夏', 'summer'),
        (r'秋', 'autumn'),
        (r'冬|雪', 'winter'),
        (r'黄昏|日落|夕阳|傍晚', 'dusk'),
        (r'清晨|黎明|早晨|日出', 'dawn'),
        (r'夜晚|夜', 'night'),
        (r'雨', 'rain'),
        (r'雾|霾', 'fog'),
        (r'晴|日光|阳光', 'sunny'),
        (r'阴', 'overcast'),
    ],

    # ---------- 人物动作 ----------
    'pose': [
        (r'自然放松|摆出姿态|自然姿态', 'generic'),
        (r'坐|跪坐|盘腿', 'sitting'),
        (r'站|立', 'standing'),
        (r'行走|步行|漫游|散步|逛街', 'walking'),
        (r'躺|卧', 'lying'),
        (r'倚|靠', 'leaning'),
        (r'奔跑|跑|跃|跳', 'moving'),
        (r'手持|拿着|举|持', 'holding'),
        (r'工作|操作|使用|阅读|弹|演奏|书写|绘画|做', 'working'),
        (r'玩耍|嬉戏|游', 'playing'),
        (r'背对|背影', 'back'),
        (r'侧脸|侧身', 'profile'),
        (r'拥|亲吻|牵手|抱', 'intimate'),
        (r'舞|瑜伽|伸展|运动', 'dancing'),
        (r'仰望|指向|看向', 'gazing_up'),
        (r'游泳|骑', 'sport'),
    ],
    'expression': [
        (r'自然平和|沉静克制|轻松平静|沉静|平静', 'calm'),
        (r'微笑|愉悦|开怀|笑容|笑', 'smiling'),
        (r'冷峻|严肃|沉稳|克制', 'serious'),
        (r'忧郁|沉思|思|哀|悲', 'melancholy'),
        (r'惊讶|惊', 'surprised'),
        (r'自信|坚定', 'confident'),
        (r'温柔|柔和', 'gentle'),
        (r'热切|热烈|兴奋|快乐|活', 'lively'),
    ],
    'gaze': [
        (r'自然视线|自然', 'generic'),
        (r'望向画外|看画外|侧望', 'offframe'),
        (r'直视镜头|看镜头|对视', 'camera'),
        (r'凝视远方|远望|眺望', 'distance'),
        (r'闭眼', 'closed'),
        (r'背对|背影', 'away'),
        (r'侧视|斜视', 'side'),
        (r'低头|垂眼|俯视', 'down'),
    ],
    'styling': [
        (r'自然发型|淡妆|自然妆', 'natural'),
        (r'精致妆容|浓妆|妆', 'glam'),
        (r'眼镜|墨镜|胡须|帽子|纹身|头纱|项链|头巾|耳环|配饰', 'accessory'),
        (r'金发|红发|卷发|短发|长发|盘发|发髻', 'hair_style'),
    ],
    'outfit': [
        (r'^—$', None),
        (r'旗袍', 'qipao'),
        (r'汉服|古装|襦裙|长衫', 'hanfu'),
        (r'婚纱|礼服|礼裙', 'gown'),
        (r'西装|衬衫|西服|正装', 'formal'),
        (r'连衣裙|裙', 'dress'),
        (r'大衣|外套|风衣|夹克|卫衣|毛衣|针织|棉服|羽绒', 'outerwear'),
        (r'牛仔|T恤|休闲|卫衣|运动', 'casual'),
        (r'制服|校服|水手服|JK', 'uniform'),
        (r'泳装|比基尼', 'swimwear'),
        (r'民族|传统|民俗', 'ethnic'),
    ],
    'prop': [
        (r'^—$', None),
        (r'相机|镜头|摄影', 'camera'),
        (r'花|枝|叶|草', 'flower'),
        (r'书|本|读', 'book'),
        (r'伞', 'umbrella'),
        (r'自行车|摩托|车', 'vehicle'),
        (r'镜|化妆', 'mirror'),
        (r'杯|咖啡|茶|食物|餐', 'drink_food'),
        (r'手机|电子|设备', 'device'),
        (r'乐器|吉他|琴|笛', 'instrument'),
        (r'帽子|包|扇|伞|饰品', 'accessory'),
    ],

    # ---------- 镜头 ----------
    'shot': [
        (r'大场景|俯瞰大场景|远景', 'wide'),
        (r'七分身|全身', 'full'),
        (r'环境人像', 'full'),
        (r'半身', 'medium'),
        (r'中近景', 'medium_close'),
        (r'面部特写|特写|长焦局部', 'closeup'),
    ],
    'angle': [
        (r'平视', 'eye_level'),
        (r'低机位|仰拍|仰视', 'low'),
        (r'俯拍|俯视', 'high'),
        (r'航拍|无人机', 'aerial'),
        (r'自拍', 'selfie'),
        (r'手机视角', 'phone'),
    ],
    'dof': [
        (r'大景深|全清晰|环境清晰', 'deep'),
        (r'浅景深|虚化|背景虚', 'shallow'),
        (r'中等景深', 'medium'),
    ],
    'composition': [
        (r'中心|居中', 'center'),
        (r'三分', 'rule_of_thirds'),
        (r'框架|框式', 'frame'),
        (r'留白', 'negative_space'),
        (r'对称|镜像', 'symmetry'),
        (r'对角', 'diagonal'),
        (r'压缩|几何|俯视几何', 'geometric'),
    ],
    'frame': [
        (r'横幅|横构图', 'landscape'),
        (r'竖幅|竖构图', 'portrait'),
        (r'方形|方构图', 'square'),
    ],
    'lens': [
        (r'超广角|<24|14|16|18|20|21|24mm', 'ultra_wide'),
        (r'广角|28|35mm', 'wide'),
        (r'标准|50|55|58|60|70', 'standard'),
        (r'中长焦|85|100|105|135', 'medium_tele'),
        (r'长焦|180|200|300|400|>135', 'tele'),
    ],
    'motion': [
        (r'动态|抓拍|瞬间感', 'dynamic'),
        (r'静态|摆拍|稳定', 'static'),
    ],

    # ---------- 光影 ----------
    'lightDir': [
        (r'左侧光|左前|左', 'left'),
        (r'右侧光|右前|右', 'right'),
        (r'顺光|正面光', 'front'),
        (r'逆光|背光|轮廓光', 'back'),
        (r'顶光|正顶', 'top'),
        (r'底光|脚光|下', 'bottom'),
        (r'侧光', 'side'),
    ],
    'lightQuality': [
        (r'黑白', 'mono'),
        (r'高反差硬光|硬光|直射', 'hard'),
        (r'高调柔光|柔光|散射|漫射|自然日光|自然光|日光', 'soft'),
        (r'霓虹|混合', 'mixed'),
    ],
    'colorTemp': [
        (r'暖', 'warm'),
        (r'冷', 'cool'),
        (r'中性', 'neutral'),
        (r'黑白|无彩色', 'mono'),
    ],
    'tone': [
        (r'黑白|无彩色', 'mono'),
        (r'低饱和', 'low_sat'),
        (r'高饱和|浓郁|鲜艳', 'high_sat'),
        (r'暖|橙|黄', 'warm'),
        (r'冷|青|蓝', 'cool'),
        (r'中性', 'neutral'),
    ],
    'grade': [
        (r'黑白|银盐|灰度', 'mono'),
        # 偏色要排在「褪色」前面：「复古港风调色，暖黄褪色感」两者都含，
        # 但它的主语义是偏色，归进 soft_low 会得到「柔和中性 + 港风调色」的矛盾组合。
        (r'偏色|港风|复古色调', 'tinted'),
        (r'胶片|颗粒', 'film'),
        (r'低对比|柔和低|褪色|低反差', 'soft_low'),
        (r'暗调|阴影厚重|低调|压暗', 'dark'),
        (r'通透|锐利|清晰|干净', 'clean'),
        (r'高反差|强对比|浓厚', 'contrast'),
    ],
    'mood': [
        (r'自然真实|自然流露|真实', 'natural'),
        (r'温暖柔和|温柔|暖', 'warm'),
        (r'沉静内敛|沉静|安静|静谧|内敛', 'quiet'),
        (r'明亮轻快|轻快|明亮|活', 'bright'),
        (r'疏离|冷清|孤独|孤寂', 'distant'),
        (r'怀旧|复古|旧', 'nostalgic'),
        (r'浪漫|甜蜜|亲密', 'romantic'),
        (r'戏剧|张力|电影|浓烈|热烈', 'dramatic'),
        (r'慵懒|松弛|惬意', 'lazy'),
        (r'辽阔|壮阔|开阔', 'vast'),
    ],

    # ---------- 叙事（B 库质量高，保留原文归一） ----------
    'narrative': [
        (r'自然流露的人物状态|人物状态与造型表达', 'portrait_state'),
        (r'亲子|家庭|日常亲子', 'family_time'),
        (r'亲密关系|温柔瞬间|恋人|爱意', 'intimacy'),
        (r'时尚大片|表现力|时装', 'editorial'),
        (r'文化身份|地域|传统|东方|古典', 'culture'),
        (r'城市生活|市井|人文观察|街头', 'city_life'),
        (r'旅途|旅行|路上的', 'journey'),
        (r'诗意|孤独|剪影', 'solitude'),
        (r'商业肖像|精致克制', 'commercial'),
        (r'自然秩序|光线层次|光影结构|灰度秩序', 'light_order'),
        (r'情绪与环境|渗透', 'mood_environment'),
        (r'复古都市|怀旧', 'retro_urban'),
        (r'日常漫游|安静片段', 'daily_wander'),
        (r'城市几何|空间秩序|抽象构图', 'geometry'),
    ],
}

# ============================================================
# 补丁规则：第一轮跑完 unmapped.json 后逐条补齐
# 放在原规则前面，优先匹配
# ============================================================

RULES['gender'] = [(r'士兵|艺术家|音乐人|护士|奶奶|婆婆', None)] + RULES['gender']
RULES['age'] = [(r'奶奶|婆婆|爷爷|外公|外婆', 'senior')] + RULES['age']

RULES['outfit'] = [
    (r'眼镜|墨镜|帽子|鸭舌帽|头巾|项链|耳环', SKIP),   # 这些是造型不是服装
    (r'和服', 'kimono'),
    (r'纱丽|民族|传统服饰', 'ethnic'),
    (r'吊带|背心', 'camisole'),
    (r'皮草|丝绸|蕾丝|天鹅绒', 'textured'),
    (r'围巾|披肩|头纱', 'accessory'),
] + RULES['outfit']

RULES['prop'] = [
    (r'旗帜', 'flag'),
    (r'烟雾|雾气', 'smoke'),
    (r'狗|马|猫|宠物|动物', 'animal'),
    (r'蜡烛|灯笼|灯', 'lantern'),
    (r'篮子|包|袋', 'basket'),
    (r'气球', 'balloon'),
] + RULES['prop']

RULES['pose'] = [(r'购物|逛', 'walking')] + RULES['pose']

RULES['scene'] = [
    (r'黄昏|日落', 'dusk_outdoor'),
    (r'俯瞰|大地|航拍', 'aerial_land'),
    (r'楼梯|门框|餐厅|酒吧|咖啡馆|店里|商场', 'indoor'),
    (r'河|江|湖|岸|溪', 'water'),
] + RULES['scene']

RULES['composition'] = [
    (r'主体偏右|主体偏左|偏右|偏左|偏离中心', 'off_center'),
] + RULES['composition']

RULES['narrative'] = [
    (r'沉静克制|人物肖像', 'quiet_portrait'),
    (r'复古胶片|生活切片', 'retro_slice'),
] + RULES['narrative']

# ---------- 影调：由 (色调, 后期) 组合推导，全库 100% 可算 ----------
# 这是全库最有复用价值的风格单元：19 种组合覆盖 2253 条，
# 且不像原「风格」字段那样两库语义冲突。
TONE_GRADE_TO_STYLE = {
    ('warm', 'film'): ('warm_film', '暖调胶片'),
    ('neutral', 'clean'): ('clean_natural', '自然通透'),
    ('low_sat', 'film'): ('low_sat_film', '低饱和胶片'),
    ('mono', 'mono'): ('black_white', '黑白'),
    ('neutral', 'dark'): ('dark_neutral', '暗调中性'),
    ('high_sat', 'dark'): ('dark_vivid', '暗调浓郁'),
    ('high_sat', 'film'): ('vivid_film', '浓郁胶片'),
    ('cool', 'clean'): ('cool_clean', '冷调清透'),
    ('high_sat', 'clean'): ('vivid_clean', '高饱和清透'),
    ('warm', 'dark'): ('warm_dark', '暖调暗部'),
    ('neutral', 'film'): ('neutral_film', '中性胶片'),
    ('neutral', 'soft_low'): ('soft_neutral', '柔和中性'),
    ('cool', 'dark'): ('cool_dark', '冷调暗部'),
    ('warm', 'soft_low'): ('warm_soft', '暖调柔和'),
    ('low_sat', 'soft_low'): ('low_sat_soft', '低饱和柔和'),
    ('cool', 'film'): ('cool_film', '冷调胶片'),
    ('high_sat', 'soft_low'): ('vivid_soft', '浓郁柔和'),
    ('cool', 'soft_low'): ('cool_soft', '冷调柔和'),
    ('neutral', 'contrast'): ('neutral_contrast', '中性高反差'),
}

# ---------- 题材：拍的是谁 / 拍的是什么 ----------
GENRE_OF_GROUP = {
    # A 库 bulk/*：按人群分
    'bulk/01_portrait': 'general_portrait',
    'bulk/02_woman': 'women',
    'bulk/03_man': 'men',
    'bulk/04_child': 'children',
    'bulk/05_family': 'family',
    'bulk/06_couple': 'couple',
    'bulk/07_fashion': 'fashion',
    'bulk/08_street': 'street_life',
    'bulk/09_bw': 'general_portrait',
    'bulk/10_elderly': 'elderly',
    'bulk/11_culture': 'culture',
    'bulk/12_lifestyle': 'lifestyle',
    # A 库后半段是「风格」分组，但这几个同时带题材语义
    '12_children-family': 'family',
    '13_couple-wedding': 'couple',
    '14_male-portrait': 'men',
    '11_humanist-age': 'elderly',
    # B 库这几个分组是题材不是流派
    '城市建筑': 'urban_architecture',
    '自然风光': 'landscape',
    '航拍视角': 'aerial',
    '旅行旅拍': 'travel',
    '街头瞬间': 'street_life',
    '纪实人文': 'humanist',
    '人像写真': 'portrait_studio',
}

# ---------- 流派：只放真正的视觉风格，不放题材 ----------
# A 库小分组（01_natural-light 这类）与 B 库的 5 个流派分组都是显式标签。
SCHOOL_OF_GROUP = {
    '01_natural-light': ('natural_light', '自然光人像'),
    '02_studio-commercial': ('studio_commercial', '棚拍商业'),
    '03_black-white': ('black_white', '黑白'),
    '04_dark-moody': ('dark_moody', '暗调情绪'),
    '05_fashion-editorial': ('editorial', '时尚编辑'),
    '06_environmental': ('environmental', '环境人像'),
    '07_street-documentary': ('street_doc', '街头纪实'),
    '08_silhouette-backlight': ('backlight_silhouette', '剪影逆光'),
    '09_film-vintage': ('film_vintage', '胶片复古'),
    '10_traditional-cultural': ('traditional', '传统文化'),
    '古风国风': ('guofeng', '古风国风'),
    '复古港风': ('hk_retro', '复古港风'),
    '日系胶片': ('japanese_film', '日系胶片'),
    '黑白': ('black_white', '黑白'),
    '情绪氛围': ('moody', '情绪氛围'),
}

# ---------- 大类 ----------
CATEGORY_OF_B = {
    '01-人物': 'portrait',
    '02-风景': 'landscape',
    '03-街拍': 'street',
}


def normalize(field, raw):
    """归一化。

    三种返回：
      NOT_FOUND  没有规则能处理 -> 调用方记进 unmapped，便于补规则
      None       显式丢弃（如把「戴着眼镜」从服装里剔掉，它属于造型）
      字符串     归一值
    """
    text = (raw or '').strip()
    if text in EMPTY:
        return None
    for pattern, value in RULES.get(field, []):
        if re.search(pattern, text):
            return None if value is SKIP else value
    return NOT_FOUND


# ============================================================
# 读取
# ============================================================

def load_csv(name):
    with open(DOCS / name, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def row_common(r):
    return {
        'background': r.get('背景处理', ''),
        'foreground': r.get('前景遮挡', ''),
        'prop': r.get('道具', ''),
        'outfit': r.get('服装', ''),
        'styling': r.get('造型', ''),
        'pose': r.get('姿势', ''),
        'expression': r.get('表情', ''),
        'gaze': r.get('视线', ''),
        'sceneRaw': r.get('环境', ''),
        'angle': r.get('机位', ''),
        'shot': r.get('景别', ''),
        'dof': r.get('景深', ''),
        'composition': r.get('构图手法', ''),
        'frame': r.get('画幅', ''),
        'lightDir': r.get('光线方向', ''),
        'lightQuality': r.get('光线性质', ''),
        'colorTemp': r.get('色温', ''),
        'tone': r.get('色调', ''),
        'grade': r.get('后期质感', ''),
        'mood': r.get('情绪', ''),
        'narrative': r.get('叙事氛围', ''),
        'weather': r.get('天气时间', ''),
        'motion': r.get('动态', ''),
        'lens': r.get('焦段', ''),
        'subjectRaw': r.get('主体', ''),
        'peopleRaw': r.get('人物关系', ''),
    }


def main():
    A = load_csv('analysis.csv')
    B = load_csv('images-analysis.csv')

    unmapped = defaultdict(Counter)
    vocab = defaultdict(Counter)
    records = []

    def push(lib, file, r, extra):
        raw = row_common(r)
        rec = {'lib': lib, 'file': file}
        rec.update(extra)

        # 主体三维
        subject = raw['subjectRaw']
        gender = normalize('gender', subject)
        age = normalize('age', subject)
        count = normalize('peopleCount', subject)
        people = normalize('peopleCount', raw['peopleRaw'])

        if gender is NOT_FOUND:
            if subject and subject not in EMPTY:
                unmapped['subject'][subject] += 1
            gender = None
        if age is NOT_FOUND:
            age = None
        if count is NOT_FOUND:
            count = None
        if people is NOT_FOUND:
            people = None

        if people and people != 'single':
            count = people
        rec['gender'] = gender
        rec['age'] = age
        rec['people'] = count
        for dim, value in (('gender', gender), ('age', age), ('people', count)):
            if value:
                vocab[dim][value] += 1

        # 其余维度
        for field in ['scene', 'background', 'foreground', 'pose', 'expression', 'gaze',
                      'styling', 'outfit', 'prop', 'shot', 'angle', 'dof', 'composition',
                      'frame', 'lens', 'motion', 'lightDir', 'lightQuality', 'colorTemp',
                      'tone', 'grade', 'mood', 'narrative', 'weather']:
            src = raw['sceneRaw'] if field == 'scene' else raw[field]
            value = normalize(field, src)
            if value is NOT_FOUND:
                unmapped[field][src.strip()] += 1
                value = None
            elif value:
                vocab[field][value] += 1
            rec[field] = value

        # 影调：全库可算，是组合库里最主要的风格单元
        style_key, style_name = TONE_GRADE_TO_STYLE.get(
            (rec.get('tone'), rec.get('grade')), (None, None)
        )
        rec['styleKey'] = style_key
        rec['styleName'] = style_name
        if style_key:
            vocab['styleKey'][style_key] += 1

        # 题材 / 流派 / 大类
        group = extra['groupRaw']
        rec['category'] = extra.get('category')

        genre = GENRE_OF_GROUP.get(group)
        if not genre and rec.get('people'):
            # 显式分组标签缺失时，按主体三维回推题材。
            # 不猜具体人群（比如不知道是不是「女性专题」），只落到能确定的层级。
            if rec.get('age') == 'child':
                genre = 'children'
            elif rec.get('age') == 'senior':
                genre = 'elderly'
            elif rec.get('people') == 'two':
                genre = 'couple'
            elif rec.get('people') == 'group':
                genre = 'group'
            elif rec.get('gender') == 'female':
                genre = 'women'
            elif rec.get('gender') == 'male':
                genre = 'men'
            elif rec.get('people') == 'single':
                genre = 'general_portrait'
        if not genre and not rec.get('people'):
            if rec.get('category') in ('landscape', 'street'):
                genre = 'scenery'
        rec['subjectGenre'] = genre
        if genre:
            vocab['subjectGenre'][genre] += 1

        # 流派优先取显式标签（A 库小分组 / B 库中文分组），缺失才由影调推导。
        # schoolSource 记来源，派生值可信度低于标签值。
        if group in SCHOOL_OF_GROUP:
            rec['school'], rec['schoolName'] = SCHOOL_OF_GROUP[group]
            rec['schoolSource'] = 'label'
        elif style_key:
            rec['school'], rec['schoolName'] = style_key, style_name
            rec['schoolSource'] = 'derived'
        else:
            rec['school'], rec['schoolName'], rec['schoolSource'] = None, None, None
        if rec['school']:
            vocab['school'][rec['school']] += 1

        rec['prompt'] = (r.get('中文提示词') or '').strip()
        records.append(rec)

    for r in A:
        push('A', r['文件名'].strip(), r, {
            'platform': 'stock',
            'title': (r.get('原始描述') or '').strip(),
            'groupRaw': (r.get('分组') or '').strip(),
            'category': 'portrait',
        })
    for r in B:
        push('B', r['文件'].strip(), r, {
            'platform': (r.get('平台') or '').strip(),
            'title': (r.get('标题') or '').strip(),
            'groupRaw': (r.get('原分组') or '').strip(),
            'category': CATEGORY_OF_B.get((r.get('类别') or '').strip()),
        })

    # ---------- 输出 ----------
    with open(OUT / 'prompts.jsonl', 'w', encoding='utf-8', newline='\n') as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')

    vocab_out = {
        field: [{'value': v, 'count': n} for v, n in counter.most_common()]
        for field, counter in sorted(vocab.items())
    }
    (OUT / 'vocab.json').write_text(
        json.dumps(vocab_out, ensure_ascii=False, indent=2), encoding='utf-8'
    )

    unmapped_out = {
        field: [{'raw': v, 'count': n} for v, n in counter.most_common(60)]
        for field, counter in sorted(unmapped.items())
    }
    (OUT / 'unmapped.json').write_text(
        json.dumps(unmapped_out, ensure_ascii=False, indent=2), encoding='utf-8'
    )

    # ---------- 摘要 ----------
    print(f'记录 {len(records)} 条\n')
    print(f'{"维度":14s} {"归一值":>7s} {"有值":>7s} {"覆盖率":>7s}  未映射原始值种数')
    for field in ['category', 'subjectGenre', 'school', 'schoolSource', 'styleKey',
                  'gender', 'age', 'people', 'scene', 'pose', 'expression', 'gaze',
                  'styling', 'outfit', 'prop', 'shot', 'angle', 'dof', 'composition',
                  'frame', 'lens', 'motion', 'lightDir', 'lightQuality', 'colorTemp',
                  'tone', 'grade', 'mood', 'narrative', 'weather']:
        hit = sum(1 for r in records if r.get(field))
        vals = len(vocab_out.get(field, []))
        miss = len(unmapped.get(field, {}))
        print(f'{field:14s} {vals:7d} {hit:7d} {hit/len(records)*100:6.1f}%  {miss:6d}')


if __name__ == '__main__':
    main()
