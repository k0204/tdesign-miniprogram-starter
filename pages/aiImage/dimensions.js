/**
 * 因素菜单的「视图」逻辑（纯逻辑，不含提示词正文）
 *
 * 历史名字叫 dimensions（维度），实际现在管的是生成因素：每个分类下若干因素维度，
 * 每个维度若干取值，取值带一句进提示词的短语。数据全在
 * `config/prompts/aiImage.factors.js`，线上可热更新（见 promptConfig.js）。
 *
 * 这里只做两件事：把选择整理成下拉控件数据、把选择描述成一句人话。
 * 拼装逻辑在 promptOptions.js。
 *
 */
import { getCategoryDims, getFactors, getOrder, getDefault } from './promptConfig';

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
 * 将某个分类下的因素整理成下拉选择器数据。
 *
 * pickedDesc 显示的是「这个选择实际会拼进提示词的那句话」，
 * 而不是形容词——用户能直接看到 AI 收到的内容，比任何描述都可信。
 */
export function buildDimViews(categoryId, selection = {}) {
  const factors = getFactors();

  return getCategoryDims(categoryId).map((key) => {
    const factor = factors[key];
    if (!factor) return null;

    const pickedId = selection[key] || 'auto';
    // class 串一律在这里拼好：模板里做判断（含三元）在当前基础库不可靠
    const options = (factor.options || []).map((option) => {
      const selected = option.id === pickedId;
      return {
        id: option.id,
        label: option.label,
        phrase: option.phrase || '',
        selected,
      };
    });

    const pickedIndex = Math.max(0, options.findIndex((option) => option.id === pickedId));
    const picked = options[pickedIndex];

    return {
      key,
      name: factor.name,
      hint: factor.hint || '',
      pickedLabel: picked ? picked.label : '',
      pickedDesc: (picked && picked.phrase) || factor.hint || '',
      pickedIndex,
      options,
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
