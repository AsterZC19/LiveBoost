import type { Lang } from './ai.js';
import { EXTENDED_EMOJI_NAMES } from './emojiData.js';

// 常见 emoji 的中文和日文名称。朗读时使用所在语种读出名称。
const EMOJI_NAMES: Record<string, { zh: string; ja: string }> = {
  // ===== 笑脸 / 表情 =====
  '😀': { zh: '露齿笑', ja: 'ニッコリ' },
  '😁': { zh: '呲牙笑', ja: 'にやにや' },
  '😂': { zh: '笑哭', ja: '泣き笑い' },
  '🤣': { zh: '笑得打滚', ja: '転げ笑い' },
  '😅': { zh: '尴尬', ja: '冷や汗' },
  '😊': { zh: '微笑', ja: 'にっこり' },
  '😉': { zh: '眨眼', ja: 'ウインク' },
  '😍': { zh: '着迷', ja: 'うっとり' },
  '😘': { zh: '飞吻', ja: '投げキス' },
  '😜': { zh: '吐舌头', ja: '舌を出す' },
  '🤔': { zh: '思考', ja: '考え中' },
  '🤫': { zh: '嘘', ja: 'シー' },
  '🤐': { zh: '闭嘴', ja: '口チャック' },
  '😎': { zh: '戴墨镜', ja: 'クール' },
  '🤓': { zh: '书呆子', ja: 'オタク' },
  '😴': { zh: '睡觉', ja: '眠そう' },
  '😪': { zh: '困了', ja: '眠い' },
  '🥱': { zh: '打哈欠', ja: 'あくび' },
  '😭': { zh: '大哭', ja: 'ワンワン泣く' },
  '😢': { zh: '伤心', ja: '悲しい' },
  '😱': { zh: '惊吓', ja: 'びっくり' },
  '😨': { zh: '害怕', ja: '怖い' },
  '😰': { zh: '冒冷汗', ja: '汗びっしょり' },
  '😡': { zh: '生气', ja: '怒った顔' },
  '😤': { zh: '得意', ja: 'ふん' },
  '😇': { zh: '天使', ja: '天使' },
  '🥳': { zh: '庆祝', ja: 'お祝い' },
  '🤩': { zh: '星星眼', ja: 'キラキラ' },
  '🤗': { zh: '拥抱', ja: 'ハグ' },
  '🤯': { zh: '头炸了', ja: '頭が爆発' },
  '🥺': { zh: '委屈', ja: '上目遣い' },
  '😷': { zh: '戴口罩', ja: 'マスク' },
  '🤮': { zh: '呕吐', ja: '吐き気' },
  '🤧': { zh: '打喷嚏', ja: 'くしゃみ' },
  '🥴': { zh: '头晕', ja: 'ふらふら' },
  '😵': { zh: '眩晕', ja: '目が回る' },
  '😬': { zh: '尴尬咧嘴', ja: '引きつり笑い' },
  '😳': { zh: '脸红', ja: '赤面' },
  '🙃': { zh: '倒脸', ja: '逆さの顔' },
  '🤤': { zh: '流口水', ja: 'よだれ' },
  '😑': { zh: '无语', ja: '無表情' },
  '🥹': { zh: '含泪', ja: '涙目' },

  // ===== 手势 =====
  '👍': { zh: '点赞', ja: 'いいね' },
  '👎': { zh: '倒赞', ja: 'よくないね' },
  '👏': { zh: '鼓掌', ja: '拍手' },
  '🙏': { zh: '合掌拜托', ja: 'お願い' },
  '🙌': { zh: '举手欢呼', ja: '万歳' },
  '🤝': { zh: '握手', ja: '握手' },
  '👊': { zh: '握拳', ja: 'げんこつ' },
  '✊': { zh: '举拳', ja: '拳を上げる' },
  '✌️': { zh: '胜利手势', ja: 'ピース' },
  '🤞': { zh: '交叉手指', ja: '幸運を祈る' },
  '👌': { zh: '好的手势', ja: 'オーケー' },
  '💪': { zh: '秀肌肉', ja: '力こぶ' },
  '🫶': { zh: '比心手势', ja: 'ハートの手' },
  '🤙': { zh: '打电话手势', ja: '電話サイン' },
  '👋': { zh: '挥手', ja: '手を振る' },
  '👈': { zh: '指左边', ja: '左を指す' },
  '👉': { zh: '指右边', ja: '右を指す' },
  '☝️': { zh: '指上方', ja: '上を指す' },

  // ===== 爱心 =====
  '❤️': { zh: '红心', ja: 'ハート' },
  '🧡': { zh: '橙心', ja: 'オレンジハート' },
  '💛': { zh: '黄心', ja: '黄色いハート' },
  '💚': { zh: '绿心', ja: '緑のハート' },
  '💙': { zh: '蓝心', ja: '青いハート' },
  '💜': { zh: '紫心', ja: '紫のハート' },
  '🖤': { zh: '黑心', ja: '黒いハート' },
  '🤍': { zh: '白心', ja: '白いハート' },
  '💔': { zh: '心碎', ja: '壊れたハート' },
  '💕': { zh: '两颗心', ja: 'ハート二つ' },
  '💖': { zh: '闪闪红心', ja: 'キラキラのハート' },
  '💗': { zh: '怦怦跳', ja: 'ときめき' },
  '💓': { zh: '跳动的心', ja: 'ドキドキ' },
  '💞': { zh: '旋转的心', ja: '回るハート' },
  '💘': { zh: '爱神之箭', ja: '恋の矢' },
  '💝': { zh: '礼物心', ja: 'チョコのハート' },
  '💌': { zh: '情书', ja: 'ラブレター' },

  // ===== 符号 / 物品 =====
  '✨': { zh: '闪亮', ja: 'キラキラ' },
  '⭐': { zh: '星星', ja: '星' },
  '🌟': { zh: '闪亮星星', ja: 'キラ星' },
  '🔥': { zh: '火', ja: '炎' },
  '⚡': { zh: '闪电', ja: '稲妻' },
  '💧': { zh: '水滴', ja: 'しずく' },
  '💦': { zh: '汗珠', ja: '汗' },
  '💤': { zh: '睡觉符号', ja: '眠る' },
  '💯': { zh: '一百分', ja: '百点' },
  '✅': { zh: '对勾', ja: 'チェック' },
  '❌': { zh: '叉号', ja: 'バツ' },
  '⚠️': { zh: '警告', ja: '警告' },
  '❗': { zh: '感叹号', ja: 'ビックリ' },
  '❓': { zh: '问号', ja: 'はてな' },
  '💡': { zh: '灯泡', ja: '電球' },
  '🔑': { zh: '钥匙', ja: '鍵' },
  '🔒': { zh: '上锁', ja: '鍵かける' },
  '🔓': { zh: '开锁', ja: '鍵開ける' },
  '🎁': { zh: '礼物', ja: 'プレゼント' },
  '🎂': { zh: '生日蛋糕', ja: 'バースデーケーキ' },
  '🍰': { zh: '蛋糕', ja: 'ケーキ' },
  '🍩': { zh: '甜甜圈', ja: 'ドーナツ' },
  '🍫': { zh: '巧克力', ja: 'チョコ' },
  '🍺': { zh: '啤酒', ja: 'ビール' },
  '🍻': { zh: '干杯', ja: '乾杯' },
  '🥂': { zh: '碰杯', ja: '乾杯' },
  '☕': { zh: '咖啡', ja: 'コーヒー' },
  '🍵': { zh: '茶', ja: 'お茶' },
  '🍣': { zh: '寿司', ja: '寿司' },
  '🍜': { zh: '拉面', ja: 'ラーメン' },
  '🍚': { zh: '米饭', ja: 'ご飯' },
  '🍙': { zh: '饭团', ja: 'おにぎり' },
  '🍱': { zh: '便当', ja: '弁当' },
  '🥟': { zh: '饺子', ja: '餃子' },
  '🍎': { zh: '苹果', ja: 'りんご' },
  '🍌': { zh: '香蕉', ja: 'バナナ' },
  '🍊': { zh: '橘子', ja: 'みかん' },
  '🍉': { zh: '西瓜', ja: 'すいか' },
  '🍓': { zh: '草莓', ja: 'いちご' },
  '🍑': { zh: '桃子', ja: 'もも' },
  '🀄': { zh: '麻将', ja: '麻雀' },

  // ===== 自然 / 动物 =====
  '🌸': { zh: '樱花', ja: '桜' },
  '🌹': { zh: '玫瑰', ja: 'バラ' },
  '🌻': { zh: '向日葵', ja: 'ひまわり' },
  '🌷': { zh: '郁金香', ja: 'チューリップ' },
  '🌙': { zh: '月亮', ja: '月' },
  '☀️': { zh: '太阳', ja: '太陽' },
  '🌈': { zh: '彩虹', ja: '虹' },
  '☁️': { zh: '云', ja: '雲' },
  '⛄': { zh: '雪人', ja: '雪だるま' },
  '❄️': { zh: '雪花', ja: '雪' },
  '🌊': { zh: '海浪', ja: '波' },
  '🌳': { zh: '树', ja: '木' },
  '🍃': { zh: '树叶', ja: '葉っぱ' },
  '🍀': { zh: '四叶草', ja: '四つ葉のクローバー' },
  '🍄': { zh: '蘑菇', ja: 'きのこ' },
  '🐱': { zh: '猫', ja: 'ネコ' },
  '🐶': { zh: '狗', ja: 'イヌ' },
  '🐹': { zh: '仓鼠', ja: 'ハムスター' },
  '🐰': { zh: '兔子', ja: 'ウサギ' },
  '🦊': { zh: '狐狸', ja: 'キツネ' },
  '🐻': { zh: '熊', ja: 'クマ' },
  '🐼': { zh: '熊猫', ja: 'パンダ' },
  '🐨': { zh: '考拉', ja: 'コアラ' },
  '🐯': { zh: '老虎', ja: 'トラ' },
  '🦁': { zh: '狮子', ja: 'ライオン' },
  '🐮': { zh: '奶牛', ja: 'ウシ' },
  '🐷': { zh: '猪', ja: 'ブタ' },
  '🐸': { zh: '青蛙', ja: 'カエル' },
  '🐵': { zh: '猴子', ja: 'サル' },
  '🐔': { zh: '鸡', ja: 'ニワトリ' },
  '🐧': { zh: '企鹅', ja: 'ペンギン' },
  '🐦': { zh: '鸟', ja: 'トリ' },
  '🦆': { zh: '鸭子', ja: 'アヒル' },
  '🦉': { zh: '猫头鹰', ja: 'フクロウ' },
  '🐺': { zh: '狼', ja: 'オオカミ' },
  '🐴': { zh: '马', ja: 'ウマ' },
  '🦄': { zh: '独角兽', ja: 'ユニコーン' },
  '🐝': { zh: '蜜蜂', ja: 'ハチ' },
  '🦋': { zh: '蝴蝶', ja: 'チョウ' },
  '🐢': { zh: '乌龟', ja: 'カメ' },
  '🐙': { zh: '章鱼', ja: 'タコ' },
  '🦀': { zh: '螃蟹', ja: 'カニ' },
  '🐬': { zh: '海豚', ja: 'イルカ' },
  '🐳': { zh: '鲸鱼', ja: 'クジラ' },
  '🐠': { zh: '热带鱼', ja: '熱帯魚' },
  '🦈': { zh: '鲨鱼', ja: 'サメ' },
  '🐘': { zh: '大象', ja: 'ゾウ' },
  '🦒': { zh: '长颈鹿', ja: 'キリン' },
  '🦓': { zh: '斑马', ja: 'シマウマ' },

  // ===== 人 / 活动 / 其它 =====
  '👦': { zh: '男孩', ja: '男の子' },
  '👧': { zh: '女孩', ja: '女の子' },
  '👨': { zh: '男人', ja: '男の人' },
  '👩': { zh: '女人', ja: '女の人' },
  '👴': { zh: '老爷爷', ja: 'おじいさん' },
  '👵': { zh: '老奶奶', ja: 'おばあさん' },
  '🙋': { zh: '举手', ja: '手を挙げる' },
  '🤦': { zh: '捂脸', ja: '頭を抱える' },
  '🤷': { zh: '耸肩', ja: '肩をすくめる' },
  '🙇': { zh: '鞠躬', ja: 'お辞儀' },
  '💃': { zh: '跳舞', ja: 'ダンス' },
  '🏃': { zh: '跑步', ja: '走る' },
  '🚶': { zh: '走路', ja: '歩く' },
  '🚀': { zh: '火箭', ja: 'ロケット' },
  '✈️': { zh: '飞机', ja: '飛行機' },
  '🚗': { zh: '汽车', ja: '車' },
  '🚌': { zh: '巴士', ja: 'バス' },
  '🚢': { zh: '船', ja: '船' },
  '🚉': { zh: '车站', ja: '駅' },
  '🎮': { zh: '游戏', ja: 'ゲーム' },
  '🎧': { zh: '耳机', ja: 'ヘッドホン' },
  '🎵': { zh: '音符', ja: '音符' },
  '🎶': { zh: '音符', ja: '音符' },
  '🎤': { zh: '麦克风', ja: 'マイク' },
  '🎸': { zh: '吉他', ja: 'ギター' },
  '🎹': { zh: '钢琴', ja: 'ピアノ' },
  '📱': { zh: '手机', ja: 'スマホ' },
  '💻': { zh: '电脑', ja: 'パソコン' },
  '📷': { zh: '相机', ja: 'カメラ' },
  '📺': { zh: '电视', ja: 'テレビ' },
  '⏰': { zh: '闹钟', ja: '目覚まし時計' },
  '📅': { zh: '日历', ja: 'カレンダー' },
  '📚': { zh: '书', ja: '本' },
  '📝': { zh: '便签', ja: 'メモ' },
  '💰': { zh: '钱', ja: 'お金' },
  '💎': { zh: '钻石', ja: 'ダイヤ' },
  '🏆': { zh: '奖杯', ja: 'トロフィー' },
  '🥇': { zh: '金牌', ja: '金メダル' },
  '🥈': { zh: '银牌', ja: '銀メダル' },
  '🥉': { zh: '铜牌', ja: '銅メダル' },
  '🎉': { zh: '庆祝彩带', ja: 'お祝い' },
  '🎈': { zh: '气球', ja: '風船' },
  '🎏': { zh: '鲤鱼旗', ja: '鯉のぼり' },
};

