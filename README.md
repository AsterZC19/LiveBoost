# LiveBoost 🎸

BanG Dream! Girls Band Party T10 Discord 推送机器人。

自动探测最新活动，向开启推送的频道发送 T10 增量图片；新活动开始后自动切换推送目标。

## 功能

- 自动切换最新活动：每轮推送探测 Bestdori 最新活动，检测到新活动开始后自动切换并通知
- 双推送（独立开关，可分别在不同频道开启）：
  - 分速推送：按活动类型间隔推送，对齐整点分钟网格（2 分钟 → :00 :02 :04 …）
  - 时速推送：每个整点（:00）推送一次


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

## 数据来源

[Bestdori](https://bestdori.com)

## 目录结构

```
src/
├─ index.ts              # 入口
├─ config.ts             
├─ commands.ts           # 命令
├─ types.ts              # 共享类型
└─ services/
   ├─ bestdori.ts        # Bestdori API 客户端
   ├─ eventService.ts    
   ├─ renderer.ts        # 图片生成
   ├─ pusher.ts          # 分速/时速推送
   └─ state.ts           # state.json 持久化
assets/
└─ fonts/                # 字体
```

## License

[MIT](LICENSE)

Copyright (c) 2026 LiveBoost Contributors

