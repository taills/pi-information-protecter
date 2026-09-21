// Shape-preserving replacement values keep JSON types and schemas valid.
// 形状保留的替换值可保持 JSON 类型与工具结构有效。
import { randomBytes } from "node:crypto";

// Per-script ranges; a code point is replaced only inside its own range.
// 按文字体系划分区间，码点只在同一区间内替换。
const RANGES = [
  [0x30, 0x39], // Digits / 数字
  [0x41, 0x5a], // Latin uppercase / 拉丁大写
  [0x61, 0x7a], // Latin lowercase / 拉丁小写
  [0xc0, 0xd6], // Latin-1 letters / 拉丁字母
  [0xd8, 0xf6],
  [0xf8, 0xff],
  [0x100, 0x17f], // Latin Extended-A / 拉丁扩展 A
  [0x1e00, 0x1eff], // Latin Extended Additional, incl. Vietnamese / 含越南语
  [0x391, 0x3a9], // Greek / 希腊字母
  [0x3b1, 0x3c9],
  [0x3ac, 0x3ce], // Accented Greek letters / 带重音的希腊字母
  [0x410, 0x44f], // Cyrillic / 西里尔字母
  [0x5d0, 0x5ea], // Hebrew / 希伯来语
  [0x621, 0x63a], // Arabic / 阿拉伯语
  [0x641, 0x64a],
  [0xe01, 0xe2e], // Thai consonants / 泰语辅音
  [0xe30, 0xe33], // Thai spacing vowels / 泰语空间元音
  [0xe34, 0xe3a], // Thai combining vowels / 泰语组合元音
  [0xe40, 0xe44], // Thai leading vowels / 泰语前置元音
  [0xe47, 0xe4e], // Thai tone marks / 泰语声调符号
  [0x3041, 0x3096], // Hiragana / 平假名
  [0x30a1, 0x30fa], // Katakana / 片假名
  [0xac00, 0xd7a3], // Hangul syllables / 韩文音节
  [0x4e00, 0x9fa5], // CJK unified ideographs / 中日韩统一汉字
];

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Uniform BigInt in [0, bound) via rejection sampling. / 用拒绝采样生成均匀随机数。 */
function randomBelow(bound) {
  if (bound <= 1n) return 0n;
  const bits = bound.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let attempt = 0; attempt < 64; attempt++) {
    let value = 0n;
    for (const byte of randomBytes(bytes)) value = (value << 8n) | BigInt(byte);
    value &= mask;
    if (value < bound) return value;
  }
  return bound - 1n;
}

function rangeOf(code) {
  return RANGES.find(([start, end]) => code >= start && code <= end);
}

/**
 * Replace letters and digits within their own script; keep everything else.
 * 字母和数字在同一文字体系内替换，其他字符保持不变。
 */
export function reshapeText(text) {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    const range = rangeOf(code);
    if (!range) {
      out += char;
      continue;
    }
    const [start, end] = range;
    const span = BigInt(end - start + 1);
    out += String.fromCodePoint(start + Number(randomBelow(span)));
  }
  return out;
}

/**
 * Same digit count, no leading-zero change, always a safe integer.
 * 位数一致、不改变前导零、始终保持安全整数。
 */
export function reshapeInteger(digits) {
  if (!/^\d+$/.test(digits)) return undefined;
  // A lone digit keeps its zero-ness so a leading zero never appears.
  // 单个数字保持是否为零，避免产生前导零。
  if (digits.length === 1)
    return digits === "0" ? undefined : String(1n + randomBelow(9n));
  if (digits.startsWith("0")) {
    // Leading zeros are positional, so replace digit by digit. / 前导零属于位置信息，逐位替换。
    let out = "";
    for (const digit of digits)
      out += digit === "0" ? "0" : String(1n + randomBelow(9n));
    return out;
  }
  const low = 10n ** BigInt(digits.length - 1);
  const high = 10n ** BigInt(digits.length) - 1n;
  const bound = high > MAX_SAFE ? MAX_SAFE : high;
  if (bound < low) return undefined;
  return String(low + randomBelow(bound - low + 1n));
}

/** Numeric JSON values must round-trip exactly to stay schema-valid. / 数值必须精确往返才能保持结构有效。 */
export function numericRoundTrips(text) {
  const value = Number(text);
  return Number.isFinite(value) && String(value) === text;
}
