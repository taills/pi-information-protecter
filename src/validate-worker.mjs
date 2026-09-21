// Validate user regexes and fixed aliases inside a bounded worker.
// 在限时 worker 内验证用户正则和固定别名。
import { parentPort, workerData } from "node:worker_threads";

let activeRule;
function fail(code, otherRule) {
  throw { code, rule: activeRule, otherRule };
}

try {
  for (const config of workerData) {
    const rules = config.sensitiveWords;
    const numbered = rules.map((rule, position) => ({
      rule,
      index: position + 1,
    }));
    const fixed = numbered.filter(
      (entry) =>
        typeof entry.rule === "object" && entry.rule.replacement !== undefined,
    );
    for (const entry of numbered) {
      activeRule = entry.index;
      if (
        typeof entry.rule === "object" &&
        entry.rule.type === "regex" &&
        new RegExp(entry.rule.pattern, entry.rule.flags ?? "").test("")
      )
        fail("CONFIG_EMPTY_MATCH");
    }
    for (let i = 0; i < fixed.length; i++) {
      const target = fixed[i].rule.replacement;
      activeRule = fixed[i].index;
      // Reject sensitive targets and substring-ambiguous inverse mappings.
      // 拒绝仍含敏感内容的目标，以及子串导致的反向映射歧义。
      for (const entry of numbered) {
        const rule = entry.rule;
        if (
          typeof rule === "string"
            ? target.includes(rule) || rule.includes(target)
            : rule.type === "literal"
              ? target.includes(rule.value) || rule.value.includes(target)
              : new RegExp(rule.pattern, rule.flags ?? "").test(target)
        )
          fail("CONFIG_SENSITIVE_TARGET", entry.index);
      }
      for (let j = 0; j < i; j++) {
        const previous = fixed[j];
        const other = previous.rule.replacement;
        if (!target.includes(other) && !other.includes(target)) continue;
        if (JSON.stringify(fixed[i].rule) === JSON.stringify(previous.rule))
          continue;
        fail("CONFIG_ALIAS_CONFLICT", previous.index);
      }
    }
  }
  parentPort.postMessage(true);
} catch (error) {
  // Return codes and rule numbers only, never rules or parser messages.
  // 仅返回错误码和规则序号，不返回规则内容或解析消息。
  parentPort.postMessage({
    code: typeof error?.code === "string" ? error.code : "CONFIG_SCHEMA",
    rule: error?.rule ?? activeRule,
    otherRule: error?.otherRule,
  });
}
