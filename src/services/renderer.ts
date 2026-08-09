import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { FONT_FAMILY, FONT_REGULAR, FONT_MEDIUM, FONT_BOLD, config } from '../config.js';
import type { BestdoriEvent, TopPlayer } from '../types.js';
import { eventDayNumber } from './eventService.js';

// 注册 Noto Sans SC 三个字重
GlobalFonts.registerFromPath(FONT_REGULAR);
GlobalFonts.registerFromPath(FONT_MEDIUM);
GlobalFonts.registerFromPath(FONT_BOLD);

// 画布尺寸
const WIDTH = 1600;
const HEIGHT = 900;
const MARGIN = 28;
const CARD_PAD = 36;
const CARD_W = WIDTH - MARGIN * 2; // 1544
const CARD_H = HEIGHT - MARGIN * 2; // 844
const HEADER_H = 84;
const TABLE_HEADER_H = 38;
const FOOTER_H = 46;

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

function layoutFor(n: number): Layout {
  const rowsSpace = CARD_H - HEADER_H - TABLE_HEADER_H - FOOTER_H;
  const rowH = Math.max(48, Math.min(80, Math.floor(rowsSpace / Math.max(1, n))));
  return {
    width: WIDTH,
    height: HEIGHT,
    cardX: MARGIN,
    cardY: MARGIN,
    cardW: CARD_W,
    cardH: CARD_H,
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

// 建画布，画背景和卡片（固定 900 高，底部留白给投影）
function createCard(n: number): { ctx: SKRSContext2D; layout: Layout } {
  const layout = layoutFor(n);
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
  subtitle?: string;
}

// 头部：活动名 + 右上标签 + 副标题 + 分隔线
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

  // 副标题
  const metaY = titleY + 30;
  if (opts.subtitle) {
    ctx.font = `16px ${FONT_FAMILY}`;
    ctx.fillStyle = M3.onSurfaceVariant;
    ctx.fillText(opts.subtitle, innerX, metaY);
  }

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
}

// 渲染增量图片（固定 1600×900，Material Design 3 风格）。
// 表格按 PT 降序，增量前三名整行金/银/铜高亮。
export async function renderSpeedImage(
  event: BestdoriEvent,
  players: TopPlayer[], // 按 PT 降序（rank 1..10）
  opts: SpeedImageOptions,
  updatedAt: number | null,
): Promise<Buffer> {
  const n = Math.max(1, players.length);
  const { ctx, layout } = createCard(n);
  const { innerX, innerW, headerTop, rowH } = layout;

  // 当前是活动第几天
  const day = eventDayNumber(event, Date.now());

  drawHeader(ctx, event, layout, {
    pill: opts.pill,
    subtitle: `活动第 ${day} 日　·　${opts.incrementLabel}　${formatTime(opts.windowStart)} ~ ${formatTime(opts.windowEnd)}`,
  });

  const columns = [
    { key: 'rank', label: '位次', width: 90 },
    { key: 'uid', label: 'UID', width: 230 },
    { key: 'name', label: '名字', width: 270 },
    { key: 'pt', label: '当前PT', width: 280 },
    { key: 'speed', label: opts.incrementLabel, width: 320 },
    { key: 'signature', label: '签名', width: 282 },
  ] as const;

  drawTableHeader(ctx, layout, columns);

  // 按增量降序给前 3 名行标金/银/铜（决定整行底色）
  const tintRank = new Map<number, 1 | 2 | 3>();
  players
    .map((p, i) => ({ i, speed: p.speed }))
    .filter((x) => x.speed >= 0)
    .sort((a, b) => b.speed - a.speed)
    .slice(0, 3)
    .forEach((x, k) => {
      tintRank.set(x.i, (k + 1) as 1 | 2 | 3);
    });

  const tableX = innerX;
  players.forEach((p, i) => {
    const rowTop = headerTop + TABLE_HEADER_H + i * rowH;
    // 整行底色：增量前 3 名金/银/铜，其余为表面色
    const rank = tintRank.get(i);
    ctx.fillStyle = rank ? ROW_TINTS[rank - 1] : M3.surface;
    ctx.fillRect(tableX, rowTop, innerW, rowH);

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
        ctx.font = `bold 28px ${FONT_FAMILY}`;
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

    // 行分隔线
    ctx.fillStyle = M3.surfaceContainerHighest;
    ctx.fillRect(tableX, rowTop + rowH - 1, innerW, 1);
  });

  drawFooter(
    ctx,
    layout,
    `${opts.incrementLabel}　·　当前更新时间：${formatTime(updatedAt ?? Date.now())}　·　数据来源 Bestdori`,
  );
  return ctx.canvas.toBuffer('image/png');
}
