import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { failure } from "./diagnostics.ts";

/** Normalize OS identifiers without exposing them. / 规范化系统标识，不向外暴露。 */
export function machineHash(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/-/g, "");
  if (!/^[a-f0-9]{32}$/.test(normalized) || /^0+$/.test(normalized))
    throw failure("MACHINE_ID");
  return createHash("sha256")
    .update(`pi-information-protecter:v1:${normalized}`)
    .digest("hex")
    .slice(0, 32);
}

/** No random fallback: unavailable IDs must fail closed. / 不随机回退，标识不可用时拒绝初始化。 */
export function getMachineHash(): string {
  try {
    if (process.platform === "linux")
      return machineHash(readFileSync("/etc/machine-id", "utf8"));
    if (process.platform === "darwin") {
      const text = execFileSync(
        "/usr/sbin/ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return machineHash(
        text.match(/"IOPlatformUUID"\s*=\s*"([a-fA-F0-9-]+)"/)?.[1] ?? "",
      );
    }
    if (process.platform === "win32") {
      const text = execFileSync(
        "reg.exe",
        [
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
          "/v",
          "MachineGuid",
          "/reg:64",
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 65536,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return machineHash(
        text.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9-]+)/i)?.[1] ?? "",
      );
    }
  } catch {
    /* Do not expose command output. / 不暴露命令输出。 */
  }
  throw failure("MACHINE_ID");
}
