# 项目长期约定（konggu/client · 微信小程序）

线上环境 `cloud1-d4g48z822d1300a77`，appid `wx16f3362b82c554fd`。tabBar 只有 首页/我的（「消息」页与 chat/eventBus 已于 2026-10-23 删除）。

## 小程序硬性坑
- `wx:for` 内禁止数值判断（`index === 0` 恒假，class 绑定同样失效），派生态一律 JS 侧算好塞进 item。
- `setData` callback 是下一帧，派生字段别写进 callback，用 `this.setData(patch); this.derive();`。
- `wx.cloud.callFunction` 客户端硬限 60s（超时 `-501002`），长任务两段式：派发秒回 taskId + worker 不 await + 前端轮询 DB。云函数返回单字段上限 ~1MB，图转存云存储返 fileID。
- `<text>` 不能做胶囊按钮，用 `<view>` + flex + 固定 height + `box-sizing:border-box`。
- 改完模块 import 必须核对导出名并 grep 使用处，漏一个 import 整页 ReferenceError。
- 包体积主包 2048KB：`packOptions.ignore` 排除 `output`/`.workbuddy`/`package-lock.json`/`.md`；`tdesign-miniprogram` 约 2MB，用 `.workbuddy/scripts/tdesign-prune.mjs` 裁剪（`common/mixins/overlay/popup` 别手删，构建 npm 后要重跑）。量体积看 `create_preview_qrcode` 的 `info.size.packages`。

## AI 修图（pages/aiImage）
- 引擎差异只在 `providers.js` 声明，页面禁写 `if (引擎===xxx)`，只看 `sizeMode`/`asyncTask`/`maxImages`/`pickSize`。混元 1 张/exact/同步；Agnes 1-4 张/tier/异步 85-96s；Nexus 1-4 张/exact/异步。
- 素材唯一写入口 `applyImages(...)`。错误两层：用户只看 `errors.js` 的 `toFriendlyError`，**禁用「稍后重试」这类通用后缀匹配**。
- 尺寸按 `engine.pickSize || pickExactSize`，混元（8 倍数、≤1024²）与 gpt-image-2（16 倍数、≤3:1）不可互换。
- 混元水印关不掉只能换文案：SDK 只暴露 `footnote`，在 `cloudfunctions/imageToImage/index.js` 的 `WATERMARK_TEXT`，不许裁切覆盖。

### 提示词 = 生成因素库（v9）
- 2 分类 / 6 维 / 91 取值（含 6 auto）/ 4 锁；原则：只新增 1 个选项，其余改已有文案。
- 顺序：景别→机位→景深→光位→光质→后期。已下线 6 个（场景/天气/前景/色温/色调/情绪）。判据：**只留改「怎么拍」的，不留改「拍什么」的**。
- 「模糊背景」归景深（`dof.shallow` label 改「背景虚化」）；「高级灰」归后期（`grade.editorial`）；新增「冷调清透」`grade.cool_clean`。
- 每个取值带 `group`，`dimensions.js` 的 `groupOptions()` 按相邻同组切块；取值 >8 个才显组名。每维第一项必须 auto；「已选 N 项」只遍历 order，不能 `Object.keys(selection)`。
- 拼装：`lead → 六因素短语 → 用户补充 → 参考图说明 → 锁定段 → tail`，段内「，」段间「。」，phrase 与锁文案不能有句号。全选 106 字，默认整段 287 字。
- 锁定是独立一层（`copy.keep` 已删），默认开 `locks.person` + 锁场景；文案可编辑存 `aiimage_lock_prefs_v1`，`locks.js` 的 `buildLockText()` 拼装。互斥提醒在 `detectLockTip()`，只提示不改用户选择。
- 零选择合法（只剩 lead/锁定段/tail）。输入框是自由提示词入口（maxlength 600）。

### 配置外置 + 云存储热更新
- 唯一手写来源 `config/prompts/aiImage.factors.js`。链路：内置 → storage `aiimage_prompt_cfg_v2` → 云存储 `prompts/aiImage.factors.json`，只认 version 更大。onLoad 先同步渲染，异步拉到新版才重建菜单，不重置已选。
- `validateConfig` 全量校验、全有或全无（schema/version/锁结构/每维首项 auto/order 与 dims 双向覆盖等），任一不过整份丢弃。
- 改三步：改 factors.js（version +1）→ `build-prompt-config.mjs` → `upload-prompt-config.mjs`。构建比对 hash，内容变版本没升直接失败。**当前内置/云端 v9 / hash 9ac79e6a**。
- `cloud_manage_storage` 写操作返回 `pending`+taskId 是在等 IDE 弹窗确认，不是成功；用 `polling_task_result` 轮询，最终以脚本读回 version/hash 为准。
- 回归：`verify-aiimage-menu.mjs`（配置/锁/分组/拼装/坏配置拒收）+ `verify-aiimage-page.mjs`（真实 import 页面跑 onLoad，抓接线）。坏配置用例别写死维度名，用 `ORDER[ORDER.length-1]`。
- `build-factors-config.mjs` 已落后 v9，默认拒绝执行，需 `--force`。