// 手工名称优先，扩展表作为本地 CLDR 风格兜底。
const ALL_EMOJI_NAMES: Record<string, { zh: string; ja: string }> = {
  ...EXTENDED_EMOJI_NAMES,
  ...EMOJI_NAMES,
};

// 启动时尝试加载官方 CLDR TTS 名称；网络不可用时继续使用本地扩展表。
const CLDR_EMOJI_NAMES: Record<string, Partial<{ zh: string; ja: string }>> = {};
let cldrLoadPromise: Promise<void> | null = null;

// 常见国旗由两个地区指示符组成。
const FLAG_NAMES: Record<string, { zh: string; ja: string }> = {
  '🇨🇳': { zh: '中国国旗', ja: '中国の国旗' },
  '🇯🇵': { zh: '日本国旗', ja: '日本の国旗' },
  '🇺🇸': { zh: '美国国旗', ja: 'アメリカの国旗' },
  '🇰🇷': { zh: '韩国国旗', ja: '韓国の国旗' },
  '🇬🇧': { zh: '英国国旗', ja: 'イギリスの国旗' },
  '🇫🇷': { zh: '法国国旗', ja: 'フランスの国旗' },
  '🇩🇪': { zh: '德国国旗', ja: 'ドイツの国旗' },
  '🇮🇹': { zh: '意大利国旗', ja: 'イタリアの国旗' },
  '🇷🇺': { zh: '俄罗斯国旗', ja: 'ロシアの国旗' },
  '🇦🇺': { zh: '澳大利亚国旗', ja: 'オーストラリアの国旗' },
  '🇨🇦': { zh: '加拿大国旗', ja: 'カナダの国旗' },
  '🇹🇼': { zh: '台湾', ja: '台湾' },
  '🇭🇰': { zh: '香港', ja: '香港' },
  '🇲🇴': { zh: '澳门', ja: 'マカオ' },
  '🇸🇬': { zh: '新加坡国旗', ja: 'シンガポールの国旗' },
  '🇹🇭': { zh: '泰国国旗', ja: 'タイの国旗' },
};

