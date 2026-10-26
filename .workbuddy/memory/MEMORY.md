# 项目长期约定（konggu/client · 微信小程序）

线上环境 `cloud1-d4g48z822d1300a77`，appid `wx16f3362b82c554fd`。

## 小程序硬性坑（实测）
- **`wx:for` 里禁止数值判断**：`{{index === 0 ? 'a':'b'}}` 恒走假分支（class 绑定同样失效），字符串比较正常。标签/角标/class 串一律 JS 侧算好塞进 item。布尔字段也一样，在 JS 里拼成 `showName`。
- **`setData` callback 是下一帧**：派生字段别写进 callback。用 `this.setData(patch); this.derive();`。
- **`wx.cloud.callFunction` 客户端硬限 60s**，`networkTimeout.request` 管不了，超时报 `-501002`。长任务必须两段式：派发秒回 taskId + worker 不 await + 客户端轮询 DB。
- 云函数返回单字段上限 ~1MB，生图结果转存云存储返 `fileID`。
- **`<text>` 不能做胶囊按钮**（撑不开宽、文字被裁），一律 `<view>` + flex + 固定 height + `box-sizing:border-box`。
- **改完模块 import 必须核对**：漏一个 import，`onLoad → refreshPreview` 直接 ReferenceError 整页崩，静态复刻查不出来。先列出导出名 grep 使用处，或真机跑一次。

## AI 修图（pages/aiImage）
- 引擎差异只在 `providers.js` 声明，页面禁止 `if (引擎===xxx)`，只看 `sizeMode`/`asyncTask`/`maxImages`/`pickSize`。混元 1 张/exact/同步；Agnes 1-4 张/tier/异步 85-96s；Nexus 1-4 张/exact/异步。
- 素材唯一写入口 `applyImages(...)`。**错误两层**：用户只看 `errors.js` 的 `toFriendlyError → {text,retryable}`，**禁用「稍后重试」这类通用后缀匹配**（会误判队列满），具体规则排前面。
- 尺寸按 `engine.pickSize || pickExactSize` 分派；混元（8 倍数、≤1024²）与 gpt-image-2（16 倍数、≤3:1）不可互换。
- **混元水印关不掉只能换文案**：SDK 只暴露 `footnote`，文案在 `cloudfunctions/imageToImage/index.js` 的 `WATERMARK_TEXT`。不许裁切/覆盖。

### 提示词 = 生成因素库，不是修图条件
用户纠正过两次，别再往菜单里加 issue / focus / strength / texture，也别按「条件+强度」做。

