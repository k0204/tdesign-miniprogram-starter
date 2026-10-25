# 项目长期约定（konggu/client · 微信小程序）

线上环境 `cloud1-d4g48z822d1300a77`，appid `wx16f3362b82c554fd`。

## 小程序硬性坑（实测）
- **`wx:for` 里禁止数值判断**：`{{index === 0 ? 'a':'b'}}` 恒走假分支（class 绑定同样失效），字符串比较正常。标签/角标一律 JS 侧算好塞进 item。
- **`setData` callback 是下一帧**：派生字段别写进 callback。用 `this.setData(patch); this.derive();`（setData 同步更新 `this.data`）。
- **`wx.cloud.callFunction` 客户端硬限 60s**，`networkTimeout.request` 管不了，超时报 `-501002`。长任务必须两段式：派发秒回 taskId + worker 不 await + 客户端轮询 DB。控制台改函数超时 900s 只解决"函数被杀"。
- 云函数返回单字段上限 ~1MB，生图结果转存云存储返 `fileID`。
- **`<text>` 不能做胶囊按钮**（撑不开宽、文字被裁），一律 `<view>` + flex + 固定 height + `box-sizing:border-box`。

## AI 生图（pages/aiImage）
- 引擎差异只在 `providers.js` 声明，页面禁止 `if (引擎===xxx)`，只看 `sizeMode`/`asyncTask`/`maxImages`/`pickSize`。混元 1 张/exact/同步 30s；Agnes 1-4 张/tier/异步 85-96s；Nexus 1-4 张/exact+`pickNexusSize`/异步。
- 素材唯一写入口 `applyImages(images,{engine,keepResult,error})`，派生字段一次算完。
- 提示词顺序固定：主体锚 → 改动项 → 用户补充 → 多图说明 → 保持不变 → 约束行（必须最后）。多图说明只在 >1 张时插。
- **错误两层**：用户只看 `errors.js` 的 `toFriendlyError → {text,retryable}`；原始错误只 `console.error`。**禁用「稍后重试」这类通用后缀匹配**（会误判队列满），要用专有说法（队列已满/503/429），具体规则排前面。
- **混元水印关不掉只能换文案**：SDK 只暴露 `footnote`（合规，issue #1317）。文案在 `cloudfunctions/imageToImage/index.js` 的 `WATERMARK_TEXT`（当前 `'空谷'`）。**不许裁切/覆盖水印**；Agnes 无水印但不能当规避手段。
- 尺寸按 `engine.pickSize || pickExactSize` 分派。混元（8 倍数、≤1024²）与 gpt-image-2（16 倍数、≤3:1、655K-8.29M）不可互换。`AGNES_RATIOS` 用对数距离吸附。
- 引擎胶囊：两引擎并排；三引擎必须两行（`.engine` column，三等分只摆名字，说明降下一行 `{{desc}} · {{tip}}`，tip 不重复 desc）。

### 混元生图参数
- `HY-Image-v3.0-I2I-ToB-v1.0.1` 属**成长计划免费资源包**：**10 万张 / 6 个月**，只能小程序与云开发服务端调用。
- **prompt 真上限 8192**（官方值）。实测 600 字 8.4s / 3000 字 11.1s / 8192 字 9.4s → **耗时与长度无关**，别再以"长提示词变慢"卡长度。前后端已改 **8192 / 8100**。
- 垫图 ≤10MB、png/jpeg/jpg；宽高 [512,2048]；`footnote` ≤16 字符。**模型支持 0-3 张参考图，我们只传 1 张**。
- **测长 prompt 不能用 `automator` 的 await**：通道自身有响应超时，会先拿 `timeout waiting for automator response`，分不清谁慢。正确：evaluate 里发起即返回、Promise 挂 `globalThis`，隔 75s 再读。

## 混元文本 / 视觉模型（CloudBase 内置）
- `cloud.ai().createModel('cloudbase'|'hunyuan').generateText({model,messages})`，需 wx-server-sdk ≥3.0.5-beta.1（本项目 4.0.2 满足），返回 `{text,messages,usage,error}`。
- **混元纯文本模型不吃图**（`hy4-preview`/`hy3` 图片列都是 ❌）。视觉模型：`hy-vision-2.0-instruct`(44K 快思考)、`t1-vision-20250916`(40K 深度思考)、`turbos-vision-video`(32K 视频)。
- 多模态：`content:[{type:'text',text},{type:'image_url',image_url:{url}}]`，支持公网链接与 base64 data URI。
- 视觉模型按资源点计费，**须控制台确认已开通**。
- `imageToImage` 的 `revise:{value:false}` 关的是混元自带改写。**生图前给建议提示词 = 把 revise 职责显式化交用户确认**，不是新增黑箱。

