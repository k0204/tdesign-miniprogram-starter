/**
 * 后端错误的「人话化」
 *
 * 云函数/网络抛回来的错误不能直接给用户看：
 *   - 里面带 request id、errCode、ESOCKETTIMEDOUT 这类噪音
 *   - 「生图队列已满」是服务端视角，用户不知道自己能做什么
 *
 * 这里只负责翻译和判断「能不能重试」，原始错误由调用方 console.error 打出来。
 * 规则按「越具体越靠前」排列，命中即返回。
 */

const RULES = [
  // 配置类问题：重试没用，别让用户白点
  {
    match: /API Key|鉴权|未配置|401|403|无权限/i,
    text: 'AI 服务暂时不可用，已反馈给技术同学',
    retryable: false,
  },
  // 任务本身丢了
  {
    match: /任务不存在|已过期|任务查询失败/i,
    text: '这次任务已失效，请重新生成',
    retryable: true,
  },
  // 派发没起来（必须排在「队列满」之前：它的原文里也带「稍后重试」）
  {
    match: /派发|dispatch/i,
    text: '任务没能启动，请重试',
    retryable: true,
  },
  // 模型没出图（同样带「稍后重试」，要排在队列规则前）
  {
    match: /未返回图片|没画出来/i,
    text: '这次没画出来，换个效果或补充描述再试',
    retryable: true,
  },
  // 队列拥堵：最常见，且重试有意义。
  // 注意只匹配「队列满 / 503 / 429 / busy」这类专有说法——
  // 早期版本把「稍后重试」也写进来，结果把所有带这句话的错误都误判成队列满。
  {
    match: /队列已满|queue[\s_-]*(is\s*)?full|too many requests|503|429|繁忙|busy/i,
    text: 'AI 通道正忙，稍等几秒再试一次',
    retryable: true,
  },
  // 超时（含前端轮询超时、云函数内部超时）
  {
    match: /超时|timeout|timed out|ESOCKETTIMEDOUT/i,
    text: '这次等太久了，请重试',
    retryable: true,
  },
  // 网络抖动
  {
    match: /网络|request:fail|callFunction:fail|ECONN|断网|offline/i,
    text: '网络不太稳定，检查一下网络再试',
    retryable: true,
  },
  // 素材问题：文案已经能直接看懂，不改写
  {
    match: /10MB|压缩|格式|仅支持|垫图|上传来|未上传成功|导入/i,
    text: '',
    retryable: false,
  },
];

/** 去掉「(request id: xxx)」这类只对排查有用的尾巴 */
function stripNoise(raw) {
  return String(raw || '')
    .replace(/\(?\s*request id[:：]\s*[0-9a-zA-Z-]+\s*\)?/gi, '')
    .replace(/\s*更多错误信息请访问：\S+/g, '')
    .replace(/\s*\(callId:[^)]*\)/g, '')
    .replace(/\s*\(trace:[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} raw 原始错误（errMsg / message）
 * @returns {{ text: string, retryable: boolean }}
 */
export function toFriendlyError(raw) {
  const source = String(raw || '');
  for (let i = 0; i < RULES.length; i += 1) {
    const rule = RULES[i];
    if (rule.match.test(source)) {
      return { text: rule.text || stripNoise(source), retryable: rule.retryable };
    }
  }
  return { text: '生成没成功，请稍后重试', retryable: true };
}
