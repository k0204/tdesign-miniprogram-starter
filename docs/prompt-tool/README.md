# 提示词出图工具

把 `docs/` 里 2179 条人工标注的提示词列出来，勾选后逐张调 Agnes 出图。

## 启动

```bash
cd docs/prompt-tool
node server.js
# 打开 http://127.0.0.1:4780
```

零依赖，不需要 `npm install`。Node 18+ 即可。

首次使用先从 `config.example.json` 复制一份 `config.local.json` 并填入 key。

## 数据

| 文件 | 说明 |
|---|---|
| `data/prompts.txt` | **纯文本，一行一条**。2179 行，可直接复制去任何模型 |
| `data/prompts.jsonl` | 带元数据（编号 / 画幅 / 分组 / 景别 / 光线 / 字数 / 重复次数） |
| `data/summary.json` | 统计摘要 |

重新生成（改了源 CSV 之后）：

```bash
python extract_prompts.py
```

数据来源：`../analysis.csv`（1450 条）+ `../images-analysis.csv`（803 条）。
提示词完全相同的合并为一条，`dup` 记重复次数，原始文件路径保留在 `file` / `dupFrom`。

## 界面

- 左栏：搜索 / 按分组筛选 / 按画幅筛选，每页 30 条，可展开看全文
- 勾选后底部出现操作条，或单条点「生成这条」
- 右栏：图墙，实时显示排队 / 生成中 / 完成 / 失败，失败可单条重试
- 顶部切 1K / 2K / 3K，可暂停队列

## 为什么必须串行

Agnes 不接受并发连接，实测并行 5 条全部被 RST 断开。整个进程只有一个 worker，
严格一张一张跑，相邻两张间隔 1.5s。503「队列满」自动退避重试三次（5s / 12s / 25s）。

## 着装兜底开关

**默认开启。** 原因：A 库 1450 条里有 1331 条（92%）的 `服装` 字段是空的，
渲染出来的提示词就不带服装信息。模型遇到「七分身与全身构图」会自由发挥——
实测 P0005（原文只写了「一位女孩…摆出姿态」）直接生成了裸上身形象。

开启后会在提示词末尾追加「，人物着装完整得体，画面干净」。
提示词文本本身不改，保持可溯源；关掉开关即还原原始行为。

## 实测数据

| 项 | 值 |
|---|---|
| 文生图耗时 | 14–26 s / 张（1K） |
| 中文提示词 | **可直接用**，无需翻译 |
| 单张体积 | 1.0–1.4 MB PNG |
| 成功率 | 首次 5/5，未触发重试 |

对比参考：图生图（带垫图）要 85–96 s，文生图快一个数量级。

## 文件

```
prompt-tool/
├── server.js             本地服务：静态页 + 列表 API + 串行队列 + Agnes 调用
├── public/index.html     单页界面
├── extract_prompts.py    从源 CSV 生成 prompts.txt / jsonl
├── probe.py              探活 key（一次最小请求）
├── test_zh.py            用指定编号的提示词测一次中文生成
├── config.local.json     key（不要提交）
├── config.example.json   模板
├── data/                 提示词列表
└── output/               生成的图片 + index.json
```

## 注意

`config.local.json` 含明文 key，已加进 `.gitignore`，不要提交，也不要截图外发。
