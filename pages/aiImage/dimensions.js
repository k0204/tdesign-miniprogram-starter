/**
 * 修图的「维度」定义 —— 把原来的 20 个固定套餐拆成可组合的维度。
 *
 * 为什么必须拆：
 * 原来 5 类功能 × 4 个选项 = 20 个套餐，用户只能整选一个。
 * 但真实需求是「日系的通透 + 保留一点暖调」这种组合，20 个格子表达不出来。
 * 拆成维度后，5 个维度按功能动态组合，可表达数千种搭配。
 *
 * 为什么维度不能照搬「提示词组合库」的 5 个包：
 * 库那边的包是「镜头 / 场景 / 人物 / 风格 / 叙事」，用于**生成**一张新图。
 * 这里是**修图**，原图里的一切都不能动：
 *   - 镜头包（景别 / 画幅）改了 = 裁切、扩图 → 违反 CONSTRAINT_TAIL
 *   - 场景包改了 = 换背景 → 产品红线
 *   - 人物包改了 = 换人 → 绝对禁止
 * 所以只开放「影调层」与「光的处理」，其余全部锁死在原图。
 *
 * 光位为什么可以开放：
 * 产品结论是允许用户指定目标光位（不只是修逆光）。代价是重绘风险更高，
 * 所以规矩定死两条：
 *   1. 一单只能有一个目标光位，且必须写「保留原有阴影逻辑」兜底
 *   2. 指定了目标光位就不再叠加「问题修复」——两者都是对照明的重做，叠加会打架
 */

/** 维度通用结构：{ id, name, hint, multi, options: [{ id, label, desc, prompt }] } */