// 检测 emoji 本体。Node 支持 Unicode 属性转义。
const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const SKIN_TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/u;
const KEYCAP_RE = /^([#*0-9])(?:️)?⃣$/u;
const REGION_INDICATOR_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const EMOJI_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

function isEmoji(ch: string): boolean {
  return EMOJI_RE.test(ch);
}

function splitGraphemes(text: string): string[] {
  return Array.from(EMOJI_SEGMENTER.segment(text), ({ segment }) => segment);
}

function lookupEmojiName(sequence: string, lang: Lang): string | null {
  const direct = ALL_EMOJI_NAMES[sequence];
  if (direct) return direct[lang];

  // CLDR 会去掉部分变体选择符；同时兼容带/不带 VS16 的输入。
  const withoutVariationSelector = sequence.replace(/️/gu, '');
  const normalized = ALL_EMOJI_NAMES[withoutVariationSelector];
  if (normalized) return normalized[lang];

  if (!isEmoji(sequence)) return null;
  return CLDR_EMOJI_NAMES[sequence]?.[lang]
    ?? CLDR_EMOJI_NAMES[withoutVariationSelector]?.[lang]
    ?? null;
}

function mergeCldrLocale(payload: unknown, lang: Lang): number {
  if (!payload || typeof payload !== 'object') return 0;
  const annotations = (payload as { annotations?: { annotations?: Record<string, { tts?: unknown }> } })
    .annotations?.annotations;
  if (!annotations) return 0;

  let count = 0;
  for (const [sequence, annotation] of Object.entries(annotations)) {
    const tts = Array.isArray(annotation?.tts) && typeof annotation.tts[0] === 'string'
      ? annotation.tts[0].trim()
      : '';
    // CLDR 还包含普通标点和符号；这里只保留 emoji / 键帽 / 国旗序列。
    if (!tts || (!isEmoji(sequence) && !KEYCAP_RE.test(sequence) && !REGION_INDICATOR_RE.test(sequence))) continue;
    const entry = CLDR_EMOJI_NAMES[sequence] ?? {};
    entry[lang] = tts;
    CLDR_EMOJI_NAMES[sequence] = entry;
    count++;
  }
  return count;
}

export function loadCldrEmojiNames(): Promise<void> {
  if (cldrLoadPromise) return cldrLoadPromise;

  const sources: { lang: Lang; url: string }[] = [
    {
      lang: 'zh',
      url: 'https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/zh/annotations.json',
    },
    {
      lang: 'ja',
      url: 'https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-full/annotations/ja/annotations.json',
    },
    {
      lang: 'zh',
      url: 'https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-derived-full/annotations/zh/annotations.json',
    },
    {
      lang: 'ja',
      url: 'https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-derived-full/annotations/ja/annotations.json',
    },
  ];

  cldrLoadPromise = Promise.allSettled(
    sources.map(async ({ lang, url }) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { lang, payload: await res.json() as unknown };
    }),
  ).then((results) => {
    let count = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') count += mergeCldrLocale(result.value.payload, result.value.lang);
    }
    if (count > 0) console.log(`[emoji] 已加载 ${count} 条 CLDR emoji TTS 名称`);
    else console.warn('[emoji] CLDR emoji 数据加载失败，使用本地名称表');
  });
  return cldrLoadPromise;
}

