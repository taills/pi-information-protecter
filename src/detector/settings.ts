/**
 * Optional semantic content detection through a System One decision model.
 * 通过 System One 决策模型进行的可选语义内容检测。
 *
 * Like `sensitiveWords`, everything lives in the machine configuration file
 * (`protecter.<machineHash>.json`): the model service under `detection.model`
 * and the rules under `detection.rules`. Nothing is built in; with no rules,
 * nothing is checked and startup says so.
 * 与 `sensitiveWords` 一样，所有设置都保存在机器配置文件（`protecter.<machineHash>.json`）中：
 * 模型服务位于 `detection.model`，规则位于 `detection.rules`。没有任何内置项；没有规则时
 * 不做检测，并在启动时提示。
 *
 * Unlike `sensitiveWords`, a detector cannot say WHERE a match is, so it never
 * rewrites anything: it either records a hit or blocks the content.
 * 与 `sensitiveWords` 不同，检测模型无法指出命中位置，因此从不改写内容：只记录或阻断。
 */
import { failure } from "../diagnostics.ts";

export type DetectAction = "log" | "block";
export type DetectOnError = "allow" | "block";

export interface DetectionRuleConfig {
  id: string;
  instructions: string;
  threshold?: number;
  action?: DetectAction;
  /** Also evaluate images with this rule (default true). / 是否同时检测图片（默认 true）。 */
  images?: boolean;
}

/** The decision-model service. / 决策模型服务。 */
export interface DetectionModelConfig {
  endpoint: string;
  /** Model ID for routing servers; omit for a single-model llama-server. / 路由型服务所需的模型 ID；单模型 llama-server 省略。 */
  name?: string;
  /** Environment variable holding a Bearer key; the key never lives in the file. / 存放 Bearer 密钥的环境变量名，密钥不写入文件。 */
  apiKeyEnv?: string;
  /** Requests in flight at once; rules and chunks run in parallel. / 同时在途的请求数，规则与分段并行执行。 */
  concurrency?: number;
  timeoutMs?: number;
  imageTimeoutMs?: number;
}

export interface DetectionConfig {
  enabled?: boolean;
  model: DetectionModelConfig;
  action?: DetectAction;
  onError?: DetectOnError;
  targets?: { input?: boolean; toolResults?: boolean; request?: boolean };
  images?: boolean;
  maxChars?: number;
  maxChunks?: number;
  maxImageBytes?: number;
  rules: DetectionRuleConfig[];
}

export interface DetectionRule {
  id: string;
  instructions: string;
  threshold: number;
  /** Undefined means the global action, which a session override may change. / 未设置时使用全局动作，可被会话覆盖。 */
  action?: DetectAction;
  images: boolean;
}

export interface DetectionSettings {
  /** False when the configuration has no `detection` section. / 配置中没有 `detection` 时为 false。 */
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  apiKeyEnv?: string;
  model?: string;
  action: DetectAction;
  onError: DetectOnError;
  concurrency: number;
  timeoutMs: number;
  imageTimeoutMs: number;
  targets: { input: boolean; toolResults: boolean; request: boolean };
  images: boolean;
  maxChars: number;
  maxChunks: number;
  maxImageBytes: number;
  rules: DetectionRule[];
}

export const MAX_DETECTION_RULES = 32;
const KEYS = ["enabled", "model", "action", "onError", "targets", "images", "maxChars", "maxChunks", "maxImageBytes", "rules"];
const MODEL_KEYS = ["endpoint", "name", "apiKeyEnv", "concurrency", "timeoutMs", "imageTimeoutMs"];
const RULE_KEYS = ["id", "instructions", "threshold", "action", "images"];
const TARGET_KEYS = ["input", "toolResults", "request"];

const isInt = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Reject invalid detection settings at load time, like every other setting:
 * the whole configuration fails closed. `rule` is the 1-based index in
 * `detection.rules`.
 * 与其他设置一样在加载时拒绝无效的检测配置，整份配置失败即阻断。`rule` 为
 * `detection.rules` 中从 1 开始的序号。
 */
