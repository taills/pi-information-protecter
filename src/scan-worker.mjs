// A separate worker bounds user-supplied JavaScript regex execution (including ReDoS).
// 独立 worker 限制用户正则的执行时间，包括正则拒绝服务风险。
import { parentPort, workerData } from "node:worker_threads";
import { randomBytes } from "node:crypto";

// Track the active rule/node so blocks can be located without exposing content.
// 记录当前规则和节点，使拦截可定位而不暴露内容。
let activeRule;
let activeNode = 0;
function fail(code, otherRule) {
  throw { code, rule: activeRule, otherRule, node: activeNode };
}

try {
  const { payload, rules, entries, configRaws } = workerData;
  const originalToToken = new Map(
    entries.map(([token, original]) => [original, token]),
  );
  const tokenToOriginal = new Map(entries);
  const additions = [];
  const hitTokens = new Set();
  const matchers = rules.map((rule, position) => {
    const index = position + 1;
    if (typeof rule === "string") return { literal: rule, rule: index };
    if (rule.type === "literal")
      return { literal: rule.value, replacement: rule.replacement, rule: index };
    return {
      rule: index,
      replacement: rule.replacement,
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
  function tokenFor(original, replacement) {
    let token = originalToToken.get(original);
    if (token) {
      if (replacement !== undefined && token !== replacement)
        fail("FIXED_MAPPING_CONFLICT");
      return token;
    }
    if (replacement !== undefined) {
      if (tokenToOriginal.size >= 50000) fail("SCAN_MAPPING_LIMIT");
      if (
        tokenToOriginal.has(replacement) &&
        tokenToOriginal.get(replacement) !== original
      )
        fail("FIXED_ALIAS_REUSED");
      if (replacement.includes(original)) fail("FIXED_SENSITIVE_TARGET");
      originalToToken.set(original, replacement);
      tokenToOriginal.set(replacement, original);
      additions.push([replacement, original]);
      return replacement;
    }
    if (tokenToOriginal.size >= 50000) fail("SCAN_MAPPING_LIMIT");
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
      activeRule = matcher.rule;
      if (matcher.literal === undefined) {
        matcher.regex.lastIndex = 0;
        for (const match of text.matchAll(matcher.regex)) {
          if (!match[0].length) fail("SCAN_ZERO_WIDTH");
          spans.push([
            match.index,
            match.index + match[0].length,
            matcher.replacement,
            matcher.rule,
          ]);
          if (++matches > 100000) fail("SCAN_MATCH_LIMIT");
        }
      } else {
        if (!matcher.literal) continue;
        let start = 0;
        while ((start = text.indexOf(matcher.literal, start)) !== -1) {
          spans.push([
            start,
            start + matcher.literal.length,
            matcher.replacement,
            matcher.rule,
          ]);
          if (++matches > 100000) fail("SCAN_MATCH_LIMIT");
          start++; // Include overlapping occurrences. / 包含重叠匹配。
        }
      }
    }
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const span of spans) {
      const prev = merged.at(-1);
      if (prev && span[0] < prev[1]) {
        if (prev[2] !== undefined || span[2] !== undefined) {
          if (
            prev[0] !== span[0] ||
            prev[1] !== span[1] ||
            (prev[2] !== undefined &&
              span[2] !== undefined &&
              prev[2] !== span[2])
          ) {
            activeRule = prev[3];
            fail("FIXED_OVERLAP", span[3]);
          }
          if (prev[2] === undefined && span[2] !== undefined) prev[3] = span[3];
          prev[2] ??= span[2];
        }
        prev[1] = Math.max(prev[1], span[1]);
      } else merged.push([...span]);
    }
    let result = "",
      cursor = 0;
    for (const [start, end, replacement, rule] of merged) {
      activeRule = rule;
      const token = tokenFor(text.slice(start, end), replacement);
      hitTokens.add(token);
      result += text.slice(cursor, start) + token;
      cursor = end;
    }
    return result + text.slice(cursor);
  }
  function redact(text) {
    // Only OUR tokens are exempt, not arbitrary strings with a similar prefix.
    // 仅豁免本实例生成的占位符，不豁免具有相似前缀的任意字符串。
    let result = "",
      cursor = 0;
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fixedTokens = [...tokenToOriginal.keys()].filter(
      (token) => !/^__PIP_[a-f0-9]{48}__$/.test(token),
    );
    const pattern = new RegExp(
      [
        "__PIP_[a-f0-9]{48}__",
        ...fixedTokens.sort((a, b) => b.length - a.length).map(escape),
      ].join("|"),
      "g",
    );
    const protectedSpans = [...text.matchAll(pattern)].filter((match) =>
      tokenToOriginal.has(match[0]),
    );
    // Reject regex matches crossing a fixed alias; splitting must not hide secrets.
    // 拒绝跨固定别名的正则匹配，避免文本切分隐藏敏感值。
    for (const matcher of matchers) {
      if (!matcher.regex || !fixedTokens.length) continue;
      activeRule = matcher.rule;
      matcher.regex.lastIndex = 0;
      for (const hit of text.matchAll(matcher.regex)) {
        if (++matches > 100000) fail("SCAN_MATCH_LIMIT");
        if (!hit[0].length) fail("SCAN_ZERO_WIDTH");
        if (
          protectedSpans.some(
            (span) =>
              fixedTokens.includes(span[0]) &&
              hit.index < span.index + span[0].length &&
              hit.index + hit[0].length > span.index,
          )
        )
          fail("FIXED_ALIAS_CROSSING");
      }
    }
    for (const match of protectedSpans) {
      if (!tokenToOriginal.has(match[0])) continue;
      result += redactPlain(text.slice(cursor, match.index)) + match[0];
      cursor = match.index + match[0].length;
    }
    return result + redactPlain(text.slice(cursor));
  }
  function walk(value, depth = 0) {
    activeNode = ++nodes;
    activeRule = undefined;
    if (nodes > 200000 || depth > 80) fail("SCAN_COMPLEXITY");
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
          try {
            JSON.parse(outer);
          } catch {
            fail("SCAN_JSON_REWRITE");
          }
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
        fail("SCAN_ATTACHMENT");
      if (
        Object.keys(value).some((key) =>
          /^(inlineData|inline_data|fileData|file_data|image_url|input_audio)$/.test(
            key,
          ),
        )
      )
        fail("SCAN_ATTACHMENT");
      const result = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        const nextKey = redact(key);
        if (Object.hasOwn(result, nextKey)) fail("SCAN_KEY_COLLISION");
        result[nextKey] = walk(item, depth + 1);
      }
      return result;
    }
    if (value === null || typeof value === "boolean") return value;
    fail("PAYLOAD_JSON");
  }
  const redacted = walk(payload);
  function containsToken(value, token, depth = 0) {
    if (depth > 80) fail("SCAN_COMPLEXITY");
    if (typeof value === "string") {
      if (value.includes(token)) return true;
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        return false;
      }
      return parsed && typeof parsed === "object"
        ? containsToken(parsed, token, depth + 1)
        : false;
    }
    if (Array.isArray(value))
      return value.some((item) => containsToken(item, token, depth + 1));
    if (value && typeof value === "object")
      return Object.entries(value).some(
        ([key, item]) =>
          key.includes(token) || containsToken(item, token, depth + 1),
      );
    return false;
  }
  const hits = [...hitTokens]
    .filter((token) => containsToken(redacted, token))
    .map((token) => [token, tokenToOriginal.get(token)]);
  parentPort.postMessage({ payload: redacted, additions, hits });
} catch (error) {
  // Only internal codes and numeric coordinates cross the worker boundary.
  // worker 边界仅传递内部错误码和数字定位，不传原文或原始异常。
  parentPort.postMessage({
    failed: true,
    diagnostic: {
      code: typeof error?.code === "string" ? error.code : "SCAN_INTERNAL",
      rule: error?.rule ?? activeRule,
      otherRule: error?.otherRule,
      node: error?.node ?? activeNode,
    },
  });
}
