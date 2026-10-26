/**
 * AI 修图提示词 · 内置默认版本
 *
 * 这是**提示词唯一手写来源**。云端那份（云存储 prompts/aiImage.prompt.json）
 * 由 .workbuddy/scripts/build-prompt-config.mjs 从这里生成，不要手改云端文件。
 *
 * 为什么还要内置一份：冷启动、离线、云存储没配好时都得能出图。
 * 线上热更新只是「把新版本下发给已经安装的小程序」，不是唯一来源。
 *
 * 改提示词的流程：
 *   1. 改这个文件，version +1（build 脚本发现内容变了却没升版会报错）
 *   2. node .workbuddy/scripts/build-prompt-config.mjs
 *   3. node .workbuddy/scripts/upload-prompt-config.mjs
 *
 * 字段说明：
 *   anchors      四段固定文案（主体锚 / 保留边界 / 约束行），keepHint 用 key 引用
 *   capabilities 功能列表，desc 显示在「选择条件」标题右侧
 *   groups       功能 -> 维度组，数组顺序就是界面从上到下的顺序
 *   defaults     每个功能的默认选择，必须能拼出非空指令
 *   dimensions   维度定义，option.prompt 是真正拼进提示词的正文
 *   conflicts    组合放大风险，issue/direction 为声明式条件，direction 可为 'any'
 *
 * 注意：dimensions 里的 option id 一旦上线就不要再改，本地缓存与 AI 建议缓存
 * 都按 id 做 key，改名等于让老用户的缓存失效。
 */
