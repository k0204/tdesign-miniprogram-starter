/**
 * 提示词拼装（纯逻辑，不含任何提示词正文）
 *
 * 正文（固定文案 + 每个因素的短语 + 锁定文案）全部来自
 * `config/prompts/aiImage.factors.js`，线上可由云存储热更新，见 promptConfig.js。
 * 这个文件只负责「按固定顺序拼起来」。
 *
 * 拼装顺序不是随便定的，来自 docs 对 803 条成片的归纳：
 *   取景（景别→机位→景深）→ 影调（光位→光质→后期）
 *   → 用户的自由描述 → 参考图说明 → 锁定约束 → 质量底线
 *
 * 前 20 个字决定构图，所以景别与机位必须最先说。
 * 锁定约束必须放在最后（质量底线之前）：中间夹了长句后，早写的限制会被冲淡，
 * 末尾等于每次重新强调一遍——这也是「人物/场景被换掉」最主要的事故来源。
 *
 * 拼装用「，」而不是「。」：语料里 2253 条提示词本身就是逗号串的清单体，
 * 每个短语内部（如「暖色调，偏橙黄，自然饱和」）也自带逗号，连起来才是模型熟悉的形态。
 */
import { getCopy, getFactors, getOrder } from './promptConfig';

/**
 * 把选择拼成「摄影要素」一段。
 *
 * 「不指定」项的 phrase 为空，等于不出现，把决定权留给模型。
 * 空段是合法状态：用户一个因素都不选时，这里就返回空字符串。
 */
export function buildElements(selection = {}, order, factors) {
  const seq = order || getOrder();
  const dims = factors || getFactors();
  const parts = [];

  seq.forEach((key) => {
    const id = selection[key];
    if (!id) return;
    const factor = dims[key];
    if (!factor || !Array.isArray(factor.options)) return;
    const option = factor.options.find((item) => item.id === id);
    if (option && option.phrase) parts.push(option.phrase);
  });

  return parts.filter(Boolean).join('，');
}

/**
 * 拼装整段提示词。
 *
 * 顺序：生成意图 → 摄影要素 → 用户补充 → 参考图说明 → 锁定约束 → 质量底线
 * 约束必须在最后：中间夹了长句后，早写的限制会被冲淡，末尾等于每次重新强调一遍。
 */
export function buildPrompt({ elements, locks = '', extra = '', reference = '', copy } = {}) {
  const c = copy || getCopy() || {};
  const userText = String(extra || '').trim();
  const lockText = String(locks || '').trim();

  return [c.lead, elements, userText, reference, lockText, c.tail]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('。');
}
