// 干跑渲染：不连 Discord，拉真实数据生成两张预览图，用于调试图片样式。用法：npm run render
//   preview.png        —— 分速
//   preview_hourly.png —— 时速
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, config } from './config.js';
import { getTopData } from './services/bestdori.js';
import {
  buildLeaderboard,
  computeHourlyActivity,
  computeSpeedIncrements,
  findCurrentEvent,
  pushIntervalForType,
} from './services/eventService.js';
import { renderSpeedImage, formatTime } from './services/renderer.js';

const HOUR = 3600000;

function withIncrements(topData: Awaited<ReturnType<typeof getTopData>>, windowMs: number) {
  const increments = computeSpeedIncrements(topData!, Date.now(), windowMs);
  return buildLeaderboard(topData!).map((p) => ({
    ...p,
    speed: increments.get(p.uid) ?? -1,
    speed_rank: 0,
  }));
}

async function main(): Promise<void> {
  const event = await findCurrentEvent();
  if (!event) {
    console.error('未找到当前活动');
    process.exit(1);
  }
  console.log(`当前活动: #${event.event_id} ${event.name} (${event.event_type})`);
  console.log(`时间: ${formatTime(event.start_at)} ~ ${formatTime(event.end_at)}`);
  const intervalMin = pushIntervalForType(event.event_type);
  console.log(`分速推送间隔: ${intervalMin} 分钟`);

  const topData = await getTopData(event.event_id, config.server);
  if (!topData) {
    console.error('拉取 T10 数据失败');
    process.exit(1);
  }

  // 第一张图为分速增量。
  const now = Date.now();
  const intervalPlayers = withIncrements(topData, intervalMin * 60_000);
  const rt = await renderSpeedImage(event, intervalPlayers, {
    pill: '分速',
    incrementLabel: '分速增量',
    windowStart: now - intervalMin * 60_000,
    windowEnd: now,
  });
  const rtPath = path.join(ROOT_DIR, 'preview.png');
  await fs.writeFile(rtPath, rt);
  console.log(`已生成 ${rtPath} (${(rt.length / 1024).toFixed(1)} KB)`);
  const rtTints = topIncrementTints(intervalPlayers);
  intervalPlayers.forEach((p, i) => {
    const tag = rtTints.get(i) ? `[${rtTints.get(i)}]` : '';
    const gap = i === 0 ? 0 : intervalPlayers[i - 1].pt - p.pt;
    console.log(`  分速 PT#${p.rank} ${tag} ${p.name} 分差${gap.toLocaleString('en-US')} +${p.speed >= 0 ? p.speed.toLocaleString('en-US') : '-'} (最近${intervalMin}分钟)`);
  });

  // 第二张图为上一整点时速。重新获取当前时间，避免渲染分速图期间跨越整点导致热力图窗口错位。
  const nowHourly = Date.now();
  const hourlyPlayers = withIncrements(topData, HOUR);
  const heatmap = computeHourlyActivity(topData, nowHourly);
  const hr = await renderSpeedImage(event, hourlyPlayers, {
    pill: '时速',
    incrementLabel: '上一整点时速',
    windowStart: nowHourly - HOUR,
    windowEnd: nowHourly,
    heatmap,
  });
  const hrPath = path.join(ROOT_DIR, 'preview_hourly.png');
  await fs.writeFile(hrPath, hr);
  console.log(`已生成 ${hrPath} (${(hr.length / 1024).toFixed(1)} KB)`);
  const hrTints = topIncrementTints(hourlyPlayers);
  hourlyPlayers.forEach((p, i) => {
    const tag = hrTints.get(i) ? `[${hrTints.get(i)}]` : '';
    const gap = i === 0 ? 0 : hourlyPlayers[i - 1].pt - p.pt;
    console.log(`  时速 PT#${p.rank} ${tag} ${p.name} 分差${gap.toLocaleString('en-US')} +${p.speed >= 0 ? p.speed.toLocaleString('en-US') : '-'} (上一小时)`);
  });
}

// 行序号 -> 增量前 3 名的金/银/铜标记
function topIncrementTints(players: ReturnType<typeof withIncrements>): Map<number, string> {
  const medals = ['金', '银', '铜'];
  const map = new Map<number, string>();
  players
    .map((p, i) => ({ i, speed: p.speed }))
    .filter((x) => x.speed > 0)
    .sort((a, b) => b.speed - a.speed)
    .slice(0, 3)
    .forEach((x, k) => map.set(x.i, medals[k]));
  return map;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