- **v9 = v8 + 高级感收敛（2026-10-26）**：2 分类 / 6 维 / **91 取值**（含 6 auto）/ 4 锁。原则是**只新增 1 个选项，其余改已有文案**。
- **只新增「冷调清透」`grade.cool_clean`**（语料 4.9%）：冷而干净、细节锐利、整体冷静克制；不新增暗角/奶油调/冷调高级灰，避免列表变长。
- **已有选项升级**：`muted` 低饱和 → 「低饱和胶片」（补柔和低对比+颗粒，语料 15%）；`soft_focus` 柔焦朦胧 → 「柔光镜」（高光泛开、皮肤柔润）；`commercial` 商业精修补「高光细腻有光泽」。
- **「模糊背景」归景深**：`dof.shallow` 的 label 从「浅景深」改成「背景虚化」，id 不变；进提示词的正文仍是「浅景深，背景柔和虚化，人物保持清晰，主次分明」。想要更糊选「极浅景深 / 光斑背景」，不要新开维度。
- **「高级灰」进后期**：`grade.editorial`，风格组，短语「高级灰调，低饱和高细节，柔和反差，肤色自然不灰脏」。它是「显高级」最稳的方向：不压暗、不偏色，和暗调压缩/电影感区分开。
- **已下线 6 个**：场景 / 天气 / 前景 / 色温 / 色调 / 情绪。理由：改场景=换背景身份必崩；前景 95.5% 是「无遮挡」等于单选；色温·色调·后期·光质四重重叠，同义句稀释权重；情绪是形容词模型接不住。判据：**只留改「怎么拍」的，不留改「拍什么」的**。
- **每个取值带 `group`**（大景/中景/近景、高低/方位/随手拍、虚实/特殊…），界面按相邻同组切块渲染组名，`dimensions.js` 的 `groupOptions()` 负责；新增取值只要带 group 就自动归位。取值 >8 个才显组名。
- **拼装**：`lead → 六因素短语（景别→机位→景深→光位→光质→后期）→ 用户补充 → 参考图说明 → 锁定段 → tail`。段内「，」段间「。」。**phrase 与锁文案里不能有句号**。全选 106 字 / 整段（默认锁人物+场景）287 字。
- **锁定是独立一层**：`copy.keep` 已删除，人物身份改由默认开启的 `locks.person` 负责。锁文案页面可编辑，存 `aiimage_lock_prefs_v1`（开关 + 文案），配置升级按 id 保留；`locks.js` 的 `buildLockText()` 统一拼装。默认锁场景避免了 v6「改场景必崩」——场景维度已下线，不冲突。
- **零选择合法**：auto 短语为空，只剩 lead/锁定段/tail；锁全关则只剩 lead/tail。**输入框是自由提示词入口**（maxlength 600），不是附件。
- 每维第一项必须 auto。「已选 N 项」统计**只遍历 order**，不能 `Object.keys(selection)`（热更新删维度后残留 key 会算进去）。
- **互斥提醒**：背面/剪影/大远景/局部特写 与「锁定人物」打折或失效；浅景深/局部特写 与「锁定场景」冲突。只提示不替用户改选择，文案在 `locks.js` 的 `detectLockTip()`。文档 `docs/提示词六参数-2026-10.md` 有完整分析。
- 故意丢掉：generic 取值（scene 61% 是标注默认值）、构图与画幅（图生图改构图=重排画面，画幅和输出比例逻辑打架）。

### 配置外置 + 云存储热更新
- **唯一手写来源 `config/prompts/aiImage.factors.js`**（schema `aiImage.factors` + version）。旧修图版 `aiImage.default.js` 在 `.workbuddy/legacy/`。
- 链路：内置默认 → storage `aiimage_prompt_cfg_v2` → 云存储 `prompts/aiImage.factors.json`，**只认 version 更大的**。onLoad 先同步渲染，异步拉到新版才重建菜单，**不重置已选**。
- `validateConfig` **全量校验、全有或全无**：schema/version/copy 两端文案/locks 结构与唯一 id/每维第一项 auto/order 与 dims 双向覆盖/categories 引用存在/defaults 在选项内，任一不过整份丢弃。锁文案带句号也会被拒（会打断「。」分段）。
- `wx.cloud.downloadFile` **只认完整 fileID**，前缀硬编码在 `promptConfig.js`。
- 改三步：改 factors.js（**version +1**）→ `build-prompt-config.mjs` → `upload-prompt-config.mjs`。构建比对内容 hash，内容变版本没升直接失败。**当前内置/云端 v9 / hash 9ac79e6a**（云存储读回一致）。
- **`cloud_manage_storage` 写操作返回 `pending`+taskId 不是成功**，是在等 IDE 弹窗点确认；用 `polling_task_result` 轮询。别靠轮询判结果，脚本会读回比对 version/contentHash。云存储读写要 IDE 登录态。
- 回归两个脚本：`verify-aiimage-menu.mjs`（配置/锁/分组/拼装/3000 组随机/坏配置拒收/版本只升不降）+ `verify-aiimage-page.mjs`（真实 import 页面并跑 onLoad/锁编辑/因素选择，专抓模块接线）。**坏配置用例别写死维度名**（维度下线后检查会静默失效），用 `ORDER[ORDER.length-1]`。
- `build-factors-config.mjs` 已落后于 v9（会生成旧的 3 分类结构），**默认拒绝执行**，必须加 `--force` 才会跑；日常改文案只改 factors.js。

### 混元生图参数
- `HY-Image-v3.0-I2I-ToB-v1.0.1` 属成长计划免费包：**10 万张 / 6 个月**，只能小程序与云开发服务端调用。**prompt 真上限 8192**，实测耗时与长度无关（600/3000/8192 字 → 8.4/11.1/9.4s）。前后端已改 8192 / 8100。
- 垫图 ≤10MB、png/jpeg/jpg；宽高 [512,2048]；模型支持 0-3 张参考图，我们只传 1 张。
- **测长耗时不能用 `automator` 的 await**（通道自带响应超时）：evaluate 里发起即返回、Promise 挂 `globalThis`，隔 75s 再读。