export default {
  "schema": "aiImage.prompt",
  "version": 1,
  "updatedAt": "2026-10-25T14:11:56.773Z",
  "note": "AI 修图的提示词配置。改完用 .workbuddy/scripts/build-prompt-config.mjs 生成云端 json 再上传。",
  "anchors": {
    "anchorPhoto": "基于输入照片进行专业AI摄影后期，先识别人物、主体、场景与现有光线，再执行所选的一键处理",
    "keepPhoto": "严格保持原图人物身份、五官、表情、姿态、服装、物体、文字、背景、构图、裁切范围和空间位置不变",
    "keepPortrait": "严格保持人物身份、五官比例、脸型、表情、发型、身材、姿态、服装与个人皮肤特征不变，不做网红脸",
    "keepScene": "严格保持原有主体、景物结构、建筑透视、文字、构图、裁切范围和全部场景内容不变",
    "constraintTail": "结果必须是同一张照片的自然后期版本；不扩图、不裁切、不移动、增加、删除或替换任何内容，不改变天气与时段，不虚构被遮挡细节，无文字变化、重影、畸变、塑料皮肤或多余肢体"
  },
  "capabilities": [
    {
      "id": "enhance",
      "name": "智能增强",
      "icon": "adjustment",
      "desc": "AI自动判断照片问题",
      "keepHint": "keepPhoto"
    },
    {
      "id": "portrait",
      "name": "人像成片",
      "icon": "user",
      "desc": "以人物状态和质感为重点",
      "keepHint": "keepPortrait"
    },
    {
      "id": "relight",
      "name": "光影重塑",
      "icon": "brightness",
      "desc": "重新平衡人物与环境光线",
      "keepHint": "keepPhoto"
    },
    {
      "id": "style",
      "name": "风格转换",
      "icon": "palette",
      "desc": "统一整张照片的色彩与质感",
      "keepHint": "keepPhoto"
    },
    {
      "id": "scene",
      "name": "场景出片",
      "icon": "image",
      "desc": "AI按拍摄内容针对性优化",
      "keepHint": "keepScene"
    }
  ],
  "groups": {
    "enhance": [
      "issue",
      "strength"
    ],
    "portrait": [
      "issue",
      "focus",
      "direction",
      "texture",
      "strength"
    ],
    "relight": [
      "lightDir",
      "texture",
      "strength"
    ],
    "style": [
      "issue",
      "lightDir",
      "direction",
      "texture",
      "strength"
    ],
    "scene": [
      "scene",
      "texture",
      "strength"
    ]
  },
  "defaults": {
    "enhance": {
      "issue": "auto",
      "strength": "medium"
    },
    "portrait": {
      "issue": "auto",
      "focus": "auto",
      "direction": "clean",
      "texture": [],
      "strength": "medium"
    },
    "relight": {
      "lightDir": "balance",
      "texture": [],
      "strength": "medium"
    },
    "style": {
      "issue": "auto",
      "lightDir": "keep",
      "direction": "clean",
      "texture": [],
      "strength": "medium"
    },
    "scene": {
      "scene": "landscape",
      "texture": [],
      "strength": "medium"
    }
  },
  "dimensions": {
    "direction": {
      "id": "direction",
      "name": "影调方向",
      "hint": "决定整张图的色彩和质感落在哪",
      "multi": false,
      "options": [
        {
          "id": "clean",
          "label": "自然清透",
          "desc": "闷、脏、不通透，本身没硬伤（21%）",
          "prompt": "校正白平衡去除偏色，去除灰雾提升通透度，提亮中间调并打开暗部，高光收敛不过曝，阴影通透不死黑，肤色自然均匀且保留毛孔与真实细纹，不做磨皮不做过度锐化，轻微提饱和但不改变原有色彩倾向"
        },
        {
          "id": "film",
          "label": "暖调胶片",
          "desc": "柔光暖肤，要不像修过的胶片感（19%）",
          "prompt": "整体转为暖黄基调，高光柔化滚降，阴影轻抬保留细节，降低整体对比让画面松弛，加入细腻均匀的胶片颗粒，肤色偏暖但保留血色，颜色柔和克制不套厚滤镜",
          "implies": [
            "grain",
            "fade"
          ]
        },
        {
          "id": "lowsat",
          "label": "低饱和清冷",
          "desc": "颜色太杂太艳，想收一收（16%）",
          "prompt": "整体饱和度降低约两成，肤色单独保护不跟着变灰，压住高光留一点冷灰，阴影通透不死黑，颜色克制但层次完整，画面安静不寡淡"
        },
        {
          "id": "dark",
          "label": "暗调情绪",
          "desc": "背景乱，只想让人看脸（15%）",
          "prompt": "压暗背景与画面边缘，只保留面部和主体受光区明亮，阴影厚重但保留层次，高光收敛中间调压低，整体低调不脏，肤色不被压灰",
          "implies": [
            "dark_bg"
          ]
        },
        {
          "id": "hk",
          "label": "港风复古",
          "desc": "室内夜景，要浓的年代感（10%）",
          "prompt": "做暖黄偏色，暗部压深并带一点绿，高光轻微褪色发旧，加粗一些的胶片颗粒，对比适中偏强，肤色暖而不过分修饰，做出年代感但不糊不脏",
          "implies": [
            "grain",
            "fade"
          ]
        },
        {
          "id": "vivid",
          "label": "浓郁出片",
          "desc": "旅拍花丛，本身色彩就丰富（9%）",
          "prompt": "提升整体饱和与对比，颜色饱满有记忆点，高光严格不过曝，肤色单独保护不随整体变艳，暗部保留细节不糊成色块"
        },
        {
          "id": "cool",
          "label": "冷调高级",
          "desc": "想摆脱甜腻，要清冷高级感（6%）",
          "prompt": "整体转冷青基调并降低饱和度，高光干净不发灰，黑位扎实，肤色保持自然不被染青，中间调细腻，避免夸张青橙与重滤镜感"
        },
        {
          "id": "mono",
          "label": "黑白质感",
          "desc": "光影结构强，颜色是干扰（5%）",
          "prompt": "移除色彩并建立丰富自然的灰阶，突出原有光线结构与材质层次，黑位扎实但不死黑，高光保留层次不过曝，加入极轻微的写实颗粒",
          "implies": [
            "grain",
            "bright_skin"
          ]
        }
      ]
    },
    "issue": {
      "id": "issue",
      "name": "画面问题",
      "hint": "先救硬伤，再谈风格",
      "multi": false,
      "options": [
        {
          "id": "auto",
          "label": "自动判断",
          "desc": "不确定就交给 AI 判断",
          "prompt": "先判断这张照片是否存在技术缺陷，只对确有问题的噪点、失焦、局部过曝或欠曝、明显偏色做修正，不改变照片的整体风格与色彩倾向"
        },
        {
          "id": "backlight",
          "label": "逆光欠曝",
          "desc": "脸黑背景白，逆着光拍（11%）",
          "prompt": "修复逆光造成的面部欠曝，自然提亮脸部和眼睛，压低背景与天空过亮区域，保留发丝边缘的真实逆光，避免抠图感"
        },
        {
          "id": "hard",
          "label": "硬光阴阳脸",
          "desc": "直射光，亮暗交界生硬（20%）",
          "prompt": "减弱直射硬光造成的刺眼高光与过深阴影，柔化生硬的亮暗交界，保留立体轮廓、真实肤质和原有光线方向"
        },
        {
          "id": "top",
          "label": "顶光眼窝阴影",
          "desc": "室内顶灯，眼窝鼻底发黑（15%）",
          "prompt": "修复顶光造成的眼窝、鼻底与法令纹阴影，单独提亮面中区域，压住额头与鼻梁的过亮，恢复均匀的面部受光"
        },
        {
          "id": "flat",
          "label": "平光无层次",
          "desc": "顺光阴天，脸平没立体感（19%）",
          "prompt": "为平光照片补回立体感，丰富中间调层次，加强面部与身体的自然明暗过渡，不制造新的光源或改变阴影位置"
        },
        {
          "id": "bottom",
          "label": "底光怪异",
          "desc": "下巴鼻底发亮，像打手电（4%）",
          "prompt": "修正底光造成的下巴与鼻底异常提亮，恢复面部正常的明暗关系，让五官比例回到自然状态"
        },
        {
          "id": "none",
          "label": "没有大问题",
          "desc": "光线没问题，只做风格（38%）",
          "prompt": ""
        }
      ]
    },
    "focus": {
      "id": "focus",
      "name": "优化重点",
      "hint": "按景别选，决定细节用在哪",
      "multi": false,
      "options": [
        {
          "id": "auto",
          "label": "自动",
          "desc": "按画面主体自己分配",
          "prompt": ""
        },
        {
          "id": "overall",
          "label": "整体氛围",
          "desc": "全景远景，管影调环境",
          "prompt": "把优化重点放在整体影调、环境色彩与人物比例的协调上，肤质只做基础净化，不单独强化局部细节"
        },
        {
          "id": "skin",
          "label": "肤质肤色",
          "desc": "中景近景，管肤色肤质",
          "prompt": "把优化重点放在肤色均匀度与皮肤质感上，保留真实毛孔、细纹和皮肤本身的光泽，不做塑料磨皮，衣物与背景只做轻度整理"
        },
        {
          "id": "eyes",
          "label": "五官眼神",
          "desc": "特写大头照，管五官眼神",
          "prompt": "把优化重点放在五官细节与眼神光上，眼白与瞳孔自然透亮不死黑，唇色与眉形只做微调，保留本人辨识度"
        }
      ]
    },
    "lightDir": {
      "id": "lightDir",
      "name": "目标光位",
      "hint": "改变主光方向。选定后不再叠加「画面问题」，两者都在动光，叠加会打架",
      "multi": false,
      "options": [
        {
          "id": "keep",
          "label": "保持原光位",
          "desc": "不动光线结构",
          "prompt": ""
        },
        {
          "id": "balance",
          "label": "平衡补光",
          "desc": "不提方向，只平明暗",
          "prompt": "根据原图主体、环境与光源方向进行自然补光，提亮人物或主体，打开过深阴影并保护背景高光，补光必须符合原场景逻辑，不增加可见光源或改变阴影位置"
        },
        {
          "id": "left",
          "label": "左侧光",
          "desc": "光从左边来",
          "prompt": "将主光重塑为来自画面左侧的柔和侧光，左脸受光、右脸自然过渡到阴影，保留原有阴影逻辑与人物结构，不改变背景内容"
        },
        {
          "id": "right",
          "label": "右侧光",
          "desc": "光从右边来",
          "prompt": "将主光重塑为来自画面右侧的柔和侧光，右脸受光、左脸自然过渡到阴影，保留原有阴影逻辑与人物结构，不改变背景内容"
        },
        {
          "id": "front",
          "label": "顺光",
          "desc": "正面均匀受光",
          "prompt": "将光线重塑为正面顺光，面部受光均匀、阴影减弱，保留自然的立体过渡与皮肤质感，不把脸打成完全平面"
        },
        {
          "id": "back",
          "label": "逆光",
          "desc": "背后打光，轮廓亮",
          "prompt": "将光线重塑为逆光，光线从主体后方穿过形成发丝与轮廓的边缘光，面部保持自然可辨的亮度，不过度压暗成剪影"
        },
        {
          "id": "top",
          "label": "顶光",
          "desc": "从上往下打",
          "prompt": "将光线重塑为来自上方的顶光，额头与鼻梁受光、眼窝与下颌形成自然阴影，保持面部比例正常，不加深成黑洞"
        },
        {
          "id": "bottom",
          "label": "底光",
          "desc": "从下往上打",
          "prompt": "将光线重塑为来自下方的底光，下巴与鼻底受光、眼窝加深，整体保持人物五官自然，不产生恐怖片式的夸张效果"
        }
      ]
    },
    "strength": {
      "id": "strength",
      "name": "改动幅度",
      "hint": "决定能走多远",
      "multi": false,
      "options": [
        {
          "id": "light",
          "label": "轻微",
          "desc": "几乎看不出修过",
          "prompt": "以上处理都做克制，只到技术性校正的程度，保留原始光线方向与色彩倾向，改动几乎看不出"
        },
        {
          "id": "medium",
          "label": "适中",
          "desc": "完整执行，留住现场感",
          "prompt": "以上处理按标准强度执行，同时保留原图的光线方向与场景结构，不改变拍摄现场感"
        },
        {
          "id": "strong",
          "label": "明显",
          "desc": "氛围可以大改",
          "prompt": "以上处理可以做到明显，允许改变整体氛围与影调，但仍不改变人物身份五官、服装款式、背景内容、构图与裁切范围"
        }
      ]
    },
    "texture": {
      "id": "texture",
      "name": "质感微调",
      "hint": "可选，最多两项",
      "multi": true,
      "maxPick": 2,
      "options": [
        {
          "id": "grain",
          "label": "胶片颗粒",
          "desc": "细腻均匀，配复古胶片",
          "prompt": "加入细腻均匀的胶片颗粒，不出现色块和噪点"
        },
        {
          "id": "fade",
          "label": "轻微褪色",
          "desc": "高光发旧，别再叠厚滤镜",
          "prompt": "高光轻微褪色，带一点旧片感，暗部保持扎实"
        },
        {
          "id": "bright_skin",
          "label": "肤色提亮",
          "desc": "脸比身体暗时补一档",
          "prompt": "单独提亮肤色，保留健康血色与皮肤纹理，不发白不磨平"
        },
        {
          "id": "dark_bg",
          "label": "压暗背景",
          "desc": "背景抢戏时压一压",
          "prompt": "压暗背景与画面边缘，让主体更突出，背景内容不增不减"
        },
        {
          "id": "soft_edge",
          "label": "柔化过渡",
          "desc": "亮暗交界太硬时用",
          "prompt": "柔化高光与阴影之间的过渡，减轻生硬反差，保留层次不糊"
        },
        {
          "id": "sharpen",
          "label": "质感锐化",
          "desc": "发丝衣物更清楚，别过头",
          "prompt": "适度增强发丝、衣物材质和边缘清晰度，不产生锐化光边或过度噪点"
        }
      ]
    },
    "scene": {
      "id": "scene",
      "name": "场景类型",
      "hint": "按拍摄内容定向优化",
      "multi": false,
      "options": [
        {
          "id": "landscape",
          "label": "风景",
          "desc": "空气通透，远近有层次",
          "prompt": "针对自然风景优化，去除灰雾、增强真实空气透视与远近层次，恢复天空云层山水植被细节，色彩鲜活但可信"
        },
        {
          "id": "street",
          "label": "街拍街景",
          "desc": "招牌灯光杂，天空易过曝",
          "prompt": "针对城市街拍优化，还原街道招牌与灯光的真实色相，压住大面积过曝天空与杂乱高光，提升通透度与建筑层次，人群与街景细节保持自然"
        },
        {
          "id": "waterfront",
          "label": "水岸海边",
          "desc": "水面反光，天海大片死白",
          "prompt": "针对海边湖畔优化，平衡天空与水面的大面积反光，压住水面高光并保留波纹与倒影细节，还原真实水色与天光过渡，人物受光与环境一致"
        },
        {
          "id": "garden",
          "label": "花草园林",
          "desc": "绿易发黄，花色易串",
          "prompt": "针对花草园林优化，还原植被与花色的真实色相，避免绿色发黄或整体偏洋红，区分前景与背景的层次，枝叶细节不糊成色块"
        },
        {
          "id": "indoor",
          "label": "室内",
          "desc": "空间明亮，窗内外平衡",
          "prompt": "针对室内优化，校正灯光偏黄与混合色温，提亮空间中间调，平衡室内与窗外亮度，控制灯具高光，墙面颜色中性"
        },
        {
          "id": "food",
          "label": "美食",
          "desc": "颜色准确，质感诱人",
          "prompt": "针对美食优化，校正餐厅混合偏色，使食物颜色准确鲜润，增强食材纹理、光泽与温度感，餐具桌面干净自然"
        },
        {
          "id": "night",
          "label": "夜景",
          "desc": "灯光干净，暗部有层次",
          "prompt": "针对城市夜景优化，控制霓虹招牌与路灯高光，降低暗部噪点与杂色，恢复建筑层次，黑位干净不乱，保留真实冷暖灯光对比"
        }
      ]
    }
  },
  "conflicts": [
    {
      "id": "backlight-film",
      "issue": [
        "backlight"
      ],
      "direction": [
        "film"
      ],
      "tip": "逆光 + 暖调胶片：暖调会把脸再压暗一档",
      "fix": "先按逆光把面部提亮到位，再叠暖调；暖调只作用于高光与阴影，不压中间调"
    },
    {
      "id": "hard-lowsat",
      "issue": [
        "hard"
      ],
      "direction": [
        "lowsat"
      ],
      "tip": "硬光 + 低饱和：亮暗交界的生硬会更明显",
      "fix": "先把生硬的亮暗交界过渡做软，再降低饱和度"
    },
    {
      "id": "top-dark",
      "issue": [
        "top"
      ],
      "direction": [
        "dark"
      ],
      "tip": "顶光 + 暗调情绪：眼窝容易加深成黑洞",
      "fix": "面中单独加亮，暗调只压背景，不动面部受光区"
    },
    {
      "id": "flat-cool",
      "issue": [
        "flat"
      ],
      "direction": [
        "cool"
      ],
      "tip": "平光 + 冷调高级：容易出塑料感",
      "fix": "先补回轮廓与中间调的立体层次，冷调只动背景与环境色温"
    },
    {
      "id": "bottom-any",
      "issue": [
        "bottom"
      ],
      "direction": "any",
      "tip": "底光是结构问题，再叠风格只会更怪",
      "fix": "优先把下巴与鼻底的异常提亮压回自然，风格化处理降到最轻"
    }
  ]
};
