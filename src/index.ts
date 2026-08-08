import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { commandDefinitions, registerCommands } from './commands.js';
import { Pusher } from './services/pusher.js';
import { loadState } from './services/state.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const pusher = new Pusher(client);
registerCommands(client, pusher);

async function registerSlashCommands(): Promise<void> {
  const defs = commandDefinitions();
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

client.once('ready', async () => {
  console.log(`[bot] 已登录：${client.user?.tag}`);
  await loadState();
  try {
    await registerSlashCommands();
  } catch (err) {
    console.error('[commands] 注册命令失败:', err);
  }
  pusher.start();
});

client.on('error', (err) => {
  console.error('[bot] client 错误:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[bot] 未处理的 Promise 拒绝:', reason);
});

// 优雅退出
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[bot] 正在退出…');
  pusher.stop();
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

void client.login(config.token).catch((err) => {
  console.error(`[bot] 登录失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