export const DIMENSIONS = {
  /* ---------------- 影调方向：决定整张图的色彩与质感落点 ---------------- */
  direction: {
    id: 'direction',
    name: '影调方向',
    hint: '决定整张图的色彩和质感落在哪',
    multi: false,
    options: [
      {
        id: 'clean',
        label: '自然清透',
        desc: '修干净，不像修过',
        prompt:
          '校正白平衡去除偏色，去除灰雾提升通透度，提亮中间调并打开暗部，高光收敛不过曝，阴影通透不死黑，肤色自然均匀且保留真实纹理，轻微提饱和但不改变原有色彩倾向',
      },
      {
        id: 'film',
        label: '暖调胶片',
        desc: '暖黄，细腻颗粒',
        prompt:
          '整体转为暖黄基调，高光柔化滚降，阴影轻抬保留细节，降低整体对比让画面松弛，加入细腻均匀的胶片颗粒，肤色偏暖但保留血色，颜色柔和克制不套厚滤镜',
        implies: ['grain', 'fade'],
      },
      {
        id: 'lowsat',
        label: '低饱和清冷',
        desc: '颜色收一收，安静',
        prompt:
          '整体饱和度降低约两成，肤色单独保护不跟着变灰，压住高光留一点冷灰，阴影通透不死黑，颜色克制但层次完整，画面安静不寡淡',
      },
      {
        id: 'dark',
        label: '暗调情绪',
        desc: '压暗背景，只看人',
        prompt:
          '压暗背景与画面边缘，只保留面部和主体受光区明亮，阴影厚重但保留层次，高光收敛中间调压低，整体低调不脏，肤色不被压灰',
      },
      {
        id: 'hk',
        label: '港风复古',
        desc: '暖黄褪色，年代感',
        prompt:
          '做暖黄偏色，暗部压深并带一点绿，高光轻微褪色发旧，加粗一些的胶片颗粒，对比适中偏强，肤色暖而不过分修饰，做出年代感但不糊不脏',
        implies: ['grain', 'fade'],
      },
      {
        id: 'vivid',
        label: '浓郁出片',
        desc: '颜色饱满有记忆点',
        prompt:
          '提升整体饱和与对比，颜色饱满有记忆点，高光严格不过曝，肤色单独保护不随整体变艳，暗部保留细节不糊成色块',
      },
      {
        id: 'cool',
        label: '冷调高级',
        desc: '冷青，克制电影感',
        prompt:
          '整体转冷青基调并降低饱和度，高光干净不发灰，黑位扎实，肤色保持自然不被染青，中间调细腻，避免夸张青橙与重滤镜感',
      },
      {
        id: 'mono',
        label: '黑白质感',
        desc: '去色，靠灰阶立住',
        prompt:
          '移除色彩并建立丰富自然的灰阶，突出原有光线结构与材质层次，黑位扎实但不死黑，高光保留层次不过曝，加入极轻微的写实颗粒',
        implies: ['grain'],
      },
    ],
  },

  /* ---------------- 画面问题：当前这张照片有什么硬伤 ---------------- */
  issue: {
    id: 'issue',
    name: '画面问题',
    hint: '先救硬伤，再谈风格',
    multi: false,
    options: [
      {
        id: 'auto',
        label: '自动判断',
        desc: 'AI 看图决定',
        // 只负责「技术缺陷」，不负责「风格」。
        // 否则和「自然清透」（同样在说去灰、正白平衡）撞车，同一件事说两遍。
        prompt:
          '先判断这张照片是否存在技术缺陷，只对确有问题的噪点、失焦、局部过曝或欠曝、明显偏色做修正，不改变照片的整体风格与色彩倾向',
      },
      {
        id: 'backlight',
        label: '逆光欠曝',
        desc: '脸黑，背景过曝',
        prompt:
          '修复逆光造成的面部欠曝，自然提亮脸部和眼睛，压低背景与天空过亮区域，保留发丝边缘的真实逆光，避免抠图感',
      },
      {
        id: 'hard',
        label: '硬光阴阳脸',
        desc: '一边白一边黑',
        prompt:
          '减弱直射硬光造成的刺眼高光与过深阴影，柔化生硬的亮暗交界，保留立体轮廓、真实肤质和原有光线方向',
      },
      {
        id: 'top',
        label: '顶光眼窝阴影',
        desc: '眼窝法令纹发暗',
        prompt:
          '修复顶光造成的眼窝、鼻底与法令纹阴影，单独提亮面中区域，压住额头与鼻梁的过亮，恢复均匀的面部受光',
      },
      {
        id: 'flat',
        label: '平光无层次',
        desc: '脸太平像贴纸',
        prompt:
          '为平光照片补回立体感，丰富中间调层次，加强面部与身体的自然明暗过渡，不制造新的光源或改变阴影位置',
      },
      {
        id: 'bottom',
        label: '底光怪异',
        desc: '下巴鼻底发亮',
        prompt:
          '修正底光造成的下巴与鼻底异常提亮，恢复面部正常的明暗关系，让五官比例回到自然状态',
      },
      {
        id: 'none',
        label: '没有大问题',
        desc: '不修结构',
        prompt: '',
      },
    ],
  },

  /* ---------------- 目标光位：整张图重新打光的方向 ---------------- */
  lightDir: {
    id: 'lightDir',
    name: '目标光位',
    hint: '改变主光方向。选定后不再叠加「画面问题」，两者都在动光，叠加会打架',
    multi: false,
    options: [
      {
        id: 'keep',
        label: '保持原光位',
        desc: '不动光线结构',
        prompt: '',
      },
      {
        // 光影重塑的默认项：不改方向，只把主体和环境的曝光拉平衡。
        // 没有这一项的话，「保持原光位」会让整个维度等于没选，拼不出任何指令。
        id: 'balance',
        label: '平衡补光',
        desc: '不提方向，只平明暗',
        prompt:
          '根据原图主体、环境与光源方向进行自然补光，提亮人物或主体，打开过深阴影并保护背景高光，补光必须符合原场景逻辑，不增加可见光源或改变阴影位置',
      },
      {
        id: 'left',
        label: '左侧光',
        desc: '光从左边来',
        prompt:
          '将主光重塑为来自画面左侧的柔和侧光，左脸受光、右脸自然过渡到阴影，保留原有阴影逻辑与人物结构，不改变背景内容',
      },
      {
        id: 'right',
        label: '右侧光',
        desc: '光从右边来',
        prompt:
          '将主光重塑为来自画面右侧的柔和侧光，右脸受光、左脸自然过渡到阴影，保留原有阴影逻辑与人物结构，不改变背景内容',
      },
      {
        id: 'front',
        label: '顺光',
        desc: '正面均匀受光',
        prompt:
          '将光线重塑为正面顺光，面部受光均匀、阴影减弱，保留自然的立体过渡与皮肤质感，不把脸打成完全平面',
      },
      {
        id: 'back',
        label: '逆光',
        desc: '背后打光，轮廓亮',
        prompt:
          '将光线重塑为逆光，光线从主体后方穿过形成发丝与轮廓的边缘光，面部保持自然可辨的亮度，不过度压暗成剪影',
      },
      {
        id: 'top',
        label: '顶光',
        desc: '从上往下打',
        prompt:
          '将光线重塑为来自上方的顶光，额头与鼻梁受光、眼窝与下颌形成自然阴影，保持面部比例正常，不加深成黑洞',
      },
      {
        id: 'bottom',
        label: '底光',
        desc: '从下往上打',
        prompt:
          '将光线重塑为来自下方的底光，下巴与鼻底受光、眼窝加深，整体保持人物五官自然，不产生恐怖片式的夸张效果',
      },
    ],
  },

  /* ---------------- 改动幅度：同一方向做多重 ---------------- */
  strength: {
    id: 'strength',
    name: '改动幅度',
    hint: '决定能走多远',
    multi: false,
    options: [
      {
        id: 'light',
        label: '轻微',
        desc: '几乎看不出修过',
        // 文案里不能写「所选方向」：智能增强与光影重塑没有方向可选，那样会指代不到东西
        prompt: '以上处理都做克制，只到技术性校正的程度，保留原始光线方向与色彩倾向，改动几乎看不出',
      },
      {
        id: 'medium',
        label: '适中',
        desc: '完整执行，留住现场感',
        prompt: '以上处理按标准强度执行，同时保留原图的光线方向与场景结构，不改变拍摄现场感',
      },
      {
        id: 'strong',
        label: '明显',
        desc: '氛围可以大改',
        prompt:
          '以上处理可以做到明显，允许改变整体氛围与影调，但仍不改变人物身份五官、服装款式、背景内容、构图与裁切范围',
      },
    ],
  },

  /* ---------------- 质感微调：末端的开关 ---------------- */
  texture: {
    id: 'texture',
    name: '质感微调',
    hint: '可选，最多两项',
    multi: true,
    maxPick: 2,
    options: [
      {
        id: 'grain',
        label: '胶片颗粒',
        desc: '细腻均匀',
        prompt: '加入细腻均匀的胶片颗粒，不出现色块和噪点',
      },
      {
        id: 'fade',
        label: '轻微褪色',
        desc: '高光发旧',
        prompt: '高光轻微褪色，带一点旧片感，暗部保持扎实',
      },
      {
        id: 'bright_skin',
        label: '肤色提亮',
        desc: '气色更好',
        prompt: '单独提亮肤色，保留健康血色与皮肤纹理，不发白不磨平',
      },
      {
        id: 'dark_bg',
        label: '压暗背景',
        desc: '人物更突出',
        prompt: '压暗背景与画面边缘，让主体更突出，背景内容不增不减',
      },
      {
        id: 'soft_edge',
        label: '柔化过渡',
        desc: '减轻生硬感',
        prompt: '柔化高光与阴影之间的过渡，减轻生硬反差，保留层次不糊',
      },
      {
        id: 'sharpen',
        label: '质感锐化',
        desc: '发丝材质更清楚',
        prompt: '适度增强发丝、衣物材质和边缘清晰度，不产生锐化光边或过度噪点',
      },
    ],
  },

  /* ---------------- 场景类型：只在「场景出片」里出现 ---------------- */
  scene: {
    id: 'scene',
    name: '场景类型',
    hint: '按拍摄内容定向优化',
    multi: false,
    options: [
      {
        id: 'landscape',
        label: '风景',
        desc: '空气通透，远近有层次',
        prompt:
          '针对自然风景优化，去除灰雾、增强真实空气透视与远近层次，恢复天空云层山水植被细节，色彩鲜活但可信',
      },
      {
        id: 'food',
        label: '美食',
        desc: '颜色准确，质感诱人',
        prompt:
          '针对美食优化，校正餐厅混合偏色，使食物颜色准确鲜润，增强食材纹理、光泽与温度感，餐具桌面干净自然',
      },
      {
        id: 'indoor',
        label: '室内',
        desc: '空间明亮，窗内外平衡',
        prompt:
          '针对室内优化，校正灯光偏黄与混合色温，提亮空间中间调，平衡室内与窗外亮度，控制灯具高光，墙面颜色中性',
      },
      {
        id: 'night',
        label: '夜景',
        desc: '灯光干净，暗部有层次',
        prompt:
          '针对城市夜景优化，控制霓虹招牌与路灯高光，降低暗部噪点与杂色，恢复建筑层次，黑位干净不乱，保留真实冷暖灯光对比',
      },
    ],
  },
};