## 提示词顾问（promptAdvisor · DeepSeek 官方直连）
- **直连 `api.deepseek.com/chat/completions`**，不走 CloudBase 托管模型组（官方直连只有一个变量：Key 配没配）。
- Key 从 `process.env.DEEPSEEK_API_KEY` 读，不返前端，日志用 `maskKey()` 只打前后几位+长度。
- **官方 API 只认 `deepseek-flash`**，传托管侧名字 `deepseek-v4.1-flash` 会 400。顺序 `['deepseek-flash','deepseek-v4.1-flash']`，只在 400/404/422 且报错含 model 时换名。
- **耗时由输出长度决定**：候选各 ~35 字 3.3s、各 ~75 字 5.5s。压时间就压字数。
- **401 响应体是纯文本 `Authentication Fails (governor)` 不是 JSON**：必须 `JSON.parse` 失败后回落 `text`，只读 `json.error.message` 得空串。
- 图片**只能放 `user` 消息**（system/assistant 带图 400）；URL ≤8192 字符、单图 ≤32MiB；base64 计入 48MiB 请求体；每图自动缩到 ~1300×1300、**token 上限 1024**。`detail` 固定 `high`（`low` 省不了 token 却抹平噪点/油光）。
- 兜底链：URL 取图失败（400 且含 image/url/download）→ 下载转 base64 重试一次（15s 预算）。
- **新建云函数默认 `timeout:3`**（`imageToImage` 是 240），模型调用必被杀，**必须控制台改 60s**。
- `cloud_fn_deploy` 首次创建常报 `当前函数处于Creating状态` → 等 20-30s 重发（函数已建好）。
- 探活脚本：`.workbuddy/scripts/probe-promptAdvisor.mjs`。

## 云函数部署（Agnes / Nexus 两段式）
- Agnes `agnesImage`+`agnesImageWorker`(200s)；Nexus `nexusImage`+`nexusImageWorker`。结果写 `ai_image_tasks`，前端 3s 轮询 `{action:'status'}`。
- **云函数互调的 promise ~15s 就失败，不能判任务死**：派发侧 `.catch()` 只记 `dispatchError`，绝不改 status；前端仅在「仍 queued + 有 dispatchError + 超 60s」认定没起来。
- `ai_image_tasks` 由派发侧 `createCollection` 自动建。云函数写入不带 `_openid`，需显式写。
- **每个函数环境变量独立**：只在派发侧配 Key，worker 会报「未配置」，两个都要各配一份。
- **`config.json` 的 `timeout` 对开发者工具通道无效**，已删，超时一律控制台手改。
- **`cloud_fn_deploy` 必须带 `remote-npm-install: true`**，否则 `Cannot find module 'wx-server-sdk'`。
- 返回判定：先 `pending`+`Waiting for user confirmation.`（IDE 弹窗确认），成功后 `{<函数名>:{filesCount,packSize}}`，**没有 "success" 字样**。
- 顺序：先推代码 → 再配环境变量/超时 → 配完不要再部署。报 `Creating`/`Updating` 都是等 20-30s 再试。

