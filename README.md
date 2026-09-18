# 会话标题优化器（session-title-optimizer）

让 HanaAgent 的会话标题跟着对话走。灵感来自 [oil-codex-title](https://github.com/oil-oil/oil-codex-title)，按 HanakoAgent 插件体系重写。

## 它做什么

- **自动跟随**：每轮对话落定后（Hanako 版 Stop Hook：`turn_end` / `message_end` 事件），后台评估当前标题，烂了就按「类别 emoji｜对象｜目标」重写，实时生效、不打断对话
- **烂标题判定**（硬启发式）：URL 当标题、纯问候、模型思考过程泄露、文件路径、多行、超长截断、系统噪音
- **手动改名锁定**：插件记录自己写过的每个标题；发现标题被手动改过 → 永久锁定，机器不再碰人的意志
- **keep 优先**：标题已合格就只在主线漂移时复查（默认每 6 条新消息），成本可控

## 工具

| 工具 | 权限 | 用途 |
|---|---|---|
| `title_scan` | 只读 | 扫描所有会话，列出烂标题清单 |
| `title_rename` | 写入 | 改单个会话标题 |
| `title_optimize` | 写入 | 历史批量整理，默认 dry_run 预览 |

对话里直接说「扫一下标题」「把这个会话改成 xxx」「批量整理历史标题」即可。

## 命名规范

`类别 emoji + 对象｜目标`，对象在前目标在后，全角「｜」恰好一个，中文 10~26 字。

内置 12 类（源自 496 条真实标题普查）：📰 宣传稿件 / 📮 投稿台账 / 🛡️ 巡察合规 / 📑 合同采购 / 📷 影像归档 / 🔧 系统排查 / 🧩 工具开发 / 🔎 调研学习 / 🗂️ 文件整理 / 📊 表格数据 / 📅 日程待办 / 💬 一般讨论

类别表是**活的**：设置 → 插件 → 会话标题优化器设置 → 「自定义类别表」，填 JSON 数组即可增删改，下一轮评估即生效。

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| enabled | 开 | 自动优化总开关 |
| debounceSec | 15 | 落定后去抖秒数 |
| minIntervalSec | 180 | 同会话最小评估间隔 |
| driftCheckMessages | 6 | 好标题的漂移复查频率 |
| categoriesJson | 空 | 自定义类别表（留空用内置） |
| genEndpoint / genApiKey / genModel | 空 | 自定义 LLM 端点，留空走宿主模型 |
| fallbackEndpoint / fallbackApiKey / fallbackModel | 空 | 降级端点：宿主模型调用失败时自动切换（如本地 OMLX） |
| maxRenamesPerRun | 20 | 批量整理单次上限 |
| debugEvents | 关 | 事件调试日志 |

## 数据

全部存放在插件数据目录：

- `baseline.json`：插件写过的标题基线（锁定机制的依据）
- `locks.json`：被锁定的会话（用户手动改名）
- `optimizer-log.jsonl`：全量运行日志（时间、旧标题、新标题、依据），可审计可回溯

## 边界

- 只碰正常 chat 会话，排除 archived / activity / bridge 会话
- 消息数少于 2 的会话不评估（无实质目标）
- 批量整理有单次上限，翻车有保险丝
- 权限：full-access（需要 `session:update` 写标题、`model:sample-text` 调模型）