/**
 * 功能 -> 维度组。
 * 不是把 5 组维度一股脑丢给用户，而是按当前要做的操作只显示相关的那几组。
 * 「智能增强」不给影调方向，因为它本来就该只修技术缺陷；
 * 「光影重塑」不给画面问题，因为目标光位已经覆盖了照明的全部处理。
 */
export const CAPABILITY_GROUPS = {
  enhance: ['issue', 'strength'],
  portrait: ['issue', 'direction', 'strength', 'texture'],
  relight: ['lightDir', 'strength', 'texture'],
  // 风格转换也要给「画面问题」：逆光照片直接套港风只会更黑，
  // 必须先救脸。默认 auto 由 AI 判断，用户可覆盖。
  style: ['issue', 'direction', 'lightDir', 'strength', 'texture'],
  // 场景出片不给「影调方向」：风景/美食/室内/夜景套人像的肤色文案会串味，
  // 需要氛围感时用「质感微调」里的颗粒与褪色即可。
  scene: ['scene', 'strength', 'texture'],
};

/** 每个功能的默认选择，保证一进来就有可用的拼装结果 */
export const CAPABILITY_DEFAULTS = {
  enhance: { issue: 'auto', strength: 'medium' },
  portrait: { issue: 'auto', direction: 'clean', strength: 'medium', texture: [] },
  relight: { lightDir: 'balance', strength: 'medium', texture: [] },
  style: { issue: 'auto', direction: 'clean', lightDir: 'keep', strength: 'medium', texture: [] },
  scene: { scene: 'landscape', strength: 'medium', texture: [] },
};

