// A separate worker bounds user-supplied JavaScript regex execution (including ReDoS).
// 独立 worker 限制用户正则的执行时间，包括正则拒绝服务风险。
import { parentPort, workerData } from "node:worker_threads";
import { randomBytes } from "node:crypto";

try {
  const { payload, rules, entries, configRaws } = workerData;
  const originalToToken = new Map(
    entries.map(([token, original]) => [original, token]),
  );
  const tokenToOriginal = new Map(entries);
  const additions = [];
  const matchers = rules.map((rule) => {
    if (typeof rule === "string") return { literal: rule };
    if (rule.type === "literal") return { literal: rule.value };
    return {
      regex: new RegExp(
        rule.pattern,
        [...new Set((rule.flags ?? "") + "g")].join(""),
      ),
    };
  });
  // A restored value may lose its original regex context (e.g. a Bearer prefix).
  // 还原后的值可能失去原始正则上下文，例如 Bearer 前缀。
  // Keep learned originals protected for the lifetime of this extension instance.
  // 在当前扩展实例的整个生命周期内继续保护已识别的原文。
  for (const original of originalToToken.keys())
    matchers.push({ literal: original });
  // Defense in depth for an accidentally pasted full configuration (not a sandbox).
  // 对意外粘贴的完整配置提供纵深防护，但这不是沙箱。
  const protectedTexts = [
    ...new Set(
      configRaws.flatMap((raw) => [raw, JSON.stringify(JSON.parse(raw))]),
    ),
  ];
  for (const literal of protectedTexts) matchers.push({ literal });
  const payloadText = JSON.stringify(payload);
  let matches = 0;
  let nodes = 0;
  function tokenFor(original) {
    let token = originalToToken.get(original);
    if (token) return token;
    if (tokenToOriginal.size >= 50000) throw new Error();
    do {
      token = `__PIP_${randomBytes(24).toString("hex")}__`;
    } while (tokenToOriginal.has(token) || payloadText.includes(token));
    originalToToken.set(original, token);
    tokenToOriginal.set(token, original);
    additions.push([token, original]);
    return token;
  }
  function redactPlain(text) {
    const spans = [];
    for (const matcher of matchers) {
      if (matcher.literal === undefined) {
        matcher.regex.lastIndex = 0;
        for (const match of text.matchAll(matcher.regex)) {
          if (!match[0].length) throw new Error();
          spans.push([match.index, match.index + match[0].length]);
          if (++matches > 100000) throw new Error();
        }
      } else {
        if (!matcher.literal) continue;
        let start = 0;
        while ((start = text.indexOf(matcher.literal, start)) !== -1) {
          spans.push([start, start + matcher.literal.length]);
          if (++matches > 100000) throw new Error();
          start++; // Include overlapping occurrences. / 包含重叠匹配。
        }
      }
    }
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const span of spans) {
      const prev = merged.at(-1);
      if (prev && span[0] < prev[1]) prev[1] = Math.max(prev[1], span[1]);
      else merged.push([...span]);
    }
    let result = "",
      cursor = 0;
    for (const [start, end] of merged) {
      result += text.slice(cursor, start) + tokenFor(text.slice(start, end));
      cursor = end;
    }
    return result + text.slice(cursor);
  }
  function redact(text) {
    // Only OUR tokens are exempt, not arbitrary strings with a similar prefix.
    // 仅豁免本实例生成的占位符，不豁免具有相似前缀的任意字符串。
    let result = "",
      cursor = 0;
    for (const match of text.matchAll(/__PIP_[a-f0-9]{48}__/g)) {
      if (!tokenToOriginal.has(match[0])) continue;
      result += redactPlain(text.slice(cursor, match.index)) + match[0];
      cursor = match.index + match[0].length;
    }
    return result + redactPlain(text.slice(cursor));
  }
  function walk(value, depth = 0) {
    if (++nodes > 200000 || depth > 80) throw new Error();
    if (typeof value === "string") {
      if (protectedTexts.some((text) => value.includes(text)))
        return redact(value);
      // OpenAI serializes tool arguments as JSON strings: decode escapes BEFORE matching.
      // OpenAI 将工具参数序列化为 JSON 字符串，匹配前必须先解码转义。
      if (/^\s*[[{]/.test(value)) {
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          /* Ordinary prose. / 普通文本。 */
        }
        if (parsed && typeof parsed === "object") {
          const inner = JSON.stringify(walk(parsed, depth + 1));
          const outer = redact(inner);
          if (outer === inner) return inner;
          // A rule may span JSON syntax or match a whole JSON-shaped secret.
          // 规则可能跨越 JSON 语法，或匹配整个 JSON 形式的敏感值。
          // Return altered JSON only if it still parses; otherwise reject the request.
          // 仅返回仍可解析的修改后 JSON，否则拒绝请求。
          JSON.parse(outer);
          return outer;
        }
      }
      return redact(value);
    }
    if (typeof value === "number") {
      const transformed = redact(String(value));
      return transformed === String(value) ? value : transformed;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (value && typeof value === "object") {
      // No claim to perform OCR or redact opaque attachments. Reject rather than leak.
      // 不提供 OCR 或不透明附件脱敏，宁可拒绝请求也不放行泄漏。
      if (
        typeof value.type === "string" &&
        /image|audio|video|document|(^|_)file($|_)/i.test(value.type)
      )
        throw new Error();
      if (
        Object.keys(value).some((key) =>
          /^(inlineData|inline_data|fileData|file_data|image_url|input_audio)$/.test(
            key,
          ),
        )
      )
        throw new Error();
      const result = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        const nextKey = redact(key);
        if (Object.hasOwn(result, nextKey)) throw new Error();
        result[nextKey] = walk(item, depth + 1);
      }
      return result;
    }
    if (value === null || typeof value === "boolean") return value;
    throw new Error();
  }
  parentPort.postMessage({ payload: walk(payload), additions });
} catch {
  // Never serialize an exception, original payload or configuration back into diagnostics.
  // 不将异常、原始请求体或配置序列化到诊断信息中。
  parentPort.postMessage({ failed: true });
}