## 提示词顾问（promptAdvisor · DeepSeek 直连）
- 直连 `api.deepseek.com/chat/completions`，不走 CloudBase 托管组。Key 读 `DEEPSEEK_API_KEY`，日志 `maskKey()`。
- **官方 API 只认 `deepseek-flash`**，托管名会 400。顺序 `['deepseek-flash','deepseek-v4.1-flash']`，只在 400/404/422 且含 model 时换。
- **耗时 ∝ 输出长度**（35 字 3.3s / 75 字 5.5s）。**401 响应体是纯文本 `Authentication Fails (governor)`**，`JSON.parse` 失败要回落 `text`。
- 图片只能放 `user` 消息；URL ≤8192 字符、单图 ≤32MiB、base64 计入 48MiB；每图缩到 ~1300×1300、token 上限 1024，`detail` 固定 `high`。URL 取图失败 → 转 base64 重试一次（15s 预算）。
- **新建云函数默认 `timeout:3`**，模型调用必被杀，必须控制台改 60s。探活 `.workbuddy/scripts/probe-promptAdvisor.mjs`。

## 云函数部署
- Agnes `agnesImage`+`agnesImageWorker`(200s)；Nexus `nexusImage`+`nexusImageWorker`。结果写 `ai_image_tasks`，前端 3s 轮询 `{action:'status'}`。
- **云函数互调的 promise ~15s 就失败，不能判任务死**：派发侧 `.catch()` 只记 `dispatchError`，前端仅在「仍 queued + 有 dispatchError + 超 60s」认定没起来。
- **每个函数环境变量独立**，派发侧与 worker 各配一份。**`config.json` 的 timeout 对开发者工具通道无效**，超时一律控制台手改。
- **`cloud_fn_deploy` 必须带 `remote-npm-install: true`**，否则 `Cannot find module 'wx-server-sdk'`。返回先 `pending`，成功后 `{<函数名>:{filesCount,packSize}}`，没有 success 字样。报 Creating/Updating 等 20-30s 再试。

## 微信开发者工具 MCP
- 配置 `~/.workbuddy/mcp.json`（不是 `.mcp.json`）。**`wechatide` 不在 PATH**，必须 `cmd.exe` + `/c` + `C:\Program Files (x86)\Tencent\微信web开发者工具\wechatide.cmd`（路径含空格，直接 spawn .cmd 会 EINVAL）。
- **NDJSON，不是 LSP 的 Content-Length 头**；`-32603 Client authorization pending` = IDE 未放行，去「设置 → 安全设置」允许。
- **优先原生工具**：`mcp__wechat-devtools__*` 用 ToolSearch 载入 + DeferExecuteTool。别因"没看到工具"就断言没挂载。
- **`APPID_ERROR / 需要重新登录` = IDE 登录态失效**，所有 IDE 侧工具全废。用 `login` 工具现场弹码：`{"type":"image"}` 直接返回二维码图片，返 `taskId`，扫码后轮询。
- `automation_evaluate` 的 `project` 必须是绝对路径；**evaluate 上下文常停在首页**（`getCurrentPages()` 里没有刚打开的页面），先在 evaluate 里 `wx.navigateTo` 再操作，且导航是异步的——同一批调用里返回的栈还是旧的。`cloud_query_storage action:"url"` 的 temporaryUrl 无效（403），取文件用 `cloud_manage_storage action:"download"`。
- `element_action` 的 class 选择器跨不进自定义组件，只能用属性选择器；`simulator_open_page` 后上下文指向旧页面，先 `simulator_refresh`；截图固定 363x785（当前 387x836）。
- 内置通道报 `-32603 Bad Request`/`Failed to connect`：用 `.workbuddy/scripts/wechat-call.mjs` 兜底（另有 `wechat-mcp.mjs`，`clientInfo.name` 必须是 `probe`）。**PowerShell 会吃掉内联 JSON 的双引号**，参数多时用 `@params.json`（wechat-call 已支持）。
- **`simulator_screenshot` 偶发把模拟器切回首页**：截图后先重新确认 `getCurrentPages().pop().route`，开弹层/继续操作前用 `ensurePage()` 重新 reLaunch。**弹层打开时不要 tap `.mask`**：automator 会 timeout 并连带关掉项目窗口（实测）。
- AI 修图页真机走查用 `.workbuddy/scripts/verify-aiimage-live.mjs`（liteMode + reLaunch + 4 张截图 + 控制台 error 检查）；截图落 `.workbuddy/out/aiImage-*.png`。