function flagName(sequence: string, lang: Lang): string | null {
  const known = FLAG_NAMES[sequence];
  if (known) return known[lang];
  if (!REGION_INDICATOR_RE.test(sequence)) return null;

  const code = Array.from(sequence)
    .map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 0x41))
    .join('');
  const locale = lang === 'ja' ? 'ja-JP' : 'zh-CN';
  const country = new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  return lang === 'ja' ? `${country}の国旗` : `${country}国旗`;
}

function keycapName(sequence: string, lang: Lang): string | null {
  const match = KEYCAP_RE.exec(sequence);
  if (!match) return null;
  return lang === 'ja' ? `${match[1]}のキー` : `数字${match[1]}键`;
}

function skinToneName(sequence: string, lang: Lang): string | null {
  const tones = Array.from(sequence).filter((ch) => SKIN_TONE_RE.test(ch));
  if (tones.length === 0) return null;

  const base = sequence.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
  const baseName = lookupEmojiName(base, lang);
  if (!baseName) return null;

  const toneNames = lang === 'ja'
    ? { '🏻': '明るい肌色', '🏼': 'やや明るい肌色', '🏽': '中間の肌色', '🏾': 'やや暗い肌色', '🏿': '濃い肌色' }
    : { '🏻': '较浅肤色', '🏼': '中等-浅肤色', '🏽': '中等肤色', '🏾': '中等-深肤色', '🏿': '较深肤色' };
  const labels = tones.map((tone) => toneNames[tone as keyof typeof toneNames]);
  return `${baseName}：${labels.join(lang === 'ja' ? 'と' : '、')}`;
}

function emojiName(sequence: string, lang: Lang): string | null {
  return (
    flagName(sequence, lang) ??
    keycapName(sequence, lang) ??
    lookupEmojiName(sequence, lang) ??
    skinToneName(sequence, lang)
  );
}

// 判断文本是否含有能读出名称的 emoji，包括国旗和带变体选择符的组合。
export function containsEmojiName(text: string): boolean {
  return splitGraphemes(text).some((sequence) => emojiName(sequence, 'zh') !== null);
}

// 把文本里的 emoji 替换成对应语言的名称。按完整 grapheme 处理 ZWJ、肤色、旗帜和键帽组合。
export function replaceEmoji(text: string, lang: Lang): string {
  return splitGraphemes(text)
    .map((sequence) => emojiName(sequence, lang) ?? (isEmoji(sequence) ? '' : sequence))
    .join('');
}