export function validateDetection(value: unknown): void {
  const bad = (rule?: number) => failure("CONFIG_DETECTION", rule ? { rule } : {});
  if (!isObject(value) || Object.keys(value).some((key) => !KEYS.includes(key))) throw bad();
  const v = value as Record<string, unknown>;
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") throw bad();
  if (v.images !== undefined && typeof v.images !== "boolean") throw bad();
  if (v.action !== undefined && !["log", "block"].includes(v.action as string)) throw bad();
  if (v.onError !== undefined && !["allow", "block"].includes(v.onError as string)) throw bad();
  if (v.maxChars !== undefined && !isInt(v.maxChars, 200, 100000)) throw bad();
  if (v.maxChunks !== undefined && !isInt(v.maxChunks, 1, 256)) throw bad();
  if (v.maxImageBytes !== undefined && !isInt(v.maxImageBytes, 1024, 64 * 1024 * 1024)) throw bad();
  if (v.targets !== undefined) {
    if (!isObject(v.targets)) throw bad();
    for (const [key, entry] of Object.entries(v.targets))
      if (!TARGET_KEYS.includes(key) || typeof entry !== "boolean") throw bad();
  }

  // Model service. / 模型服务。
  const m = v.model;
  if (!isObject(m) || Object.keys(m).some((key) => !MODEL_KEYS.includes(key))) throw bad();
  if (typeof m.endpoint !== "string" || m.endpoint.length > 2048) throw bad();
  let url: URL;
  try {
    url = new URL(m.endpoint);
  } catch {
    throw bad();
  }
  // Credentials belong in apiKeyEnv, never in the URL. / 凭据应放在 apiKeyEnv，不得写入 URL。
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search) throw bad();
  if (m.name !== undefined && (typeof m.name !== "string" || !m.name || m.name.length > 512)) throw bad();
  if (m.apiKeyEnv !== undefined && (typeof m.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(m.apiKeyEnv)))
    throw bad();
  if (m.concurrency !== undefined && !isInt(m.concurrency, 1, 32)) throw bad();
  if (m.timeoutMs !== undefined && !isInt(m.timeoutMs, 1000, 600000)) throw bad();
  if (m.imageTimeoutMs !== undefined && !isInt(m.imageTimeoutMs, 1000, 600000)) throw bad();

  // Rules; an ID names one definition across all merged files.
  // 规则；同一 ID 在所有合并文件中只能有一种定义。
  if (!Array.isArray(v.rules) || v.rules.length > MAX_DETECTION_RULES) throw bad();
  const ids = new Set<string>();
  v.rules.forEach((rule: unknown, index) => {
    const at = index + 1;
    if (!isObject(rule) || Object.keys(rule).some((key) => !RULE_KEYS.includes(key))) throw bad(at);
    const r = rule as unknown as DetectionRuleConfig;
    if (typeof r.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(r.id) || ids.has(r.id)) throw bad(at);
    ids.add(r.id);
    if (typeof r.instructions !== "string" || !r.instructions.trim() || r.instructions.length > 4096) throw bad(at);
    if (r.threshold !== undefined && (typeof r.threshold !== "number" || !(r.threshold > 0 && r.threshold <= 1))) throw bad(at);
    if (r.action !== undefined && !["log", "block"].includes(r.action)) throw bad(at);
    if (r.images !== undefined && typeof r.images !== "boolean") throw bad(at);
  });
}

/**
 * Merge `detection` across migrated files, following the other settings:
 * rules are combined like `sensitiveWords` (identical entries kept once; one
 * ID defined two ways fails validation), the stricter `action` and `onError`
 * win like `attachments`, and the service settings come from the machine's
 * own file, which sorts first.
 * 迁移时按其他设置的规则合并 `detection`：规则像 `sensitiveWords` 一样合并（相同条目只保留一份，
 * 同一 ID 存在两种定义则校验失败）；`action` 与 `onError` 像 `attachments` 一样取更严格者；
 * 服务设置取自排在最前的本机文件。
 */
export function mergeDetection(values: DetectionConfig[]): DetectionConfig | undefined {
  if (!values.length) return undefined;
  const [first] = values;
  const seen = new Set<string>();
  const rules: DetectionRuleConfig[] = [];
  for (const value of values)
    for (const rule of value.rules) {
      const key = JSON.stringify([rule.id, rule.instructions, rule.threshold ?? null, rule.action ?? null, rule.images ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(rule);
    }
  const merged: DetectionConfig = { ...first, model: { ...first.model }, rules };
  if (values.some((value) => value.enabled !== false)) delete merged.enabled;
  const actions = values.map((value) => value.action).filter((value) => value !== undefined);
  if (actions.length) merged.action = actions.includes("block") ? "block" : "log";
  const onErrors = values.map((value) => value.onError).filter((value) => value !== undefined);
  if (onErrors.length) merged.onError = onErrors.includes("block") ? "block" : "allow";
  return merged;
}

/** Normalize a validated configuration; absent means not configured. / 规范化已校验的配置；缺省表示未配置。 */
export function detectionSettings(value: DetectionConfig | undefined): DetectionSettings {
  const rules = (value?.rules ?? []).map((rule) => ({
    id: rule.id,
    instructions: rule.instructions.trim(),
    threshold: rule.threshold ?? 0.8,
    action: rule.action,
    images: rule.images ?? true,
  }));
  return {
    configured: value !== undefined,
    enabled: value !== undefined && value.enabled !== false,
    endpoint: value?.model.endpoint ?? "",
    apiKeyEnv: value?.model.apiKeyEnv,
    model: value?.model.name,
    action: value?.action ?? "log",
    onError: value?.onError ?? "block",
    concurrency: value?.model.concurrency ?? 4,
    timeoutMs: value?.model.timeoutMs ?? 30000,
    imageTimeoutMs: value?.model.imageTimeoutMs ?? 120000,
    targets: {
      input: value?.targets?.input ?? true,
      toolResults: value?.targets?.toolResults ?? true,
      request: value?.targets?.request ?? true,
    },
    images: value?.images ?? true,
    maxChars: value?.maxChars ?? 4000,
    maxChunks: value?.maxChunks ?? 8,
    maxImageBytes: value?.maxImageBytes ?? 8 * 1024 * 1024,
    rules,
  };
}

/** True for loopback hosts: the recommended, no-network-exposure deployment. / 回环地址：推荐的、不经过网络的部署方式。 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}
