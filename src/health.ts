import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Client } from 'discord.js';
import { VERSION, config } from './config.js';

let server: Server | null = null;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function isAuthorized(req: { headers: Record<string, string | string[] | undefined> }, url: URL): boolean {
  if (!config.healthToken) return true;

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return safeEqual(header.slice(7), config.healthToken);
  }

  const queryToken = url.searchParams.get('token');
  if (queryToken) return safeEqual(queryToken, config.healthToken);

  return false;
}

function sendJson(res: import('node:http').ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function handleRequest(client: Client, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method !== 'GET' || (url.pathname !== '/health' && url.pathname !== '/healthz')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (!isAuthorized(req, url)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const discordOk = client.isReady();
  const status = discordOk ? 'ok' : 'degraded';
  const code = discordOk ? 200 : 503;

  sendJson(res, code, {
    status,
    version: VERSION,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    discord: discordOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
}

export function startHealthServer(client: Client): void {
  if (!config.healthPort) {
    console.log('[health] HEALTH_PORT 未配置，跳过 health HTTP 服务');
    return;
  }

  if (!config.healthToken) {
    console.warn('[health] 未配置 HEALTH_TOKEN，health 端口仅建议本机/受信网络使用');
  }
  if (config.healthBind === '0.0.0.0' && !config.healthToken) {
    console.warn('[health] 当前监听 0.0.0.0 且未设置 HEALTH_TOKEN，任何人可访问 /health，请务必配置 Token');
  }

  if ((config.healthTlsCert && !config.healthTlsKey) || (!config.healthTlsCert && config.healthTlsKey)) {
    console.warn('[health] HEALTH_TLS_CERT 和 HEALTH_TLS_KEY 必须同时配置，当前仅配置了一个，将使用 HTTP');
  }

  const useTls = Boolean(config.healthTlsCert && config.healthTlsKey);
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void =>
    handleRequest(client, req, res);

  if (useTls) {
    try {
      server = createHttpsServer(
        {
          cert: readFileSync(config.healthTlsCert),
          key: readFileSync(config.healthTlsKey),
        },
        handler,
      );
    } catch (err) {
      console.error(`[health] TLS 证书/私钥读取失败，进程退出: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    server = createServer(handler);
  }

  const protocol = useTls ? 'https' : 'http';
  server.listen(config.healthPort, config.healthBind, () => {
    console.log(`[health] health 服务已启动: ${protocol}://${config.healthBind}:${config.healthPort}/health`);
  });
  server.on('error', (err) => {
    console.error(`[health] 服务启动失败，进程退出: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export function stopHealthServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log('[health] health 服务已停止');
  }
}