## 微信开发者工具 MCP
- **配置在 `~/.workbuddy/mcp.json`（不是 `.mcp.json`）**，已配 `wechat-devtools`。IDE 侧的权威副本在 `C:/Users/Admin/AppData/Local/微信开发者工具/User Data/2ca4252ffa87560ea1fd48b913e45179/Default/mcp.json`，内容为 `command: wechatide` + `args: ["mcp","--token=<36位>"]`。
- **`wechatide` 不在 PATH**：安装器只把 `...\微信web开发者工具\dll` 加进了 PATH，工具根目录没有（重复了两次）。所以必须用绝对路径。根目录下有 `wechatide.cmd` / `wechatidecli.cmd`（都是 `ELECTRON_RUN_AS_NODE` 跑 `resources/app.asar.unpacked/js/common/cli/skill-index.js`）。
- **路径含空格，必须 `cmd.exe` 包一层**：`command: "cmd.exe"`, `args: ["/c", "C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd", "mcp", "--token=..."]`。这样 spawn 能起来，会打印 `stdio bridge started` + `Connected to WechatIDE on port <n>`。
- **它是 NDJSON，不是 LSP 的 Content-Length 头格式**。发 `Content-Length: ...` 会回 `Invalid JSON input`；正确是每行一个 `JSON.stringify(msg) + '\n'`。
- **连接后可能长期返回 `{"code":-32603,"message":"Client authorization pending"}`**：说明 token 被接受（否则报 `MCP Token is missing`）但 IDE 端没放行。需要在 IDE「设置 → 安全设置」里确认 MCP 开关并允许该客户端；仍 pending 就关掉开关重开或重启 IDE（旧 bridge 会攥着连接）。
- 无 token 时该 CLI 的报错原文：`MCP Token is missing. Recopy the MCP config from WeChat DevTools Settings → Security, or pass --token.`
- **优先原生工具**：`mcp__wechat-devtools__*` 用 ToolSearch 载入 + DeferExecuteTool。**别因"没看到工具"就断言没挂载，先搜一次。**
- `automation_evaluate` 可调 `wx.cloud.callFunction`。**`project` 参数必须 `resolve(import.meta.dirname,'../..')`**，写 `resolve('../..')` 会按 cwd 解析报 `PROJECT_CONFIG_JSON_ERROR`。
- **`cloud_query_storage action:"url"` 的 `temporaryUrl` 无效**（403）；取文件用 `cloud_manage_storage action:"download"`。
- **`element_action` 的 class 选择器跨不进自定义组件**（`<#shadow-root>`），只能用属性选择器；合成 touch 不会变 tap；`simulator_open_page` 后上下文指向旧页面，先 `simulator_refresh`；`page_action callMethod` 不可靠，改用 `automation_evaluate` + `getCurrentPages().pop()`。截图固定 363x785，判状态看 `wxml` 的 style/class。
- **内置通道报 `-32603 Bad Request`/`Failed to connect`**：IDE 重启过而 MCP 子进程攥着死管道。用 `.workbuddy/scripts/wechat-call.mjs` 兜底；恢复原生只能重连 MCP。
- 其他兜底：`wechat-mcp.mjs`（`clientInfo.name` 必须是 `probe`）、`wechat-status.mjs`、`deploy-imageToImage.mjs`。

## Nexus 生图
- `https://sub.ainexusplus.com`（OpenAI 兼容、Bearer、`gpt-image-2`）。文生图 `/v1/images/generations`；图生图 `/v1/images/edits` 用 **JSON 不是 multipart**，图放 `images:[{image_url:'data:...'}]`（必须对象数组）。
- **必须带浏览器 User-Agent**，否则 Cloudflare 403（1010）。响应优先 `data[0].b64_json`，其次 `url`/`image_url`/`result_url`（带 UA 下载再转存）。
- 别抄 C# 的 `background:'white'`（照片会被强制白底）。
- 目标 `1536x1024`≈1.57MP，改像素要同步改 `NEXUS_TARGET_PIXELS`/`TARGET_PIXELS`。实测 880x1168→1088x1445；1024x1536→1024x1535（网关归一到 1.57MP）。`low` 33-36s、`high` 单张 **58.8s**，`maxWaitMs` 别低于 90s（现用 200s/3s）。
- 垫图转 base64（临时链接回笼统 400），合计 >15MB 报错。
- **零成本验 key**：提交不存在的 fileID → 缺 key 报「未配置」(240ms)，有 key 卡在 `downloadFile:fail`(392ms)，不产生费用。

