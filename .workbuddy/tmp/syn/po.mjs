/** 整图 AI 修图能力。每个选项是一套完整成片方案，不要求用户理解摄影参数。 */
export const ANCHOR_PHOTO =
  '基于输入照片进行专业AI摄影后期，先识别人物、主体、场景与现有光线，再执行所选的一键处理';

export const KEEP_PHOTO =
  '严格保持原图人物身份、五官、表情、姿态、服装、物体、文字、背景、构图、裁切范围和空间位置不变';
export const KEEP_PORTRAIT =
  '严格保持人物身份、五官比例、脸型、表情、发型、身材、姿态、服装与个人皮肤特征不变，不做网红脸';
export const KEEP_SCENE =
  '严格保持原有主体、景物结构、建筑透视、文字、构图、裁切范围和全部场景内容不变';

export const CONSTRAINT_TAIL =
  '结果必须是同一张照片的自然后期版本；不扩图、不裁切、不移动、增加、删除或替换任何内容，不改变天气与时段，不虚构被遮挡细节，无文字变化、重影、畸变、塑料皮肤或多余肢体';

export const EDIT_TYPES = [
  {
    id: 'enhance',
    name: '智能增强',
    icon: 'adjustment',
    desc: 'AI自动判断照片问题',
    keepHint: KEEP_PHOTO,
    options: [
      {
        id: 'enhance-auto',
        label: '一键变好',
        desc: '自动优化整张照片',
        prompt: '分析照片当前成像质量，只对确有问题的曝光、白平衡、动态范围、噪点、灰雾和清晰度进行综合优化；高光柔和、阴影有层次、颜色自然，让照片明显更干净通透但看不出重度处理',
      },
      {
        id: 'enhance-hd',
        label: '高清修复',
        desc: '改善轻微模糊和低清晰度',
        prompt: '改善轻微失焦、压缩和低清晰度，恢复原图中真实可辨认的主体轮廓、发丝、材质和边缘，抑制噪点与锐化光边；不凭空重画五官、文字、纹理或不可见细节',
      },
      {
        id: 'enhance-lowlight',
        label: '暗光救片',
        desc: '提亮主体，清理暗部噪点',
        prompt: '针对欠曝和低照度照片，自然提亮主体与中间调，恢复可见阴影层次，降低暗部亮度噪点和彩色噪点，同时压住灯光高光；保持真实夜晚或室内氛围，不把夜景变成白天',
      },
      {
        id: 'enhance-old',
        label: '旧照焕新',
        desc: '减轻褪色、泛黄和老化感',
        prompt: '修复旧照片的整体褪色、泛黄、低对比、颗粒与轻微扫描损伤，恢复原图仍存在的灰阶、颜色和面部可见细节；保留年代质感，不重画人物，不修改服装、背景、文字与历史内容',
      },
    ],
  },
  {
    id: 'portrait',
    name: '人像成片',
    icon: 'user',
    desc: '以人物状态和质感为重点',
    keepHint: KEEP_PORTRAIT,
    options: [
      {
        id: 'portrait-natural',
        label: '自然精修',
        desc: '气色更好，保留真实肤质',
        prompt: '识别人脸与皮肤区域，改善肤色暗沉和局部不均，减轻临时小瑕疵、油光与眼下疲惫感，让眼神和嘴唇更有精神；保留毛孔、细纹、痣、五官与个人特征，不磨皮换脸',
      },
      {
        id: 'portrait-soft',
        label: '柔光写真',
        desc: '光线细腻，肤色通透',
        prompt: '将人像处理为自然柔光写真质感：面部曝光均匀，高光顺滑，阴影过渡细腻，肤色清透健康，背景色彩克制；保留真实皮肤纹理、发丝、五官和原有光线方向',
      },
      {
        id: 'portrait-studio',
        label: '影棚质感',
        desc: '轮廓立体，画面干净',
        prompt: '在原有光线基础上优化为克制的影棚人像质感：增强面部与身体的自然立体层次，控制高光与杂色，服装材质清楚，背景降低视觉干扰；不改变轮廓、妆容、身材或背景内容',
      },
      {
        id: 'portrait-editorial',
        label: '杂志人像',
        desc: '利落高级，色彩准确',
        prompt: '处理为现代杂志人像成片：对比利落但不过硬，色彩准确克制，高光干净，人物轮廓、发丝和服装材质清晰，肤色真实高级；不改变脸型、身材、妆容、动作与环境',
      },
    ],
  },
  {
    id: 'relight',
    name: '光影重塑',
    icon: 'brightness',
    desc: '重新平衡人物与环境光线',
    keepHint: KEEP_PHOTO,
    options: [
      {
        id: 'relight-balance',
        label: '自然补光',
        desc: '主体更亮，环境仍然真实',
        prompt: '根据原图主体、环境与光源方向进行自然补光，提亮人物或主体，打开过深阴影并保护背景高光，使主体与环境曝光平衡；补光必须符合原场景逻辑，不增加可见光源或改变阴影位置',
      },
      {
        id: 'relight-backlight',
        label: '逆光平衡',
        desc: '救回面部，保留轮廓光',
        prompt: '修复逆光照片，自然提亮面部、眼睛与主体暗部，压低背景和天空的过亮区域，保留头发边缘与主体轮廓上的真实逆光，避免抠图边缘和HDR假感',
      },
      {
        id: 'relight-soft',
        label: '柔和光影',
        desc: '减轻硬光和强烈反差',
        prompt: '减弱直射硬光造成的刺眼高光、过深阴影与生硬亮暗交界，让人物和环境的明暗过渡柔和平顺，同时保留立体轮廓、真实肤质和原有光线方向',
      },
      {
        id: 'relight-cinematic',
        label: '立体氛围光',
        desc: '层次更深，主体更突出',
        prompt: '在原照片已有光源与明暗关系上增强主体的立体光影，适度压低背景干扰，丰富中间调与暗部层次，形成克制的摄影氛围；不制造新光源，不改变环境、时段或人物外观',
      },
    ],
  },
  {
    id: 'style',
    name: '风格转换',
    icon: 'palette',
    desc: '一键统一整张照片的质感',
    keepHint: KEEP_PHOTO,
    options: [
      {
        id: 'style-fresh',
        label: '日系清新',
        desc: '明亮轻盈，颜色柔和',
        prompt: '转换为日系清新摄影风格：整体明亮轻盈，低对比、柔和高光、通透阴影，轻微降低饱和度，绿色与蓝色清淡自然，肤色白净但保留健康血色与真实纹理',
      },
      {
        id: 'style-film',
        label: '自然胶片',
        desc: '柔和色彩，细腻颗粒',
        prompt: '转换为自然胶片摄影风格：综合色彩柔和克制，高光顺滑，阴影微微抬起，冷暖关系自然，加入细腻均匀的模拟胶片颗粒与极轻微褪色感，不套用厚重滤镜',
      },
      {
        id: 'style-cinema',
        label: '电影质感',
        desc: '色彩克制，光影有故事',
        prompt: '转换为克制的电影摄影风格：色彩统一且适度低饱和，中间调细腻，高光柔和滚降，黑位有层次，保留自然肤色与少量重点颜色，避免夸张青橙和重滤镜感',
      },
      {
        id: 'style-mono',
        label: '黑白纪实',
        desc: '灰阶丰富，真实有力量',
        prompt: '转换为黑白纪实摄影风格：移除色彩并建立丰富自然的灰阶，突出原有光线、人物神态和材质层次，黑位扎实但不死黑，高光不过曝，加入极轻微真实颗粒',
      },
    ],
  },
  {
    id: 'scene',
    name: '场景出片',
    icon: 'image',
    desc: 'AI按拍摄内容针对性优化',
    keepHint: KEEP_SCENE,
    options: [
      {
        id: 'scene-landscape',
        label: '风景大片',
        desc: '空气通透，远近有层次',
        prompt: '针对自然风景进行成片优化：去除灰雾，增强真实空气透视与远近层次，恢复原有天空、云层、山水和植被细节，色彩鲜活但可信，高光不过曝，不过度锐化',
      },
      {
        id: 'scene-food',
        label: '美食出片',
        desc: '颜色准确，质感诱人',
        prompt: '针对美食照片进行成片优化：校正餐厅混合偏色，使食物颜色准确鲜润，增强原有食材纹理、光泽、温度感和明暗层次，餐具与桌面干净自然，不改变菜品内容',
      },
      {
        id: 'scene-indoor',
        label: '室内通透',
        desc: '空间明亮，窗内外平衡',
        prompt: '针对室内照片进行成片优化：校正灯光偏黄与混合色温，提亮空间中间调，平衡室内与窗外亮度，控制灯具高光，墙面颜色中性，家具材质和空间层次自然清楚',
      },
      {
        id: 'scene-night',
        label: '夜景出片',
        desc: '灯光干净，暗部有层次',
        prompt: '针对城市夜景进行成片优化：控制霓虹、招牌和路灯高光，降低暗部噪点与杂色，恢复建筑和环境层次，黑位干净但不死黑，保留真实冷暖灯光对比与夜色',
      },
    ],
  },
];

/**
 * 拼装顺序：主体锚 → 改动项 → 用户补充 → 多图参考说明 → 保持不变 → 约束行。
 * 主体锚必须最前（前 40 字权重最高）；约束行必须最后，否则容易被后半段的
 * 「参考图说明」冲淡。
 */
export function buildPrompt({
  anchor = ANCHOR_PHOTO,
  item,
  keepHint = KEEP_PHOTO,
  extra = '',
  reference = '',
} = {}) {
  const userText = String(extra || '').trim();
  return [anchor, item && item.prompt, userText, reference, keepHint, CONSTRAINT_TAIL]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('。');
}