function pickOption(dim, id) {
  if (!dim || !id) return null;
  return dim.options.find((item) => item.id === id) || null;
}

/**
 * 把一组选择拼成「改动描述」，供 buildPrompt 的 item 槽使用。
 *
 * 组内用「，」连接（并列的修饰），组间用「；」分隔（不同的处理层）。
 * 顺序固定为 问题/光位 -> 影调 -> 质感 -> 幅度：
 * 先救硬伤、再定调子、最后收边角，幅度放最后因为它约束的是前面所有动作。
 *
 * 光位与画面问题互斥：
 * 指定了目标光位就跳过问题修复 —— 两者都是对照明的重做，
 * 叠在一起模型会收到两套互相矛盾的打光指令。
 */
export function buildMods(selection = {}, capabilityId = '') {
  const groups = CAPABILITY_GROUPS[capabilityId] || [];
  const order = ['scene', 'issue', 'lightDir', 'direction', 'texture', 'strength'];
  const hasLightTarget = Boolean(selection.lightDir && selection.lightDir !== 'keep');

  /**
   * 影调方向已经自带质感写法的（胶片/港风/黑白），质感维度里对应项要跳过。
   * 否则会拼出「加入细腻均匀的胶片颗粒」+「加入细腻均匀的胶片颗粒，不出现色块」这种重复。
   */
  const implied = new Set();
  const dirOption = pickOption(DIMENSIONS.direction, selection.direction);
  if (dirOption && dirOption.implies) {
    dirOption.implies.forEach((id) => implied.add(id));
  }

  const blocks = [];
  order.forEach((key) => {
    if (groups.indexOf(key) === -1) return;
    // 光位已指定目标时，问题修复让位
    if (key === 'issue' && hasLightTarget) return;

    const dim = DIMENSIONS[key];
    if (!dim) return;

    const value = selection[key];
    const texts = [];

    if (dim.multi) {
      (Array.isArray(value) ? value : []).forEach((id) => {
        if (key === 'texture' && implied.has(id)) return;
        const option = pickOption(dim, id);
        if (option && option.prompt) texts.push(option.prompt);
      });
    } else {
      const option = pickOption(dim, value);
      if (option && option.prompt) texts.push(option.prompt);
    }

    if (texts.length) blocks.push(texts.join('，'));
  });

  return blocks.join('；');
}

/** 供 UI 渲染：把某个功能可用的维度组展开成带 selected 标记的视图数据 */
export function buildDimensionView(capabilityId, selection = {}) {
  const groups = CAPABILITY_GROUPS[capabilityId] || [];
  return groups.map((key) => {
    const dim = DIMENSIONS[key];
    const value = selection[key];
    const picked = dim.multi
      ? (Array.isArray(value) ? value : [])
      : (value ? [value] : []);

    const pickedOptions = picked
      .map((id) => pickOption(dim, id))
      .filter(Boolean);

    // 横滑一行放不下 desc，所以把当前选中的说明单独拎到组下面
    let pickedDesc = '';
    if (dim.multi) {
      pickedDesc = pickedOptions.length
        ? pickedOptions.map((item) => `${item.label}：${item.desc}`).join(' · ')
        : dim.hint;
    } else {
      pickedDesc = pickedOptions.length ? pickedOptions[0].desc : dim.hint;
    }

    return {
      key: dim.id,
      name: dim.name,
      hint: dim.hint,
      multi: Boolean(dim.multi),
      maxPick: dim.maxPick || 0,
      pickedCount: pickedOptions.length,
      // 文案在 JS 侧算好：wx:for 里做判断在当前基础库不可靠
      multiHint: dim.multi
        ? `多选${dim.maxPick ? ` · 最多${dim.maxPick}项` : ''}${pickedOptions.length ? ` · 已选${pickedOptions.length}` : ''}`
        : '',
      pickedLabel: pickedOptions.map((item) => item.label).join(' · '),
      pickedDesc,
      options: dim.options.map((option) => ({
        id: option.id,
        label: option.label,
        desc: option.desc,
        selected: picked.indexOf(option.id) !== -1,
      })),
    };
  });
}
