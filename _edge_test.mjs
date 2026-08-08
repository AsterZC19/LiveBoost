// 复刻 assistService 的核心逻辑做验证
const SPEECH_KEEP = /[一-鿿ぁ-ゖァ-ヺA-Za-z0-9、。「」『』《》，！？：；‘’“”…·･.,;:!?'"()\-\s]/u;
function cleanForSpeech(text) { return Array.from(text).filter(ch => SPEECH_KEEP.test(ch)).join('').replace(/\s+/g,' ').trim(); }
function detectTextLang(text) { return /[ぁ-ゖァ-ヺ]/.test(text) ? 'ja' : 'zh'; }
function segmentText(text) {
  const segments=[]; let current=''; let currentLang=null;
  const flush=()=>{ if(current){segments.push({text:current,language:currentLang??'zh'});current='';currentLang=null;} };
  for (const ch of text) {
    let lang=null;
    if (/[ぁ-ゖァ-ヺ]/.test(ch)) lang='ja';
    else if (/[一-鿿]/.test(ch)) lang='zh';
    if (lang===null){ current+=ch; continue; }
    if (currentLang===null||currentLang===lang){ currentLang=lang; current+=ch; continue; }
    flush(); currentLang=lang; current=ch;
  }
  flush(); return segments;
}
function buildSpeakSegments(name, messageLang, content) {
  const cleanName = cleanForSpeech(name) || name;
  const nameLang = detectTextLang(cleanName);
  const lead = messageLang === 'ja' ? 'さん、' : '说，';
  const attr = nameLang === messageLang
    ? [{ text: `${cleanName}${lead}`, language: nameLang }]
    : [{ text: cleanName, language: nameLang }, { text: lead, language: messageLang }];
  const cleanContent = cleanForSpeech(content).slice(0,600);
  if (!cleanContent) return [];
  return [...attr, ...segmentText(cleanContent)];
}

console.log('== 清理 emoji/颜文字 ==');
console.log('哈哈哈😂😂(≧▽≦) →', JSON.stringify(cleanForSpeech('哈哈哈😂😂(≧▽≦)')));
console.log('こんにちは(・ω・)ﾉ →', JSON.stringify(cleanForSpeech('こんにちは(・ω・)ﾉ')));
console.log('★☆♪ 今日は →', JSON.stringify(cleanForSpeech('★☆♪ 今日は')));
console.log('纯符号 (・ω・) →', JSON.stringify(cleanForSpeech('(・ω・)')));

console.log('\n== 中文名发日文 ==');
console.log(JSON.stringify(buildSpeakSegments('钴蓝音', 'ja', 'こんにちは，元気ですか'), null, 0));
console.log('\n== 中文名发中文 ==');
console.log(JSON.stringify(buildSpeakSegments('钴蓝音', 'zh', '今天天气不错')));
console.log('\n== 日文名发中文 ==');
console.log(JSON.stringify(buildSpeakSegments('やまだ', 'zh', '你好，欢迎光临')));
console.log('\n== 日文名发日文 ==');
console.log(JSON.stringify(buildSpeakSegments('やまだ', 'ja', 'こんばんは')));
console.log('\n== 混排内容 ==');
console.log(JSON.stringify(buildSpeakSegments('钴蓝音', 'ja', '你好，こんにちは，测试，テスト')));
console.log('\n== 纯符号内容（应返回空，跳过朗读）==');
console.log(JSON.stringify(buildSpeakSegments('钴蓝音', 'zh', '😂😂(≧▽≦)')));
