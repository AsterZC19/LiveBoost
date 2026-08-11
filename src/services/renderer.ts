import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { FONT_FAMILY, FONT_REGULAR, FONT_MEDIUM, FONT_BOLD, config } from '../config.js';
import type { BestdoriEvent, TopPlayer } from '../types.js';
import { eventDayNumber } from './eventService.js';

// 注册 Noto Sans SC 三个字重
GlobalFonts.registerFromPath(FONT_REGULAR);
GlobalFonts.registerFromPath(FONT_MEDIUM);
GlobalFonts.registerFromPath(FONT_BOLD);

// 画布尺寸（1600×740：压缩高度，减小 Discord 里的占位；宽度不变）
const WIDTH = 1600;
const HEIGHT = 740;
const MARGIN = 20;
const CARD_PAD = 36;
const CARD_W = WIDTH - MARGIN * 2; // 1560
const CARD_H = HEIGHT - MARGIN * 2; // 700
const HEADER_H = 64;
const TABLE_HEADER_H = 36;
const FOOTER_H = 38;

// 48h 热力图（仅时速表）：每位玩家信息行下方一条热力条（左新右旧）
const HEATMAP_N = 48; // 格子数（最近 48 小时）
const HEATMAP_CELL_W = 26;
const HEATMAP_CELL_H = 20;
const HEATMAP_GAP = 3; // 格子间距
const HEATMAP_W = HEATMAP_N * HEATMAP_CELL_W + (HEATMAP_N - 1) * HEATMAP_GAP; // 1389
const HEATMAP_GAP_TOP = 6; // 信息行下缘到格子顶部
const HEATMAP_H = HEATMAP_GAP_TOP + HEATMAP_CELL_H; // 热力条区域总高（标签放左右两侧，不占额外高度）

// Material Design 3 配色
const M3 = {
  surface: '#FEF7FF', // 卡片表面
  surfaceContainer: '#F3EDF7', // 画布背景
  surfaceContainerHigh: '#ECE6F0', // 表头行
  surfaceContainerHighest: '#E6E0E9', // 行分隔线 / 位次圆
  onSurface: '#1D1B20', // 主要文字
  onSurfaceVariant: '#49454F', // 次要文字
  outlineVariant: '#CAC4D0', // 细分隔线
  primary: '#6750A4', // 主题色（UID）
  onPrimary: '#FFFFFF',
  primaryContainer: '#EADDFF', // 标签底色
  onPrimaryContainer: '#21005D', // 标签文字
  increment: '#2E7D32', // 增量绿色
  pt: '#2F5B84', // PT 数字（次级强调色，明显但不抢增量的主题）
  title: '#5A6B7E', // 标题（不抢眼的柔蓝灰）
};

// 增量前三名整行底色（金/银/铜）
const ROW_TINTS = ['#FFF6D6', '#F1F3F5', '#FBE8D3'];
// 正增量最后一名（表中最后一行仍在增量的玩家）整行淡粉底，标记增量边界
const LAST_GAIN_TINT = '#FBE0E6';

interface Layout {
  width: number;
  height: number;
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  innerX: number;
  innerW: number;
  headerTop: number;
  rowH: number;
}

