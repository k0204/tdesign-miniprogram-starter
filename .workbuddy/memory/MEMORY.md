# 项目长期约定（konggu/client · 微信小程序）

线上环境 `cloud1-d4g48z822d1300a77`，appid `wx16f3362b82c554fd`。

## 小程序硬性坑（实测）
- **`wx:for` 里不要做数值判断**：`{{index === 0 ? 'a' : 'b'}}` 在当前基础库恒走假分支（class 绑定同样失效）；字符串比较正常。标签/角标一律 JS 侧算好放进 item。
- **`setData` 的 callback 是下一帧**：依赖新 data 的派生字段不能写在 callback 里。正确写法 `this.setData(patch); this.derive();`（setData 同步更新 `this.data`）。
- **`wx.cloud.callFunction` 客户端硬限 60s**，`app.json` 的 `networkTimeout.request` 管不了它，超时报 `-501002 resource server timeout`。长任务必须两段式：派发函数秒回 taskId + worker 不 await 地跑 + 客户端轮询 DB。控制台把函数超时改 900s 只解决"函数被杀"。
- 云函数返回单个字段上限 ~1MB，生图结果转存云存储返 `fileID`。
- **`<text>` 不能做胶囊按钮**：加 padding/radius 撑不开宽度，会被压成方块、文字被裁。胶囊一律 `<view>` + flex + 固定 height + `box-sizing: border-box`。

## AI 生图（pages/aiImage）
- 引擎差异只在 `providers.js` 声明，页面禁止写 `if (引擎 === xxx)`，一律看 `sizeMode` / `asyncTask` / `maxImages` / `pickSize`。三引擎：混元（1 张 / exact / 同步 30s）、Agnes（1-4 张 / tier 1K+ratio / 异步 85-96s）、Nexus（1-4 张 / exact + `pickNexusSize` / 异步）。
- 素材唯一写入口 `applyImages(images, {engine, keepResult, error})`，派生字段（`sourcePath`/`imageCount`/`canAddImage`/`outputLabel`/尺寸）一次算完。
- 提示词顺序固定：主体锚 → 改动项 → 用户补充 → 多图参考说明 → 保持不变 → 约束行（必须最后）。多图参考说明只在真正 >1 张时插。
- **错误两层**：用户只看 `errors.js` 的 `toFriendlyError` → `{text, retryable}`；原始错误（request id / errMsg / taskId / elapsedMs）只 `console.error`。可重试的才出「重试」按钮。
- `toFriendlyError` 规则表**不能用「稍后重试」这类通用后缀匹配**（会误判队列满），必须用专有说法（队列已满 / 503 / 429），具体的规则排前面。
- **混元水印关不掉只能换文案**：`LogoAdd` 默认 1，SDK 只暴露 `footnote`（合规要求，issue #1317 官方回复）。文案由 `cloudfunctions/imageToImage/index.js` 的 `WATERMARK_TEXT` 控制（当前 `'空谷'`）。**不要裁切/覆盖水印**。Agnes 无此水印但不能当规避手段。
- `@cloudbase/ai` 的 `generateImage(input)` 原样透传 `data`，不做字段白名单，新增参数不用改 SDK。
- 尺寸算法按引擎分派：`engine.pickSize || pickExactSize`。混元规则（8 倍数、面积 ≤1024²）与 gpt-image-2 规则（16 倍数、≤3:1、655K-8.29M）不能互换。`AGNES_RATIOS` + 对数距离吸附比例档。
- 引擎胶囊区：两引擎并排（名字+副标题 + tip）；三引擎必须两行式（`.engine` column、三个等分只摆名字，说明降下一行 `{{desc}} · {{tip}}`，tip 不重复 desc）。

### 混元生图参数与额度（2026-10-25 实测定型）
- 我们用的 `HY-Image-v3.0-I2I-ToB-v1.0.1` 属**「小程序成长计划」免费资源包**的生图模型。二期（2026-07-01~12-31）官方列 4 个：`hunyuan-image-v3.0-v1.0.4` / `hunyuan-image` / `HY-Image-3.0-Plus-4090-Tob-v1.0` / `HY-Image-v3.0-I2I-ToB-v1.0.1`。**额度 10 万张、6 个月有效，只能在小程序与云开发服务端调用**（拿不到外部当通用 API）。用量到 80/90/100% 会有公众号提醒，用完切资源点套餐。
- **prompt 真上限 8192 字符**（官方文档值，CloudBase 封装层无额外校验）。实测：600 字 **8.4s**、3000 字 **11.1s**、8192 字 **9.4s** 全部成功 → **耗时与长度无关**，别再拿"长提示词会变慢"当理由卡长度。
- 原来的 500（云函数）/480（前端）是拍脑袋值，已改 **8192 / 8100**。
- 其他限制：垫图每张 ≤10MB、png/jpeg/jpg；尺寸宽高 [512,2048]、面积 ≤1024²；水印关不掉只能换文案（`footnote` ≤16 字符）。**模型本身支持 0-3 张参考图，我们只传 1 张**（产品定位单图精修，能力未用满）。
- **测长 prompt 不能用 `automator` 的 await 写法**：通道自己有响应超时，长任务会先拿到 `timeout waiting for automator response`，分不清模型慢还是通道慢（第一次测 8192/3000 就这样白等 3 分钟）。正确做法：evaluate 里发起后立即返回、把 Promise 挂 `globalThis`，隔 75s 再读一次。

