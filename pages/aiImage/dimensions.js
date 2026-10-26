/**
 * 因素菜单的「视图」逻辑（纯逻辑，不含提示词正文）
 *
 * 历史名字叫 dimensions（维度），实际现在管的是生成因素：每个分类下若干因素维度，
 * 每个维度若干取值，取值带一句进提示词的短语。数据全在
 * `config/prompts/aiImage.factors.js`，线上可热更新（见 promptConfig.js）。
 *
 * 这里只做两件事：把选择展开成界面能直接渲染的数据、把选择描述成一句人话。
 * 拼装逻辑在 promptOptions.js。
 *
 * 一个约定：class 串在 JS 侧拼好（opt.cls）。当前基础库对 wx:for 里的判断
 * （包括 class 三元绑定）不可靠，字符串直插才是稳的。
 */
import { getCategoryDims, getFactors, getOrder, getDefault } from './promptConfig';

/** 默认先露出常用、差异明显的选项；完整因素库由用户按需展开。 */
const QUICK_OPTION_IDS = {
  shot: ['auto', 'env', 'full', 'medium', 'medium_close', 'closeup'],
  angle: ['auto', 'eye_level', 'slight_high', 'high', 'low', 'three_quarter', 'phone'],
  dof: ['auto', 'shallow', 'medium', 'deep', 'bokeh'],
  lightDir: ['auto', 'front', 'side', 'back', 'window', 'diffuse'],
  lightQuality: ['auto', 'soft', 'hard', 'high_key', 'low_key', 'golden', 'overcast', 'flash'],
  grade: ['auto', 'natural', 'clean', 'commercial', 'film_warm', 'cinematic', 'cinema_cool', 'cinema_warm', 'bleach_bypass', 'editorial', 'soft_focus', 'muted'],
};

/**
 * 默认选择：所有维度都取配置里的默认值（几乎都是 auto）。
 * 必须深拷贝——配置对象是全局共享的，返回引用会让页面把配置改脏。
 */
export function defaultSelection() {
  const selection = {};
  Object.keys(getFactors()).forEach((key) => {
    selection[key] = getDefault(key);
  });
  return selection;
}

/**
 * 把取值按 option.group 切成连续的组，供界面分段显示。
 *
 * 分组不是新概念，只是把「大远景 / 远景 / 全景」这种同族取值在视觉上挨在一起——
 * 一维十几个取值全平铺，用户得横滑着猜顺序。
 * 没写 group 的取值（auto）归到空名组，界面上就不显示组名。
 *
 * showName 是 JS 侧算好的布尔值：模板里不做任何组合判断
 * （当前基础库对 wx:for 里的表达式判断不可靠，字符串直插才稳）。
 */
function groupOptions(options, showName) {
  const groups = [];
  options.forEach((option) => {
    const name = option.group || '';
    const last = groups[groups.length - 1];
    if (last && last.name === name) {
      last.options.push(option);
    } else {
      groups.push({
        key: name || `g${groups.length}`,
        name,
        showName: showName && Boolean(name),
        options: [option],
      });
    }
  });
  return groups;
}

/**
 * 把某个分类下的维度展开成视图数据。
 *
 * pickedDesc 显示的是「这个选择实际会拼进提示词的那句话」，
 * 而不是形容词——用户能直接看到 AI 收到的内容，比任何描述都可信。
 */
export function buildDimViews(categoryId, selection = {}, expanded = {}) {
  const factors = getFactors();

  return getCategoryDims(categoryId).map((key) => {
    const factor = factors[key];
    if (!factor) return null;

    const pickedId = selection[key] || 'auto';
    const picked = (factor.options || []).find((item) => item.id === pickedId);

    // class 串一律在这里拼好：模板里做判断（含三元）在当前基础库不可靠
    const options = (factor.options || []).map((option) => {
      const selected = option.id === pickedId;
      return {
        id: option.id,
        label: option.label,
        phrase: option.phrase || '',
        group: option.group || '',
        // 库里出现的频率，用来标「主流选择」。不参与拼装，只帮用户判断
        share: option.share || 0,
        selected,
        cls: selected ? 'dchip dchip--on' : 'dchip',
      };
    });

    const quickIds = QUICK_OPTION_IDS[key] || ['auto'];
    const isExpanded = Boolean(expanded[key]);
    let visibleOptions = isExpanded
      ? options
      : options.filter((option) => quickIds.includes(option.id) || option.selected);
    // A new cloud-configured dimension remains usable before quick choices are curated.
    if (visibleOptions.length <= 1 && options.length > 1) visibleOptions = options.slice(0, 6);
    const hasMore = visibleOptions.length < options.length || isExpanded;
    const showGroup = isExpanded && options.length > 8;

    return {
      key,
      name: factor.name,
      hint: factor.hint || '',
      pickedLabel: picked ? picked.label : '',
      pickedDesc: (picked && picked.phrase) || factor.hint || '',
      options,
      groups: groupOptions(visibleOptions, showGroup),
      showGroup,
      expanded: isExpanded,
      hasMore,
      moreText: isExpanded ? '收起' : `全部 ${options.length - 1} 项`,
    };
  }).filter(Boolean);
}

/** 已选了非「不指定」的维度数量，显示在分类 tab 上 */
export function countPicked(categoryId, selection = {}) {
  return getCategoryDims(categoryId).filter((key) => Boolean(selection[key]) && selection[key] !== 'auto').length;
}

/** 已选因素的完整描述，用于「AI 建议」告诉模型这次允许改什么 */
export function describeSelection(selection = {}, factors) {
  const dims = factors || getFactors();
  return getOrder()
    .map((key) => {
      const id = selection[key];
      if (!id || id === 'auto') return '';
      const factor = dims[key];
      const option = factor && (factor.options || []).find((item) => item.id === id);
      return option ? `${factor.name}：${option.label}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * 选择的稳定字符串，用作缓存 key。
 * 按 order 固定顺序拼，漏掉的维度记 auto ——
 * 否则「先改景别再改光位」和「先改光位再改景别」会算成两个 key，同一组选择烧两次模型。
 */
export function selectionKey(selection = {}, order) {
  const seq = order || getOrder();
  return seq.map((key) => `${key}:${selection[key] || 'auto'}`).join('|');
}