function layoutFor(n: number, heatmap = false): Layout {
  const heatH = heatmap ? HEATMAP_H : 0;
  // 热力图模式：信息行固定 52px，卡片高度按人数动态扩张（n=10 时卡片约 918px、画布约 958px）；
  // 否则保持原有 700 高逻辑不变。
  const rowH = heatmap
    ? 52
    : Math.max(48, Math.min(80, Math.floor((CARD_H - HEADER_H - TABLE_HEADER_H - FOOTER_H) / Math.max(1, n))));
  const cardH = heatmap
    ? HEADER_H + TABLE_HEADER_H + n * (rowH + heatH) + FOOTER_H
    : CARD_H;
  return {
    width: WIDTH,
    height: cardH + MARGIN * 2,
    cardX: MARGIN,
    cardY: MARGIN,
    cardW: CARD_W,
    cardH,
    innerX: MARGIN + CARD_PAD,
    innerW: CARD_W - CARD_PAD * 2,
    headerTop: MARGIN + HEADER_H,
    rowH,
  };
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 截断文字并加省略号
function truncate(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

// 按最大宽度换行，最多 maxLines 行；剩余内容在最后一行加省略号
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length && lines.length < maxLines) {
    // 取能放入一行的最长前缀
    let end = start + 1;
    while (end < text.length + 1 && ctx.measureText(text.slice(start, end)).width <= maxWidth) end++;
    end -= 1;
    if (end <= start) end = start + 1; // 单字符超宽时也至少保留一个
    lines.push(text.slice(start, end));
    start = end;
  }
  // 还有剩余 -> 最后一行加省略号
  if (start < text.length) {
    let last = lines[lines.length - 1] ?? '';
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

// 按配置时区格式化时间
export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '--';
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return fmt.format(ms).replace(/\//g, '-');
}

// 建画布，画背景和卡片
function createCard(n: number, heatmap = false): { ctx: SKRSContext2D; layout: Layout } {
  const layout = layoutFor(n, heatmap);
  const canvas = createCanvas(layout.width, layout.height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = M3.surfaceContainer;
  ctx.fillRect(0, 0, layout.width, layout.height);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.14)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = M3.surface;
  roundRect(ctx, layout.cardX, layout.cardY, layout.cardW, layout.cardH, 28);
  ctx.fill();
  ctx.restore();

  return { ctx, layout };
}

interface HeaderOptions {
  pill: string;
}

// 头部：活动名 + 右上标签 + 分隔线
function drawHeader(ctx: SKRSContext2D, event: BestdoriEvent, layout: Layout, opts: HeaderOptions): void {
  const { cardX, cardY, cardW, innerX, innerW } = layout;

  const titleY = cardY + 40;
  ctx.fillStyle = M3.title;
  ctx.font = `bold 38px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  const title = truncate(ctx, event.name, innerW - 240);
  ctx.fillText(title, innerX, titleY);

  // 右上标签
  ctx.font = `600 18px ${FONT_FAMILY}`;
  const pillW = ctx.measureText(opts.pill).width + 32;
  const pillX = cardX + cardW - CARD_PAD - pillW;
  const pillY = titleY - 18;
  ctx.fillStyle = M3.primaryContainer;
  roundRect(ctx, pillX, pillY, pillW, 36, 18);
  ctx.fill();
  ctx.fillStyle = M3.onPrimaryContainer;
  ctx.fillText(opts.pill, pillX + 16, pillY + 18);

  // 分隔线
  const dividerY = cardY + HEADER_H - 1;
  ctx.fillStyle = M3.surfaceContainerHighest;
  ctx.fillRect(innerX, dividerY, innerW, 1);
}

// 表头行，列名统一居中
function drawTableHeader(ctx: SKRSContext2D, layout: Layout, columns: readonly { label: string; width: number }[]): void {
  const { innerX, innerW, headerTop } = layout;
  ctx.fillStyle = M3.surfaceContainerHigh;
  ctx.fillRect(innerX, headerTop, innerW, TABLE_HEADER_H);
  ctx.font = `600 20px ${FONT_FAMILY}`;
  ctx.fillStyle = M3.onSurfaceVariant;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  let cx = innerX;
  for (const col of columns) {
    ctx.fillText(col.label, cx + col.width / 2, headerTop + TABLE_HEADER_H / 2);
    cx += col.width;
  }
  // 表头底部分隔线
  ctx.fillStyle = M3.surfaceContainerHighest;
  ctx.fillRect(innerX, headerTop + TABLE_HEADER_H - 1, innerW, 1);
}

// 底部信息行
function drawFooter(ctx: SKRSContext2D, layout: Layout, text: string): void {
  ctx.font = `16px ${FONT_FAMILY}`;
  ctx.fillStyle = M3.onSurfaceVariant;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const footerY = layout.cardY + layout.cardH - FOOTER_H / 2;
  ctx.fillText(text, layout.width / 2, footerY);
}

// 增量展示配置（分速/时速共用同一设计，仅文案不同）
export interface SpeedImageOptions {
  pill: string; // 右上标签：'分速' | '时速'
  incrementLabel: string; // 增量列名：'分速增量' | '上一整点时速'
  windowStart: number; // 统计窗口起止，用于副标题
  windowEnd: number;
  // 48h 热力图（uid -> 48 个活跃分钟数），仅时速表传入；传入后每位玩家信息行下方渲染一条热力条
  heatmap?: Map<string, number[]>;
}

// 热力图配色：5 档紫色渐变线性插值，intensity 0→1（浅→深）
function heatColor(intensity: number): { bg: string; fg: string } {
  const stops: readonly (readonly [number, number, number, number])[] = [
    [0.0, 245, 239, 249], // #F5EFF9 近白淡紫
    [0.2, 230, 221, 247], // #E6DDF7
    [0.45, 199, 179, 234], // #C7B3EA
    [0.7, 142, 111, 211], // #8E6FD3
    [1.0, 94, 62, 158], //   #5E3E9E 深紫
  ];
  const t = Math.max(0, Math.min(1, intensity));
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [t0, r0, g0, b0] = stops[i];
  const [t1, r1, g1, b1] = stops[i + 1];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const r = Math.round(r0 + (r1 - r0) * f);
  const g = Math.round(g0 + (g1 - g0) * f);
  const b = Math.round(b0 + (b1 - b0) * f);
  return {
    bg: `rgb(${r}, ${g}, ${b})`,
    fg: intensity > 0.55 ? '#FFFFFF' : M3.onSurfaceVariant,
  };
}

// 在信息行下方绘制 48h 热力条（左新右旧），每格一个数字 + 颜色深度（数字越大颜色越深）。
// 「现在」标签在左侧、「48h前」在右侧、与格子垂直居中，不占用额外的标签行。
function drawHeatmap(
  ctx: SKRSContext2D,
  layout: Layout,
  uid: string,
  heatmap: Map<string, number[]>,
  globalMax: number,
  top: number,
): void {
  const counts = heatmap.get(uid);
  ctx.save();
  const left = layout.innerX;
  const cellY = top + HEATMAP_GAP_TOP;

  // 标签 + 格子整组水平居中
  const leftLabel = '现在';
  const rightLabel = '48h前';
  ctx.font = `12px ${FONT_FAMILY}`;
  const lw = ctx.measureText(leftLabel).width;
  const rw = ctx.measureText(rightLabel).width;
  const gap = 8;
  const groupW = lw + gap + HEATMAP_W + gap + rw;
  const x0 = left + (layout.innerW - groupW) / 2;
  const stripLeft = x0 + lw + gap;

  // 格子：第 c 列 = 数组倒数第 c+1 个（最新在左）
  const cy = cellY + HEATMAP_CELL_H / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let c = 0; c < HEATMAP_N; c++) {
    const v = counts?.[HEATMAP_N - 1 - c] ?? 0;
    const { bg, fg } = heatColor(globalMax > 0 ? v / globalMax : 0);
    const x = stripLeft + c * (HEATMAP_CELL_W + HEATMAP_GAP);
    roundRect(ctx, x, cellY, HEATMAP_CELL_W, HEATMAP_CELL_H, 5);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.font = `bold 13px ${FONT_FAMILY}`;
    ctx.fillStyle = fg;
    ctx.fillText(String(v), x + HEATMAP_CELL_W / 2, cy + 0.5);
  }

  // 左右标签
  ctx.font = `12px ${FONT_FAMILY}`;
  ctx.fillStyle = M3.onSurfaceVariant;
  ctx.textAlign = 'left';
  ctx.fillText(leftLabel, x0, cy);
  ctx.textAlign = 'right';
  ctx.fillText(rightLabel, x0 + groupW, cy);
  ctx.restore();
}

// 渲染增量图片（固定 1600×740，Material Design 3 风格）。
// 表格按 PT 降序，增量前三名整行金/银/铜高亮。
export async function renderSpeedImage(
  event: BestdoriEvent,
  players: TopPlayer[], // 按 PT 降序（rank 1..10）
  opts: SpeedImageOptions,
): Promise<Buffer> {
  const n = Math.max(1, players.length);
  const showHeatmap = Boolean(opts.heatmap);
  const { ctx, layout } = createCard(n, showHeatmap);
  const { innerX, innerW, headerTop, rowH } = layout;

  // 当前是活动第几天
  const day = eventDayNumber(event, Date.now());

  // 分差：与上一名（PT 高一位）的差值；第 1 名无上一名，记 0
  const gaps = players.map((p, i) => (i === 0 ? 0 : players[i - 1].pt - p.pt));

  drawHeader(ctx, event, layout, { pill: opts.pill });

  const columns = [
    { key: 'rank', label: '位次', width: 90 },
    { key: 'uid', label: 'UID', width: 210 },
    { key: 'name', label: '名字', width: 240 },
    { key: 'pt', label: '当前PT', width: 270 },
    { key: 'ptGap', label: '分差', width: 140 },
    { key: 'speed', label: opts.incrementLabel, width: 256 },
    { key: 'signature', label: '签名', width: 282 },
  ] as const;

  drawTableHeader(ctx, layout, columns);

  // 热力图全局最大值，颜色深度按它归一化。
  // 只统计本表显示的玩家（前 10 名）：computeHourlyActivity 会返回所有采样玩家，
  // 若把榜外玩家算进来，其爆肝小时会把 globalMax 拉高、让可见行整体偏浅。
  let globalMax = 0;
  if (showHeatmap) {
    for (const p of players) {
      const arr = opts.heatmap!.get(p.uid);
      if (!arr) continue;
      for (const v of arr) if (v > globalMax) globalMax = v;
    }
  }

  // 按增量降序给前 3 名行标金/银/铜（决定整行底色）；只统计正增量，0 增量不参与排名
  const tintRank = new Map<number, 1 | 2 | 3>();
  players
    .map((p, i) => ({ i, speed: p.speed }))
    .filter((x) => x.speed > 0)
    .sort((a, b) => b.speed - a.speed)
    .slice(0, 3)
    .forEach((x, k) => {
      tintRank.set(x.i, (k + 1) as 1 | 2 | 3);
    });

  // 正增量最后一名：增量最小但仍为正的那名（若已得金/银/铜则不叠加淡粉）
  let lastPositiveIndex = -1;
  let minPositiveSpeed = Infinity;
  players.forEach((p, i) => {
    if (p.speed > 0 && p.speed < minPositiveSpeed) {
      minPositiveSpeed = p.speed;
      lastPositiveIndex = i;
    }
  });

  const heatH = showHeatmap ? HEATMAP_H : 0;
  const tableX = innerX;
  players.forEach((p, i) => {
    // 整块（信息行 + 热力条）的位置与高度
    const blockTop = headerTop + TABLE_HEADER_H + i * (rowH + heatH);
    const blockH = rowH + heatH;
    const rowTop = blockTop;
    // 整块底色：增量前 3 名金/银/铜；正增量最后一名淡粉；其余表面色
    const rank = tintRank.get(i);
    ctx.fillStyle = rank ? ROW_TINTS[rank - 1] : i === lastPositiveIndex ? LAST_GAIN_TINT : M3.surface;
    ctx.fillRect(tableX, blockTop, innerW, blockH);

    // 信息行文字必须垂直居中（drawHeatmap 会改动 textBaseline，这里显式复位防止影响后续行）
    ctx.textBaseline = 'middle';

    let cx = tableX;
    for (const col of columns) {
      const cellY = rowTop + rowH / 2;
      const colX = cx + col.width / 2; // 内容居中
      ctx.textAlign = 'center';

      if (col.key === 'rank') {
        // 位次圆
        const cx0 = cx + col.width / 2;
        const r = 21;
        ctx.beginPath();
        ctx.arc(cx0, cellY, r, 0, Math.PI * 2);
        ctx.fillStyle = M3.surfaceContainerHighest;
        ctx.fill();
        ctx.fillStyle = M3.onSurface;
        ctx.font = `bold 22px ${FONT_FAMILY}`;
        ctx.fillText(String(p.rank), cx0, cellY + 0.5);
      } else if (col.key === 'uid') {
        ctx.font = `22px ${FONT_FAMILY}`;
        ctx.fillStyle = M3.primary;
        ctx.fillText(p.uid, colX, cellY);
      } else if (col.key === 'name') {
        // 名字：28px 过长会被截断，改用 24px，尽量让长名完整显示
        ctx.font = `bold 24px ${FONT_FAMILY}`;
        ctx.fillStyle = M3.onSurface;
        ctx.fillText(truncate(ctx, p.name, col.width - 20), colX, cellY);
      } else if (col.key === 'pt') {
        // 数字与 "Pt" 分开：数字用次级强调色，Pt 用次要色；主题仍留给增量列
        const numText = formatNum(p.pt);
        const ptLabel = 'Pt';
        ctx.font = `bold 30px ${FONT_FAMILY}`;
        ctx.fillStyle = M3.pt;
        const numW = ctx.measureText(numText).width;
        ctx.font = `600 20px ${FONT_FAMILY}`;
        const suffixW = ctx.measureText(ptLabel).width;
        const gap = 8;
        const startX = colX - (numW + gap + suffixW) / 2;
        ctx.font = `bold 30px ${FONT_FAMILY}`;
        ctx.fillText(numText, startX + numW / 2, cellY);
        ctx.fillStyle = M3.onSurfaceVariant;
        ctx.font = `600 20px ${FONT_FAMILY}`;
        ctx.fillText(ptLabel, startX + numW + gap + suffixW / 2, cellY);
      } else if (col.key === 'ptGap') {
        // 分差：与上一名的 PT 差值（第 1 名为 0）
        ctx.font = `bold 22px ${FONT_FAMILY}`;
        ctx.fillStyle = M3.onSurfaceVariant;
        ctx.fillText(formatNum(gaps[i]), colX, cellY);
      } else if (col.key === 'speed') {
        // 增量数字，图的主体
        ctx.font = `bold 36px ${FONT_FAMILY}`;
        if (p.speed >= 0) {
          ctx.fillStyle = p.speed > 0 ? M3.increment : M3.onSurfaceVariant;
          ctx.fillText(p.speed > 0 ? `+${formatNum(p.speed)}` : '0', colX, cellY);
        } else {
          ctx.fillStyle = M3.onSurfaceVariant;
          ctx.fillText('—', colX, cellY);
        }
      } else if (col.key === 'signature') {
        // 签名：字号小，超长换两行
        ctx.font = `italic 20px ${FONT_FAMILY}`;
        ctx.fillStyle = M3.onSurfaceVariant;
        const sig = p.signature || '—';
        const lines = wrapText(ctx, sig, col.width - 20, 2);
        if (lines.length <= 1) {
          ctx.fillText(lines[0] ?? '—', colX, cellY);
        } else {
          const lineH = 25; // 行距
          ctx.fillText(lines[0], colX, cellY - lineH / 2 + 2);
          ctx.fillText(lines[1], colX, cellY + lineH / 2 + 2);
        }
      }
      cx += col.width;
    }

    // 48h 热力条（信息行下方）
    if (showHeatmap) {
      drawHeatmap(ctx, layout, p.uid, opts.heatmap!, globalMax, blockTop + rowH);
    }

    // 行分隔线（画在整块底部）
    ctx.fillStyle = M3.surfaceContainerHighest;
    ctx.fillRect(tableX, blockTop + blockH - 1, innerW, 1);
  });

  drawFooter(
    ctx,
    layout,
    `活动第 ${day} 日　·　${opts.incrementLabel}　${formatTime(opts.windowStart)} ~ ${formatTime(opts.windowEnd)}　·　数据来源 Bestdori` +
      (showHeatmap ? '　·　48h热力图' : ''),
  );
  return ctx.canvas.toBuffer('image/png');
}