## Nexus 生图
- `https://sub.ainexusplus.com`（OpenAI 兼容、Bearer、`gpt-image-2`）。图生图 `/v1/images/edits` 用 **JSON 不是 multipart**，图放 `images:[{image_url:'data:...'}]`。
- **必须带浏览器 User-Agent**，否则 Cloudflare 403。别抄 C# 的 `background:'white'`（照片会被强制白底）。
- 目标 ~1.57MP；`low` 33-36s、`high` 58.8s，`maxWaitMs` ≥90s。垫图转 base64，合计 >15MB 报错。
- **零成本验 key**：提交不存在的 fileID → 缺 key 报「未配置」(240ms)，有 key 卡在 `downloadFile:fail`(392ms)。

## 留言板（pages/leaveMessage + 云函数 leaveMessage）
- **入口彩蛋：连点图片左上角爱心 5 次**（间隔 ≤2000ms，`onHide` 清零）。事件名必须 `like`（`tap` 会撞名收两次）。
- 云函数三 action `list`/`create`/`remove`，集合 `leave_messages`，**不返回 `_openid`**，只回 `mine`。图片存 fileID，目录 `leave-message/YYYYMM/`，删留言只删路径含 `/leave-message/` 的文件。
- 防连点：查自己最后一条 `createdAt`，2s 内打回。字符数用 `Array.from()`；长按删除的归属从 `this.data.messages` 查。
- custom navbar + **页面级滚动**才能用 `onReachBottom`/`enablePullDownRefresh`；输入区 fixed 贴底 + `adjust-position="{{false}}"` + `bindkeyboardheightchange`。
- 加密：客户端加密，库里只有 `v1.<base64(iv||ct||mac)>`。`PBKDF2-SHA256(口令,'konggu.leaveBoard.v1',20000)` → 前 32 AES-CBC、后 32 HMAC。**IV 不能用 `wx.getRandomValues`**；`WordArray.create(new Uint8Array)` 是错的，要手工大端拼 `fromBytes()`。
- 口令锁：4 位数字（默认 `3402`），无密码页，输入框打 4 位点发送即校验，输错统一 toast「功能未开放」，锁着时界面什么都不显示。
- 锁屏隐藏：**双通道谁先到谁锁**（页面 `onHide` + `wx.onAppHide`）；`onShow` 判 `_leftAt` >1000ms 先锁再 return；`chooseMedia` 需 1500ms 豁免；会话令牌 `_session` 防在途请求灌回已清空页面。
- 实时刷新：`watch` + 12s 增量轮询兜底。**`watch` 会静默失效**（集合「仅创建者可读写」时只推自己文档），跨用户要改「所有用户可读」。**空列表必须退回 `fetchPage(0)`**。

## 其他
- tabBar 只有 首页 / 我的。**「消息」页签、`pages/message`、`pages/chat`、`mock/chat.js`、`utils/eventBus.js` 已于 2026-10-23 全删**。
- **包体积（主包 2048KB）**：`packOptions.ignore` 已排除 `output`/`.workbuddy`/`package-lock.json`/`.md`。`miniprogram_npm/tdesign-miniprogram` 约 2MB，裁剪脚本 `.workbuddy/scripts/tdesign-prune.mjs`（`common/mixins/overlay/popup` 别手删，**构建 npm 后要重跑**）。量体积用 `create_preview_qrcode` 的 `info.size.packages`。
- **人脸识别已决定不做**：原生 API 要非个人主体+类目匹配，合规还要单独同意、10 万人起备案。维持口令+内容加密。