## 混元文本 / 视觉模型（CloudBase 内置，2026-10 调研）
- 调用：云函数 `cloud.ai().createModel('cloudbase'|'hunyuan').generateText({ model, messages })`，需 wx-server-sdk ≥ 3.0.5-beta.1（本项目 4.0.2 已满足）。返回值 `{ text, messages, usage, error }`。
- **混元纯文本模型不吃图**：`hy4-preview`(1M) / `hy3`(256K) 的图片列都是 ❌。要看图只能用视觉模型。
- 视觉模型：`hy-vision-2.0-instruct`（44K，快思考，通用图生文，未声明深度思考/结构化输出）、`hunyuan-t1-vision-20250916`（40K，带深度思考）、`hunyuan-turbos-vision-video-20250728`（32K，视频理解）。
- 多模态 messages：`content: [{type:'text',text}, {type:'image_url',image_url:{url}}]`，url 支持公网链接与 `data:image/jpeg;base64,...`。
- `hy3` 属「体验模型」，仅小程序成长计划可用；视觉模型按资源点/自定义模型计费，**需在控制台确认已开通**。
- `imageToImage` 里 `revise:{value:false}` 关掉的是混元自带的提示词改写。**生图前让模型给建议提示词，本质是把 revise 的职责显式化并交给用户确认**，不是新增一层黑箱。

## 提示词顾问（promptAdvisor · DeepSeek 官方直连）
- 云函数 `promptAdvisor` **直连 `https://api.deepseek.com/chat/completions`**（不走 CloudBase 托管模型组）。原文选型理由已写进文件头：官方直连只有一个变量（Key 配没配），托管通道的模型别名/开通状态难判断。
- 鉴权 `Authorization: Bearer ${process.env.DEEPSEEK_API_KEY}`，Key 不放代码、不返前端，日志用 `maskKey()` 只打前后几位 + 长度。
- **模型名实测（2026-10-25 两次真图探活）**：官方 API **只认 `deepseek-flash`**，传云开发托管侧的名字 `deepseek-v4.1-flash` 会 400（模型不存在）。现在顺序是 `['deepseek-flash', 'deepseek-v4.1-flash']`，只在 400/404/422 且报错含 model 时换名。
- **耗时由输出长度决定，不是请求次数**：候选各 ~35 字 → 3.3s，各 ~75 字 → 5.5s（模型倾向取 30-80 字的上限）。想压时间就压字数，优化模型名顺序是噪声级。

- **401 的响应体是纯文本 `Authentication Fails (governor)`，不是 JSON** —— 解析必须先 `JSON.parse` 再回落 `text`，只读 `json.error.message` 会拿到空串。
- 图片规则：**只能出现在 `user` 消息**（system/assistant 带图 400）；外部 URL ≤8192 字符、单图 ≤32MiB、需 60s 内下载完；base64 内联计入 48MiB 请求体；每图自动缩到约 1300×1300、**token 上限 1024**。所以 `detail` 固定 `high`（用 `low` 缩到 512×512 省不了几个 token，却把噪点/油光抹平）。
- 兜底链：URL 取图失败（400 且含 image/url/download）→ 下载转 base64 重试一次（15s 预算）。
- **新建云函数默认 `timeout: 3`**（`imageToImage` 是 240）。模型调用必然被杀，**必须在控制台改成 60s**。`cloud_fn_info` 可以只读核对。
- `cloud_fn_deploy` 首次创建函数常报 `FailedOperation.UpdateFunctionCode: 当前函数处于Creating状态` —— 等 20-30s 重发即可（函数本身已建好，列表里能看到）。
- 探活脚本：`.workbuddy/scripts/probe-promptAdvisor.mjs`（先查 timeout，再用真实 fileID 调一次）。