## 留言板（pages/leaveMessage + 云函数 leaveMessage）
- **入口彩蛋：连点图片左上角爱心 5 次**（间隔 ≤2000ms 才算同串，计数器跨卡片共用，`onHide` 清零）。卡片上无任何文字提示。事件名必须 `like`（`tap` 会和原生冒泡撞名收两次）。
- 爱心：56rpx 圆 + `rgba(0,0,0,.32)` 托底，未赞 `t-icon-heart`+#fff / 已赞 `heart-filled`+#d54941。点赞纯本地 `card_likes`，**key 用图片地址**（多张卡 desc 同名）。
- 云函数三 action `list`/`create`/`remove`，集合 `leave_messages`。**不返回 `_openid`**，只回 `mine`，归属只在服务端判。
- 图片只存 fileID，目录 `leave-message/YYYYMM/`。**删留言只删路径含 `/leave-message/` 的文件**（一刀切会误删 ai-images）。
- 防连点：查自己最后一条 `createdAt`，2s 内打回。字符数用 `Array.from()`（emoji 算 2）。
- custom navbar + **页面级滚动**（不用 scroll-view）才能用 `onReachBottom`/`enablePullDownRefresh`；输入区 fixed 贴底 + `adjust-position="{{false}}"` + `bindkeyboardheightchange` 改 `bottom`。
- 长按删除归属**从 `this.data.messages` 查**，不读 `data-mine`（dataset 可能变字符串）。
- 加密：文字与昵称**客户端加密**，库里只有 `v1.<base64(iv||ct||mac)>`，云函数无密钥只卡长度。`utils/cipher.js` + `utils/vendor/crypto-js`（+23KB）。`PBKDF2-SHA256(口令,'konggu.leaveBoard.v1',20000)` → 前 32 AES-256-CBC、后 32 HMAC。**IV 不能用 `wx.getRandomValues`**（回调式，同步拿到空 IV）；**`WordArray.create(new Uint8Array)` 是错的**（未引 lib-typedarrays 会把字节当 32 位 word），必须手工大端拼 `fromBytes()`。
- 口令锁：**4 位数字**（默认 `3402`），**没有密码页**，输入框打 4 位数字点发送即校验。**输错一律只 toast「功能未开放」**，原因只 `console.error`。**锁着时界面什么都不显示**（board 整块 `wx:if`，选图静默忽略，`onLoad` 不拉数据）。
- 锁屏自动隐藏：**双通道谁先到谁锁**（页面 `onHide` + `wx.onAppHide`），只挂 App 级会漏（锁屏先走 `onHide`，安卓 App 级回调用可能不来）；`onShow` 判 `_leftAt` >1000ms 先锁再 return；`chooseMedia` 会切后台需 1500ms 豁免；**会话令牌 `_session`** 在 `lockBoard()` 时 +1，各落地回调比对令牌防在途请求灌回内容。
- 实时刷新：`watch` + **12s 增量轮询**兜底。**`watch` 会静默失效**（集合「仅创建者可读写」时只推自己文档、`onError` 不触发），要跨用户必须改「所有用户可读」。**空列表必须退回 `fetchPage(0)`**（`_newestAt=0` 直接 return 会让空板永远刷不出第一条）。滚动 >300px 攒进 `pendingNew` 出浮条，点 `flushNew` 合并回顶；合并统一走 `mergeMessages()`（id 去重 + 倒序）。
- 数据落点：`leave_messages`（`content`/`images`/`nickname`/`createdAt`(ms)/`createTime`），图片进云存储，本地只有 `board_nickname`+`card_likes`。

## 其他
- tabBar 只有 **首页 / 我的**（`custom-tab-bar` + `t-tab-bar`，item 的 `value` 必须等于 `pages/<value>/index`）。**「消息」页签、`pages/message`、`pages/chat`、`mock/chat.js`、`utils/eventBus.js` 已于 2026-10-23 全删**，提到「消息/未读」按不存在处理。
- **包体积（主包 2048KB）**：`output/` 截图会被打进包，已在 `project.config.json` 的 `packOptions.ignore` 排除 `output`/`.workbuddy`/`package-lock.json`/`.md`/`.d.ts`。`miniprogram_npm/tdesign-miniprogram` 约 2MB，`.d.ts`+README 占 647KB、约 30 组件未引用，裁剪脚本 `.workbuddy/scripts/tdesign-prune.mjs`（根集合来自源码引用再按 `../<dir>/` 求闭包，`common/mixins/overlay/popup` 别手删，**`构建 npm` 后要重跑**）。子包图片放子包目录。量体积用 `create_preview_qrcode` 的 `info.size.packages`，比 `du` 准。
- **人脸识别（已决定不做）**：原生 API 要求非个人主体+类目匹配；合规还要求单独同意、不作唯一验证、10 万人起备案。维持口令 + 内容加密。
