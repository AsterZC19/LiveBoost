import { localizeCommand } from './commandLocalization.js';
import { settingCommandDefinitions, registerSettingCommands } from './settingCommands.js';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { commandDefinitions, registerCommands } from './commands.js';
import { lbCommandDefinitions, registerLbCommands } from './lbCommands.js';
import { transCommandDefinitions, registerTransCommands } from './translate.js';
import { fireCommandDefinitions, registerFireCommands } from './fireCommands.js';
import { Pusher } from './services/pusher.js';
import { AiService } from './services/ai.js';
import { TtsService } from './services/tts.js';
import { AssistService } from './services/assistService.js';
import { FireReminderService } from './services/fireReminderService.js';
import { loadState } from './services/state.js';
import { startHealthServer, stopHealthServer } from './health.js';

// 登录前加载状态，避免 ready 后的磁盘读取覆盖已收到的交互修改。
await loadState();

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const LOGIN_TIMEOUT_MS = 90_000;
const CONNECTION_CHECK_MS = 30_000;
const CONNECTION_STALE_MS = 2 * 60_000;

interface BotRuntime {
  client: Client;
  pusher: Pusher;
  assist: AssistService;
  fireReminder: FireReminderService;
  started: boolean;
  connectionCheck: ReturnType<typeof setInterval> | null;
}

let runtime: BotRuntime | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let connecting = false;
let shuttingDown = false;

async function registerSlashCommands(client: Client): Promise<void> {
  const defs = [
    ...commandDefinitions(),
    ...lbCommandDefinitions(),
    ...transCommandDefinitions(),
    ...fireCommandDefinitions(),
    ...settingCommandDefinitions(),
  ].map(localizeCommand);
  if (config.guildId) {
    const guild = client.guilds.cache.get(config.guildId);
    if (guild) {
      await guild.commands.set(defs);
      console.log(`[commands] 已注册命令到 guild ${config.guildId}`);
      return;
    }
    console.warn(`[commands] 找不到 guild ${config.guildId}，退回注册为全局命令`);
  }
  await client.application?.commands.set(defs);
  console.log('[commands] 已注册全局命令（最多 1 小时后生效）');
}

function createRuntime(): BotRuntime {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      // 读取消息内容。此特权 intent 需要在 Discord 开发者后台开启。
      GatewayIntentBits.MessageContent,
    ],
  });
  const pusher = new Pusher(client);
  const ai = new AiService();
  const tts = new TtsService();
  // 按服务器隔离语音会话。AssistService 为每个 guild 建立独立的 VoiceService。
  const assist = new AssistService(client, ai, tts);
  const fireReminder = new FireReminderService(client, assist);
  const instance: BotRuntime = { client, pusher, assist, fireReminder, started: false, connectionCheck: null };

  registerCommands(client, pusher);
  registerLbCommands(client, assist);
  registerTransCommands(client, assist);
  registerFireCommands(client, fireReminder);
  registerSettingCommands(client);

  client.once('ready', () => {
    if (shuttingDown || runtime !== instance) return;
    console.log(`[bot] 已登录：${client.user?.tag}`);
    instance.started = true;
    pusher.start();
    assist.start();
    fireReminder.start();
    void registerSlashCommands(client).catch((err) => {
      console.error('[commands] 注册命令失败:', err);
    });
  });
  client.on('error', (err) => console.error('[bot] client 错误:', err));
  // discord.js 会自行恢复普通网关断线；这个事件表示该 shard 已停止重连。
  client.on('shardDisconnect', (event, shardId) => {
    if (shuttingDown || runtime !== instance || connecting) return;
    console.error(`[bot] shard ${shardId} 断开且不会自动重连 (code ${event.code})，准备重新登录`);
    void recover(instance);
  });
  return instance;
}

function stopRuntime(instance: BotRuntime): void {
  if (instance.connectionCheck) clearInterval(instance.connectionCheck);
  instance.connectionCheck = null;
  instance.pusher.stop();
  instance.fireReminder.stop();
  instance.assist.dispose();
}

function scheduleRetry(): void {
  if (shuttingDown || retryTimer) return;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 4));
  retryAttempt++;
  console.warn(`[bot] ${Math.round(delay / 1000)} 秒后重试 Discord 连接（第 ${retryAttempt} 次）`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

async function recover(instance: BotRuntime): Promise<void> {
  if (runtime !== instance || shuttingDown) return;
  runtime = null;
  stopRuntime(instance);
  if (instance.started) {
    try {
      // 旧实例持有的语音连接不会被新 Client 接管。
      await instance.assist.clearAllSessions();
    } catch (err) {
      console.error('[bot] 清理旧语音会话失败:', err);
    }
  }
  try {
    await instance.client.destroy();
  } catch (err) {
    console.error('[bot] 清理旧连接失败:', err);
  }
  scheduleRetry();
}

async function connect(): Promise<void> {
  if (shuttingDown || connecting || runtime) return;
  connecting = true;
  const instance = createRuntime();
  runtime = instance;
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const login = instance.client.login(config.token);
    // 超时后底层登录调用仍可能完成；届时再次销毁旧实例，避免留下孤立连接。
    void login.then(() => {
      if (runtime !== instance) {
        void instance.client.destroy().catch((err) => console.error('[bot] 清理迟到的连接失败:', err));
      }
    }, () => {});
    await Promise.race([
      login,
      new Promise<never>((_, reject) => {
        loginTimer = setTimeout(() => reject(new Error(`Discord 登录超过 ${LOGIN_TIMEOUT_MS / 1000} 秒`)), LOGIN_TIMEOUT_MS);
      }),
    ]);
    retryAttempt = 0;
    let unreadySince: number | null = null;
    instance.connectionCheck = setInterval(() => {
      if (shuttingDown || runtime !== instance) return;
      if (instance.client.isReady()) {
        unreadySince = null;
        return;
      }
      unreadySince ??= Date.now();
      if (Date.now() - unreadySince >= CONNECTION_STALE_MS) {
        console.error('[bot] Discord 已持续 2 分钟未就绪，重建连接');
        void recover(instance);
      }
    }, CONNECTION_CHECK_MS);
  } catch (err) {
    console.error(`[bot] 登录失败: ${err instanceof Error ? err.message : String(err)}`);
    await recover(instance);
  } finally {
    if (loginTimer) clearTimeout(loginTimer);
    connecting = false;
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[bot] 未处理的 Promise 拒绝:', reason);
});

// 优雅退出
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[bot] 正在退出…');
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const instance = runtime;
  runtime = null;
  if (instance) stopRuntime(instance);
  try {
    // 下线即退出所有语音频道，并清空持久化会话。
    await instance?.assist.clearAllSessions();
    process.exitCode = 0;
  } catch (err) {
    console.error('[bot] 退出时保存会话失败:', err);
    process.exitCode = 1;
  } finally {
    stopHealthServer();
    try {
      await instance?.client.destroy();
    } catch (err) {
      console.error('[bot] 退出时断开 Discord 失败:', err);
      process.exitCode = 1;
    }
    process.exit();
  }
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// 健康检查端口独立启动，方便 uptime 探测
startHealthServer(() => runtime?.client.isReady() ?? false);
void connect();