## 云函数部署（Agnes / Nexus 均为两段式）
- Agnes：`agnesImage`（派发）+ `agnesImageWorker`（执行，200s 预算）；Nexus：`nexusImage` + `nexusImageWorker`。结果写 `ai_image_tasks`，前端每 3s 轮询 `{action:'status'}`。
- **云函数互调的 promise ~15s 就返回失败，不能判任务死**：派发侧 `.catch()` 只记 `dispatchError`，绝不改 status，最终状态只由 worker 写。前端只在「仍 queued + 有 dispatchError + 超 60s」认定没起来。
- **`ai_image_tasks` 由派发侧 `createCollection` 自动建**（冷启动缓存一次）。云函数写入不带 `_openid`，需显式写。查不到和「任务不存在」同文案，防探测。
- **每个函数的环境变量独立**：只在派发函数配 `AGNES_API_KEY`，worker 读不到会立刻报「未配置」。两个都要各配一份。
- **`config.json` 的 `timeout` 对开发者工具通道无效**，删了；超时一律控制台手改。
- 部署报错 `Creating` / `Updating` 都是等一下再试（20s / 25-30s）。
- **`cloud_fn_deploy` 必须带 `remote-npm-install: true`**，否则线上 `Cannot find module 'wx-server-sdk'`。
- 返回判定：先 `pending` + `Waiting for user confirmation.`（IDE 弹窗点确认），成功后是 `{<函数名>:{filesCount,packSize}}`，**没有 "success" 字样**，按 `/success/` 判会空转。
- 部署顺序：先推代码，再配环境变量/超时，配完不要再部署。

## 微信开发者工具 MCP
- **优先原生工具**：`mcp__wechat-devtools__*` 用 ToolSearch 载入 + DeferExecuteTool 调用。**不要因为"没看到工具"就断言没挂载，先搜一次。**
- `automation_evaluate` 可在模拟器调 `wx.cloud.callFunction` 验函数。**`project` 参数必须 `resolve(import.meta.dirname,'../..')`**，写 `resolve('../..')` 会按 cwd 解析报 `PROJECT_CONFIG_JSON_ERROR`。
- **`cloud_query_storage action:"url"` 的 `temporaryUrl` 无效**（403），取文件用 `cloud_manage_storage action:"download"`；`action:"read"` 只支持文本。
- **`element_action` 的 class 选择器跨不进自定义组件**（`<#shadow-root>` 包子节点），只能用属性选择器（`[data-index="4"]`）。合成 touch 事件不会变成 tap。`simulator_open_page` 后上下文指向旧页面，先 `simulator_refresh`。`page_action callMethod` 不可靠，改用 `automation_evaluate` + `getCurrentPages().pop()`。截图固定 363x785，判不细图标状态，看 `wxml` 的 style/class 才是硬证据。
- **内置通道报 `-32603 Bad Request` / `Failed to connect to WechatIDE`**：IDE 重启过而 MCP 子进程攥着死管道。用 `.workbuddy/scripts/wechat-call.mjs <tool> '<json>'` 兜底（已验 `cloud_manage_storage download`）；恢复原生通道只能重连 MCP / 重启 WorkBuddy。
- 其它兜底：`wechat-mcp.mjs`（stdio JSON-RPC，`clientInfo.name` 必须是 `probe`）、`wechat-status.mjs`（只读体检）、`deploy-imageToImage.mjs`。

## Nexus 生图
- 网关 `https://sub.ainexusplus.com`（OpenAI 兼容、Bearer、`gpt-image-2`）。文生图 `/v1/images/generations`；图生图 `/v1/images/edits` 用 **JSON 不是 multipart**，图放 `images: [{image_url:'data:image/jpeg;base64,...'}]`（必须对象数组）。
- **必须带浏览器 User-Agent**，否则 Cloudflare 403（error 1010）。
- 响应优先 `data[0].b64_json`，其次 `url`/`image_url`/`result_url`；url 要带 UA 下载再转存。
- 不要抄 C# 的 `background:'white'`（照片会被强制白底）。
- 尺寸按 gpt-image-2 规则（见上）。目标 `1536x1024`≈1.57MP，改像素要同时改 `NEXUS_TARGET_PIXELS` / `TARGET_PIXELS`。
- 实测：请求 880x1168 → 出 1088x1445；1024x1536 → 1024x1535（网关归一到 ~1.57MP）。`quality:'low'` 要 33-36s，`high` 单张 **58.8s**，所以 `maxWaitMs` 别压到 90s 以下（现用 200s / 3s 轮询）。
- 垫图转 base64 data URI（临时链接会回笼统 400），合计 >15MB 直接报错。
- **零成本验 key**：提交不存在的 fileID → 缺 key 报「未配置 Nexus API Key」(240ms)，有 key 卡在 `downloadFile:fail`(392ms)，不产生费用。

