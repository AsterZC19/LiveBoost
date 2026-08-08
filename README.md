# LiveBoost 🎸

BanG Dream! Girls Band Party T10 Discord 推送机器人。

自动探测最新活动，向开启推送的频道发送 T10 增量图片；新活动开始后自动切换推送目标。

## 功能

- 自动切换最新活动：每轮推送探测 Bestdori 最新活动，检测到新活动开始后自动切换并通知
- 双推送（独立开关，可分别在不同频道开启）：
  - 分速推送：按活动类型间隔推送，对齐整点分钟网格（2 分钟 → :00 :02 :04 …）
  - 时速推送：每个整点（:00）推送一次
- 语音 TTS + AI 中日互译（仅 bot 作者可用）：
  - 加入语音频道后，把绑定文本频道里的消息朗读出来（带发消息的用户名，方便只听语音的人辨认）；AI 自动识别中日语种并切换 TTS 音色，**中日混杂时按语言分段，中文用中文音色、日文用日文音色交错朗读**（分段由 AI 精确识别，日文里的汉字会正确归入日文）
  - 中文↔日文 AI 互译，以回复形式发回频道；**中日混杂的消息一条回复同时给出中文版与日文版**，辅助中日成员沟通


## 分速推送间隔

| 活动类型 | Bestdori | 间隔 |
| --- | --- | --- |
| 组曲 | `medley` | 5 分钟 |
| 对邦（竞演） | `versus` | 2 分钟 |
| 挑战（cp） | `challenge` | 2 分钟 |
| 协力（任务） | `mission_live` | 2 分钟 |
| 5v5 | `festival` | 3 分钟 |
| 其他 | — | 2 分钟 |

## 环境要求

- Node.js ≥ 20
- npm

## 安装与运行

```bash
npm install
cp .env.example .env   # 编辑 .env，填入 DISCORD_TOKEN
npm run dev            # 开发模式
npm run build && npm start   # 构建后运行
npm run render         # 测试渲染预览图
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/push interval on` | 开启本频道分速推送 |
| `/push interval off` | 关闭本频道分速推送 |
| `/push hourly on` | 开启本频道时速推送 |
| `/push hourly off` | 关闭本频道时速推送 |
| `/push status` | 查看本频道两个开关状态 + 当前活动 |
| `/push now` | 立即推送分速增量到本频道（调试） |

默认 `/push` 仅管理员可用，可用 `REQUIRE_ADMIN=false` 放开。
`GUILD_ID` 留空注册为全局命令（最多 1 小时后生效）；填入则只注册到该服务器（即时生效）。

## 语音 TTS / AI 互译（`/lb`）

> 仅 **bot 作者**（`.env` 里的 `BOT_OWNER_ID`）可使用，防止被滥用。

| 命令 | 作用 |
| --- | --- |
| `/lb join [channel]` | 加入你所在的语音频道，并绑定文本频道（默认当前频道） |
| `/lb leave` | 退出语音并解除绑定 |
| `/lb translate on\|off` | 开启/关闭 AI 中日互译（翻译以回复形式发回频道，混排消息同时给中/日两版） |
| `/lb speak on\|off` | 开启/关闭 TTS 朗读（朗读「用户名+原文」，中日混杂时按语言分段朗读） |
| `/lb status` | 查看当前绑定与开关状态 |

朗读细节：
- **用户名**按自身语种读（含假名的名字用日文音色；纯汉字名如「山田」「佐藤」会交给 **AI 判断**更像中文还是日文），不被后面的消息语种影响。
- **emoji 会读出名字**（如 😂 → 中文"笑哭" / 日文"泣き笑い"，按所在语种读）；**纯 emoji 消息**也会读出名字（不翻译）；颜文字、装饰符号和未收录的 emoji 跳过。
- 已知限制：AI 不可用（未配置 key / 调用失败）时，纯汉字名退化为字符判定（按中文读），混排消息的 emoji 会跳过。

工作方式：绑定后，机器人在**指定文本频道**里收到消息（非机器人发的），会先调用 AI
识别语种、是否中日混杂，并生成中/日两个完整版本；随后按开关决定是否**朗读原文**（Edge TTS，免费，
混排消息按语言分段用对应音色读）以及**回复翻译**（单语只给另一种语言，混排给中文版+日文版两条在同一回复里）。
重启后会自动恢复上次的会话与开关状态。

⚠️ 需要**两个前置条件**：
1. 在 Discord 开发者后台为机器人开启 **Message Content Intent**（读消息内容）与 Voice States。
2. 在 `.env` 配置 `BOT_OWNER_ID`（作者 ID）和 `AI_API_KEY`（DeepSeek 等 OpenAI 兼容服务的 key）。

## 配置项（.env）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | ✅ | — | Discord Bot Token |
| `GUILD_ID` | | 空 | 命令注册目标服务器；留空全局 |
| `CHECK_INTERVAL_MINUTES` | | 2 | 无活动时的检测间隔（分钟） |
| `HOURLY_PUSH_ENABLED` | | true | 是否启用时速推送 |
| `BESTDORI_SERVER` | | jp | Bestdori 服务器 |
| `TIMEZONE` | | Asia/Tokyo | 时间显示时区 |
| `REQUIRE_ADMIN` | | true | `/push` 是否仅管理员可用 |
| `BOT_OWNER_ID` | ✅* | — | bot 作者 Discord 用户 ID，唯一能使用 `/lb` 的人 |
| `AI_BASE_URL` | | `https://api.deepseek.com/v1` | AI 翻译的 OpenAI 兼容接口地址 |
| `AI_API_KEY` | ✅* | — | AI 翻译 key（DeepSeek 等） |
| `AI_MODEL` | | `deepseek-chat` | AI 模型名 |
| `TTS_VOICE_ZH` | | `zh-CN-XiaoxiaoNeural` | 中文 TTS 音色（Edge TTS） |
| `TTS_VOICE_JA` | | `ja-JP-NanamiNeural` | 日文 TTS 音色（Edge TTS） |
| `TTS_RATE` | | `+25%` | TTS 语速（SSML rate，`+25%` 加快 25%，`-10%` 放慢） |

`*` 带 `*` 的为语音 TTS / AI 互译功能所需，不影响原有推送功能。

## 数据来源

[Bestdori](https://bestdori.com)

## 目录结构

```
src/
├─ index.ts              # 入口
├─ config.ts             
├─ commands.ts           # /push 命令
├─ lbCommands.ts        # /lb 命令（仅作者可用）
├─ types.ts              # 共享类型
└─ services/
   ├─ bestdori.ts        # Bestdori API 客户端
   ├─ eventService.ts    
   ├─ renderer.ts        # 图片生成
   ├─ pusher.ts          # 分速/时速推送
   ├─ state.ts           # state.json 持久化
   ├─ ai.ts              # AI 语种识别 + 中日互译
   ├─ emoji.ts           # emoji 中日名字映射（朗读用）
   ├─ tts.ts             # Edge TTS 语音合成
   ├─ voiceService.ts    # 语音连接 + 顺序播放队列
   └─ assistService.ts   # 消息编排（朗读 + 翻译）
assets/
└─ fonts/                # 字体
```

## License

[MIT](LICENSE)

Copyright (c) 2026 LiveBoost Contributors