## 生图参数
- 混元 `HY-Image-v3.0-I2I-ToB-v1.0.1`：免费包 10 万张/6 个月，仅小程序 + 云开发服务端；**prompt 上限 8192**（前后端已改 8192/8100），耗时与长度无关，约 8-11s。垫图 ≤10MB、宽高 [512,2048]、只传 1 张。测长耗时不能用 automator 的 await，Promise 挂 `globalThis` 隔 75s 再读。
- Nexus `https://sub.ainexusplus.com`（OpenAI 兼容、Bearer、gpt-image-2）。图生图 `/v1/images/edits` 用 **JSON 不是 multipart**，图放 `images:[{image_url:'data:...'}]`；**必须带浏览器 User-Agent**（否则 Cloudflare 403）。目标 ~1.57MP，`low` 33-36s / `high` 58.8s，maxWaitMs ≥90s。零成本验 key：提交不存在的 fileID，缺 key 报「未配置」。

## 提示词顾问（promptAdvisor · DeepSeek 直连）
- 直连 `api.deepseek.com/chat/completions`。**官方 API 只认 `deepseek-flash`**（托管名 400），顺序 `['deepseek-flash','deepseek-v4.1-flash']`，只在 400/404/422 且含 model 时换。401 响应体是纯文本，JSON.parse 失败要回落 text。
- 图片只能放 user 消息，每图缩到 ~1300×1300、token 上限 1024、`detail:'high'`；URL 取图失败转 base64 重试一次。
- **新建云函数默认 timeout:3**，模型调用必被杀，控制台改 60s。探活 `.workbuddy/scripts/probe-promptAdvisor.mjs`。

## 云函数部署
- Agnes `agnesImage`+`agnesImageWorker`(200s)；Nexus `nexusImage`+`nexusImageWorker`。结果写 `ai_image_tasks`，前端 3s 轮询 `{action:'status'}`。
- 云函数互调 promise ~15s 就失败，不能判任务死：派发侧只记 `dispatchError`，前端仅在「仍 queued + 有 dispatchError + 超 60s」认定没起来。
- 每个函数环境变量独立（派发侧与 worker 各一份）。`config.json` 的 timeout 对开发者工具通道无效，超时控制台手改。
- `cloud_fn_deploy` 必须带 `remote-npm-install: true`（否则 Cannot find module wx-server-sdk）。返回先 `pending`，没有 success 字样，报 Creating/Updating 等 20-30s 再试。

## 微信开发者工具 MCP
- `~/.workbuddy/mcp.json`；`wechatide` 不在 PATH，必须 `cmd.exe /c "C:\Program Files (x86)\Tencent\微信web开发者工具\wechatide.cmd"`。NDJSON 协议；`-32603 Client authorization pending` = IDE 未放行。
- **IDE 进程没起来时 `initialize` 直接 60s timeout**、内置通道报 `-32603 Bad Request`——先确认 IDE 窗口真的开着。
- `cloud_db_read_doc` 的 `sort` 只接受数组 `[{"key":"createdAt","direction":-1}]`。
- 兜底通道 `.workbuddy/scripts/wechat-call.mjs`（底层 `wechat-mcp.mjs`，clientInfo.name 必须是 `probe`）；参数多时用 `@params.json`。
- `cloud_query_storage action:"url"` 的 temporaryUrl 无效（403），取文件用 `cloud_manage_storage action:"download"`。`automation_evaluate` 的 project 必须绝对路径，上下文常停在首页需先 navigateTo。
- `simulator_screenshot` 偶发切回首页，操作前用 `ensurePage()` 重新 reLaunch；弹层打开时不要 tap `.mask`（会 timeout 并关掉项目窗口）。
- AI 修图页走查 `.workbuddy/scripts/verify-aiimage-live.mjs`，截图落 `.workbuddy/out/`。

## 留言板（pages/leaveMessage + 云函数 leaveMessage）
- 入口彩蛋：连点图片左上角爱心 5 次（间隔 ≤2000ms），事件名必须 `like`。
- 云函数 action `unlock`/`list`/`create`/`remove`，集合 `leave_messages`，不返回 `_openid` 只回 `mine`（归属校验在服务端）；图片存 fileID，目录 `leave-message/YYYYMM/`，删留言只删路径含 `/leave-message/` 的文件。
- 防连点 2s；字符数用 `Array.from()`。custom navbar + 页面级滚动才能用 `onReachBottom`/下拉刷新；输入区 fixed 贴底 + `adjust-position="{{false}}"`。
- 加密：客户端加密，库里只有 `v1.<base64(iv||ct||mac)>`；`PBKDF2-SHA256(口令,'konggu.leaveBoard.v1',20000)` → 前 32 AES-CBC、后 32 HMAC。**IV 不能用 `wx.getRandomValues`**，`WordArray.create(new Uint8Array)` 也错，要手工大端拼 `fromBytes()`。
- 口令锁 4 位（默认 3402），输错统一 toast「功能未开放」。锁屏双通道（页面 `onHide` + `wx.onAppHide`）+ 会话令牌 `_session` 防在途请求灌回。
- 实时刷新 `watch` + 12s 增量轮询；`watch` 在「仅创建者可读写」时静默失效，跨用户需「所有用户可读」；空列表必须退回 `fetchPage(0)`。
- 人脸识别已决定不做（合规成本高），维持口令 + 内容加密。