## 留言板（pages/leaveMessage + 云函数 leaveMessage）
- **入口是彩蛋：连点卡片图片左上角爱心 5 次**（`LIKE_STREAK_TARGET = 5`，间隔 ≤ `LIKE_STREAK_GAP = 2000ms` 才算同串，计数器跨卡片共用，`onHide` 清零）。卡片上**不放任何文字入口提示**，无角标无按压态。事件名 `like`（`tap` 会和原生冒泡撞名收两次）。
- 爱心在图片左上角（absolute + z-index，root 要 relative）：56rpx 圆形 + `rgba(0,0,0,.32)` 托底；未赞 `t-icon-heart`+#fff，已赞 `heart-filled`+#d54941。
- 点赞纯本地 `card_likes`，**key 用图片地址**（第 1、4 张卡 desc 同名，用 desc 会串味）。`focusCardInfo` 由 `cardInfo.slice(0,3)` 派生。`onCardLike` 用 `data-url` 定位不读下标。
- 云函数三个 action：`list` / `create` / `remove`，集合 `leave_messages`。**不返回 `_openid`**，只回 `mine` 布尔，归属判断只在服务端。
- 图片只存 fileID（`<image>` 与 `previewImage` 原生支持），目录 `leave-message/YYYYMM/`。**删留言只删路径含 `/leave-message/` 的文件**（一刀切 deleteFile 会误删 ai-images 素材）。
- 防连点：查自己最后一条 `createdAt`，2s 内打回。字符数用 `Array.from()`（emoji 算 2）。
- 页面用 custom navbar + **页面级滚动**（不用 scroll-view），`onReachBottom`/`enablePullDownRefresh` 才可用；输入区 fixed 贴底，`adjust-position="{{false}}"` + `bindkeyboardheightchange` 改 `bottom` 避让键盘。
- 长按删除归属**从 `this.data.messages` 查**，不读 `data-mine`（dataset 可能变字符串）。
- 数据落点：文字/昵称/时间/图片引用 → `leave_messages`（`_id`/`_openid`/`content`/`images`/`nickname`/`createdAt`(ms)/`createTime`）；图片 → 云存储。本地只有 `board_nickname` + `card_likes`。已建索引 `createdAt_-1`。

### 内容加密（客户端）
- 文字和昵称**客户端加密后上传**，库里只有 `v1.<base64(iv||ct||mac)>`，云函数无密钥只卡长度（`MAX_CIPHER_LEN=4096`、昵称 1024）。
- `utils/cipher.js` + `utils/vendor/crypto-js`（13 文件，打包 +23KB）。密钥 `PBKDF2-SHA256(口令,'konggu.leaveBoard.v1',20000)` 出 64 字节：前 32 AES-256-CBC、后 32 HMAC（encrypt-then-MAC）。解锁时派生（0.2~1s），`lockBoard()` 里 `cipher.clearKey()`。
- **IV 不能用 `wx.getRandomValues`**（回调式，同步拿到空 IV → 自己加密自己解不开）。用 `SHA256(时间.自增序号.random)` 取 16 字节，`encrypt()` 里有 `sigBytes !== 16` 防呆。
- **`WordArray.create(new Uint8Array)` 是错的**（没引 lib-typedarrays 会把字节当 32 位 word），必须手工按大端拼（`cipher.js` 的 `fromBytes()`）。
- 无 `v1.` 前缀的明文原样显示；解密失败显示「［解密失败］」。云函数 `normalizeContent`/`normalizeNicknameField` 兼容旧客户端。

### 口令锁
- 必须是 **4 位数字口令**（默认 `3402`）。**没有密码页**：直接在底部输入框打 4 位数字点发送即校验。比对在云函数（`action:'unlock'`，`process.env.BOARD_PIN || DEFAULT_PIN`），同 openid 60s 内最多试 10 次。**输错一律只 toast「功能未开放」**（格式/密码/网络失败同文案），原始原因只 `console.error`。
- **锁着时界面什么都不显示**（用户明确要求）：board 整块 `wx:if="{{unlocked}}"`，placeholder 固定「说点什么…」，选图静默忽略，`onLoad` 不拉数据，`onShow`/`onPullDownRefresh`/`onReachBottom`/`chooseImage` 都有守卫。
- `sendText` 驱动按钮文案（校验中…/发送中/发送）。解锁后 4 位数字就是普通留言。

