import { parentPort, workerData } from "node:worker_threads";

try {
  for (const config of workerData) {
    for (const rule of config.sensitiveWords) {
      if (typeof rule === "object" && rule.type === "regex" && new RegExp(rule.pattern, rule.flags ?? "").test("")) throw new Error();
    }
  }
  parentPort.postMessage(true);
} catch {
  // Return no rules or parser errors. / 不返回规则或解析错误。
  parentPort.postMessage(false);
}
