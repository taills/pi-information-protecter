import { parentPort, workerData } from "node:worker_threads";

try {
  for (const config of workerData) {
    const rules = config.sensitiveWords;
    const fixed = rules.filter(
      (rule) => typeof rule === "object" && rule.replacement !== undefined,
    );
    for (const rule of rules) {
      if (
        typeof rule === "object" &&
        rule.type === "regex" &&
        new RegExp(rule.pattern, rule.flags ?? "").test("")
      )
        throw new Error();
    }
    for (let i = 0; i < fixed.length; i++) {
      const target = fixed[i].replacement;
      // Reject sensitive targets and substring-ambiguous inverse mappings.
      // 拒绝仍含敏感内容的目标，以及子串导致的反向映射歧义。
      for (const rule of rules) {
        if (
          typeof rule === "string"
            ? target.includes(rule) || rule.includes(target)
            : rule.type === "literal"
              ? target.includes(rule.value) || rule.value.includes(target)
              : new RegExp(rule.pattern, rule.flags ?? "").test(target)
        )
          throw new Error();
      }
      for (let j = 0; j < i; j++) {
        const previous = fixed[j];
        if (
          !target.includes(previous.replacement) &&
          !previous.replacement.includes(target)
        )
          continue;
        const same = JSON.stringify(fixed[i]) === JSON.stringify(previous);
        if (!same) throw new Error();
      }
    }
  }
  parentPort.postMessage(true);
} catch {
  // Return no rules or parser errors. / 不返回规则或解析错误。
  parentPort.postMessage(false);
}
