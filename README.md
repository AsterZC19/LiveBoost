# LiveBoost 🎸

BanG Dream! Girls Band Party! T10 Discord 推送机器人。

## 功能

- 自动切换最新活动：检测到新活动开始后自动切换并通知
- 双推送：
  - 分速推送：按活动类型间隔推送
  - 时速推送：每个整点推送一次
- 语音 TTS + AI 中日互译：
  - 加入语音频道后，将文本频道里的消息朗读出来；AI 自动识别中日语种并切换 TTS 音色。
  - 中文↔日文 AI 互译，以回复形式发回频道。
  - 成员进入/退出绑定的语音频道时自动 TTS 播报。


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

- Node.js ≥ 22
- npm

## 安装与运行

```bash
npm install
cp .env.example .env   # 编辑 .env，填入 DISCORD_TOKEN
npm run dev            # 开发模式
npm run build && npm start   # 构建后运行
npm run render         # 测试渲染预览图
```

## Docker 部署

镜像托管在 **GitHub Container Registry (GHCR)**：`ghcr.io/asterzc19/liveboost`。

```bash
# 1. 编辑环境变量
cp .env.example .env

# 2. 拉取并运行
docker run -d --name liveboost --restart unless-stopped \
  --env-file .env \
  ghcr.io/asterzc19/liveboost:latest

# 查看日志
docker logs -f liveboost
```

### docker-compose 部署

```bash
cp .env.example .env   # 编辑 .env
docker compose up -d
```

> `STATE_FILE` 不设置时默认写到 `/app/state.json`。

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
`GUILD_ID` 留空注册为全局命令；填入则只注册到该服务器。

## 语音 TTS（`/lb`）

> 仅 **bot 拥有者**（`.env` 里的 `BOT_OWNER_ID`）可使用，防止被滥用。

| 命令 | 作用 |
| --- | --- |
| `/lb join [channel]` | 加入你所在的语音频道，并绑定文本频道 |
| `/lb leave` | 退出语音并解除绑定 |
| `/lb translate on\|off` | 开启/关闭 AI 中日互译 |
| `/lb speak on\|off` | 开启/关闭 TTS 朗读|
| `/lb status` | 查看当前绑定与开关状态 + 当前并行服务器数 |

> 支持**多服务器并行**：每个服务器是独立会话，消息只在本服务器绑定的文本频道内处理。
> 最多同时并行 `MAX_VOICE_GUILDS`（默认 3）个服务器，超出后 `/lb join` 会被拒绝提示达到上限。
>
> 语音频道进出播报跟随 `/lb speak` 开关：关闭朗读后进出播报一并静音。
>
> `/lb join` 后默认同时开启 TTS 朗读与 AI 互译；`/lb leave` 退出语音并一并关闭。
>

⚠️ **前置条件**：
1. 在 Discord 开发者后台为机器人开启 **Message Content Intent** 与 Voice States。
2. 在 `.env` 配置 `AI_API_KEY`（DeepSeek 等 OpenAI 兼容服务的 key）；使用 `/lb` 还需配置 `BOT_OWNER_ID`（拥有者 ID）。

## 独立 AI 互译（`/trans`）

> **所有服务器成员**可用，不依赖语音频道，纯文本互译。

| 命令 | 作用 |
| --- | --- |
| `/trans on [channel]` | 在本频道（或指定频道）启用 AI 中日互译 |
| `/trans off [channel]` | 关闭本频道（或指定频道）的 AI 互译 |
| `/trans status` | 查看本频道互译状态与全局占用数 |

> 支持多频道并行：每个频道独立互译，按**文本频道**计数，最多同时 `MAX_TRANSLATE_CHANNELS`（默认 10）个频道，超出后 `/trans on` 会被拒绝。
> 互译会话无需语音连接，重启后保持启用；与 `/lb` 语音会话相互独立、互不影响。

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
| `BOT_OWNER_ID` | ✅ | — | bot 拥有者 Discord 用户 ID，唯一能使用 `/lb` 的人 |
| `AI_BASE_URL` | | `https://api.deepseek.com/v1` | AI 翻译的 OpenAI 兼容接口地址 |
| `AI_API_KEY` | ✅ | — | AI 翻译 key（DeepSeek 等） |
| `AI_MODEL` | | `deepseek-chat` | AI 模型名 |
| `AI_REASONING_EFFORT` | | `none` | AI 推理力度：`none` 关闭思考最快；`low`/`medium`/`high` 逐级；留空则不传该参数 |
| `TTS_VOICE_ZH` | | `zh-CN-XiaoxiaoNeural` | 中文 TTS 音色（Edge TTS） |
| `TTS_VOICE_JA` | | `ja-JP-NanamiNeural` | 日文 TTS 音色（Edge TTS） |
| `TTS_RATE` | | `+25%` | TTS 语速（SSML rate，`+25%` 加快 25%，`-10%` 放慢） |
| `MAX_VOICE_GUILDS` | | `3` | 最多同时并行服务的服务器数，超出拒绝加入 |
| `MAX_TRANSLATE_CHANNELS` | | `10` | 独立 AI 互译最多同时启用的文本频道数，超出拒绝新绑定 |


## 数据来源

[Bestdori](https://bestdori.com)

## 目录结构

```
src/
├─ index.ts              # 入口
├─ config.ts             
├─ commands.ts           # /push 命令
├─ lbCommands.ts         # /lb 命令
├─ translate.ts          # /trans 命令
├─ types.ts              # 共享类型
└─ services/
   ├─ bestdori.ts        # Bestdori API 客户端
   ├─ eventService.ts    
   ├─ renderer.ts        # 图片生成
   ├─ pusher.ts          # 分速/时速推送
   ├─ state.ts           # state.json 持久化
   ├─ ai.ts              # AI 语种识别 + 中日互译
   ├─ emoji.ts           # emoji 中日名字映射
   ├─ tts.ts             # Edge TTS 语音合成
   ├─ voiceService.ts    # 语音连接 + 顺序播放队列
   └─ assistService.ts   # 消息编排
assets/
└─ fonts/                # 字体
```

## License

[MIT](LICENSE)

Copyright (c) 2026 LiveBoost Contributors
