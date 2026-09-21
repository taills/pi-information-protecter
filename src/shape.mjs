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

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const OCTET_BOUNDS = { 1: [0n, 9n], 2: [10n, 99n], 3: [100n, 255n] };

/** Keep an octet inside 0-255 so the address stays routable-looking. / 保持在 0-255 内，使地址仍然合法。 */
function reshapeOctet(octet) {
  // Leading zeros are positional and already bound the value below 100.
  // 前导零属于位置信息，且已将数值限制在 100 以内。
  if (octet.length > 1 && octet.startsWith("0")) {
    let out = "0";
    for (let index = 1; index < octet.length; index++)
      out += String(randomBelow(10n));
    return out;
  }
  const [low, high] = OCTET_BOUNDS[octet.length];
  return String(low + randomBelow(high - low + 1n));
}

/** Replace an IPv4 address with a valid one of the same digit layout. / 替换为位数布局相同的合法 IPv4。 */
export function reshapeIpv4(text) {
  const match = IPV4.exec(text);
  if (!match || match.slice(1).some((octet) => Number(octet) > 255))
    return undefined;
  return match.slice(1).map(reshapeOctet).join(".");
}

/** Hex digits must stay hex or the address stops parsing. / 十六进制字符必须仍为十六进制，否则无法解析。 */
function reshapeHex(text) {
  let out = "";
  for (const char of text) {
    if (char >= "0" && char <= "9") out += String(randomBelow(10n));
    else if (char >= "a" && char <= "f")
      out += String.fromCharCode(0x61 + Number(randomBelow(6n)));
    else if (char >= "A" && char <= "F")
      out += String.fromCharCode(0x41 + Number(randomBelow(6n)));
    else out += char;
  }
  return out;
}

/**
 * Replace an IPv6 address, preserving `::`, group widths and any IPv4 tail.
 * 替换 IPv6 地址，保留 `::`、分组宽度和末尾的 IPv4 部分。
 */
export function reshapeIpv6(text) {
  if (!text.includes(":")) return undefined;
  const tail = text.lastIndexOf(":");
  const embedded = text.slice(tail + 1);
  if (embedded.includes(".")) {
    const shaped = reshapeIpv4(embedded);
    if (!shaped || !/^[0-9A-Fa-f:]*$/.test(text.slice(0, tail + 1)))
      return undefined;
    return reshapeHex(text.slice(0, tail + 1)) + shaped;
  }
  if (!/^[0-9A-Fa-f:]+$/.test(text)) return undefined;
  return reshapeHex(text);
}

/**
 * Prefer a format-aware shape, then fall back to per-script replacement.
 * 优先使用格式感知的同形值，否则回退到按文字体系替换。
 */
export function reshapeValue(text) {
  return reshapeIpv4(text) ?? reshapeIpv6(text) ?? reshapeText(text);
}

/**
 * Same digit count and no leading-zero change, so the value stays valid both
 * as text and as a JSON number. `safe` additionally caps the result at
 * `Number.MAX_SAFE_INTEGER`, which only a numeric field requires; capping a
 * long digit string would otherwise leave no candidate at all.
 * 位数一致且不改变前导零，使值在文本和 JSON 数字两种上下文都有效。
 * `safe` 额外限制在安全整数范围内，仅数值字段需要；对长数字串限制会导致无候选值。
 */
export function reshapeInteger(digits, safe = true) {
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
  const bound = safe && high > MAX_SAFE ? MAX_SAFE : high;
  if (bound < low) return undefined;
  return String(low + randomBelow(bound - low + 1n));
}

/**
 * Reshape a match inside a number that is not a plain digit run.
 * Exponent digits are structural and never change, a multi-digit integer part
 * never gains a leading zero, and a fractional part never gains a trailing
 * zero; each of those would stop the value round-tripping.
 * 处理数值中非纯数字串的匹配：指数属于结构不替换，多位整数部分不产生前导零，
 * 小数部分不产生末尾零，否则数值无法精确往返。
 */
export function reshapeNumericPart(text) {
  const split = /^([0-9.+-]*?)([eE][+-]?\d+)?$/.exec(text);
  if (!split || !/\d/.test(split[1])) return undefined;
  const mantissa = split[1];
  const exponent = split[2] ?? "";
  const dot = mantissa.indexOf(".");
  const lastDigit = mantissa.search(/\d(?!.*\d)/);
  const digitsBefore = dot === -1 ? mantissa.length : dot;
  let out = "";
  for (const [index, char] of [...mantissa].entries()) {
    if (char < "0" || char > "9") {
      out += char;
      continue;
    }
    const integerPart = dot === -1 || index < dot;
    const leading = integerPart && !/\d/.test(out);
    const trailing = !integerPart && index === lastDigit;
    // A lone zero is the value itself, not a padding digit. / 孤立的零是数值本身，不是填充位。
    if (char === "0" && (leading || trailing)) {
      out += "0";
      continue;
    }
    const avoidZero = (leading && digitsBefore > 1) || trailing;
    out += String(avoidZero ? 1n + randomBelow(9n) : randomBelow(10n));
  }
  return out + exponent;
}

/** Numeric JSON values must round-trip exactly to stay schema-valid. / 数值必须精确往返才能保持结构有效。 */
export function numericRoundTrips(text) {
  const value = Number(text);
  return Number.isFinite(value) && String(value) === text;
}