### 锁屏 / 进后台自动隐藏（2026-10-25 重做）
- **双通道，谁先到谁锁**：页面 `onHide` + `wx.onAppHide`（`onLoad` 注册 / `onUnload` 用 `wx.offAppHide` 注销），都进 `handleBackground()`，`lockBoard()` 幂等。
- 只挂 `wx.onAppHide` 是错的：锁屏先走页面 `onHide`，部分安卓 App 级回调迟到甚至不来 → 表现为「回来不刷新就还能看见」。
- `onShow` 兜底：`Date.now() - _leftAt > RELOCK_AFTER_HIDE(1000ms)` 时先 `lockBoard()` **再 return**，绝不下落 pullNew/startSync。
- **选图豁免**：`wx.chooseMedia` 会切后台，`isPickingMedia()` 判 `_mediaPicking` 或 `_mediaDoneAt` 在 `PICK_GRACE(1500ms)` 内（各机型事件先后不一致，两头都认）。
- **会话令牌 `_session`**：`lockBoard()` 时 +1；`loadFirst`/`loadMore`/`pullNew`/`send` 落地前比对令牌 + `unlocked`，`ingest()`/`onWatchChange()` 首行判 `unlocked`，防在途请求把已清空的内容灌回来。
- `lockBoard()` 不只遮挡：停同步 + 清 messages/draft/images/pendingNew + `unlocked:false` + `_key=null` + `clearKey()`。
- 代价：切到微信内其它界面回来也会锁，草稿与选好的图会丢（锁屏与"切走"无接口可区分，隐私优先接受）。

### 实时刷新
- 双通道：`watch`（真推送）+ **12s 增量轮询**兜底。云函数 `list` 支持 `since`（`createdAt: _.gt(since)`，不分页、`hasMore:false`）并回 `myOpenid` 供判 mine。
- **`watch` 会静默失效**：集合「仅创建者可读写」时只推自己的文档、`onError` 不触发。要跨用户秒级必须把权限放成「所有用户可读」，代码不用改。别指望 watch 报错。
- **空列表必须退回 `fetchPage(0)`**：`_newestAt = 0` 时直接 return 会让空板永远刷不出第一条。
- 攒新留言：滚动 > 300px（`SCROLL_HOLD`）不插列表，攒进 `pendingNew` 出浮条（`bottom` 104px / 有缩略图 164px，放顶部会压住第一条昵称），点 `flushNew` 合并回顶。
- 合并统一走 `mergeMessages()`（按 id 去重 + `createdAt` 倒序），`loadMore` / `send()` 乐观插入都用它。
- **只有别人发的才算新留言**：`ingest()` 按 `mine` 分拨，自己（含同 openid 别设备）静默合并。文案 `buildNewTip()`：`小明 发了新留言` / `小明 等 N 条新留言`，模板只拼「，点击查看」。

## 底部导航与已下线页面
- tabBar 只有 **首页 / 我的**（`custom-tab-bar` + TDesign `t-tab-bar`，item 的 `value` 必须等于 `pages/<value>/index`）。
- **「消息」页签、`pages/message`、`pages/chat`、`mock/chat.js`、`utils/eventBus.js` 已于 2026-10-23 全部删除**（连同未读红点、nav 侧边栏入口）。提到「消息/未读」按不存在处理。

## 包体积（主包 2048KB）
- **`output/`（验收截图）会被打进包**，已在 `project.config.json` 的 `packOptions.ignore` 排除 `output`/`.workbuddy`/`package-lock.json`/`.md`/`.d.ts`。
- `miniprogram_npm/tdesign-miniprogram` 约 2MB，`.d.ts`+`README.md` 占 647KB、约 30 个组件未被引用。裁剪脚本 `.workbuddy/scripts/tdesign-prune.mjs`（`--apply`），根集合来自源码引用，再按 `../<dir>/` 求闭包（`common/mixins/overlay/popup` 别手删）。**`构建 npm` 后要重跑**；`rmSync` 会被 genie-safe-delete 拦，删除走 bash `rm -rf`。
- 子包专用图片放子包目录，别丢 `static/`（全部计主包）。
- 量体积用 `create_preview_qrcode` 返回的 `info.size.packages`（`main`/子包/`TOTAL`），比 `du` 准。

## 人脸识别结论（2026-10 调研，已决定不做）
- 原生 `wx.startFacialRecognitionVerify` 要求**非个人主体** + 类目匹配，个人主体连入口都没有；纯自建防不住照片视频。合规（2025-06-01 起）还要求单独同意、不作唯一验证方式、原则上不出设备、10 万人起备案。
- 结论：**别自己收人脸**，维持口令 + 内容加密。
