import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_API_KEY_ENV } from "../../shared/constants/model.ts";
import type { AnalysisProvider } from "../../shared/contracts/enums.ts";
import type { ProcessingMode } from "../ingest/provider.ts";

/**
 * 凭证档位：两家端点、两份密钥文件（草案 §六 对这一行的处置）。
 *
 * 它是 `Extract<ProcessingMode, …>`，所以第 4 个模式 `cloud_raw` **不**在此列：档位描述的是
 * 「连的是谁、用哪份密钥」，与「发的是原文还是脱敏文本」正交。给 `cloud_raw` 单开
 * `cloud_raw.key` 等于把同一把密钥抄进第二个文件——多一个泄露面，还会让用户以为那是一条
 * 独立的隐私承诺。`cloud_raw` 复用云端档位，见 `credentialProfileFor`。
 */
export type CredentialProfile = Extract<ProcessingMode, "local_model" | "cloud_redacted">;
export type ApiKeySource = "saved" | "environment" | "none";

/**
 * 三轴的 `analysis_provider` → 凭证档位。装配层按这一条选密钥，**不按 `processing_mode` 分支**。
 *
 * `none` 没有档位：没有分析者就没有任何一次调用，也就没有取密钥的理由。这里抛而不是兜到云端——
 * 兜底等于把「不发送」的记录接到一条会发送的路上。
 */
export function credentialProfileFor(analysisProvider: AnalysisProvider): CredentialProfile {
  if (analysisProvider === "local") return "local_model";
  if (analysisProvider === "cloud") return "cloud_redacted";
  throw new Error("analysis_provider=none 不调用任何模型，没有凭证档位");
}

export interface ResolvedApiKey {
  readonly key: string | undefined;
  readonly source: ApiKeySource;
}

/**
 * Replaceable credential boundary. The file implementation below is deliberately small;
 * a future OS keychain adapter can implement the same interface without changing callers.
 */
export interface CredentialStore {
  read(profile: CredentialProfile): string | undefined;
  write(profile: CredentialProfile, secret: string): void;
  clear(profile: CredentialProfile): void;
  resolve(
    profile: CredentialProfile,
    apiKeyEnv: string,
    env?: NodeJS.ProcessEnv,
  ): ResolvedApiKey;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export class FileCredentialStore implements CredentialStore {
  readonly secretsDir: string;

  constructor(secretsDir: string) {
    this.secretsDir = secretsDir;
  }

  private fileFor(profile: CredentialProfile): string {
    return join(this.secretsDir, `${profile}.key`);
  }

  read(profile: CredentialProfile): string | undefined {
    try {
      return nonEmpty(readFileSync(this.fileFor(profile), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  write(profile: CredentialProfile, secret: string): void {
    const value = nonEmpty(secret);
    if (value === undefined) {
      throw new Error("拒绝写入空白模型密钥");
    }

    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.secretsDir, 0o700);

    const target = this.fileFor(profile);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, `${value}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, target);
      if (process.platform !== "win32") chmodSync(target, 0o600);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  clear(profile: CredentialProfile): void {
    try {
      unlinkSync(this.fileFor(profile));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  resolve(
    profile: CredentialProfile,
    apiKeyEnv: string = DEFAULT_API_KEY_ENV,
    env: NodeJS.ProcessEnv = process.env,
  ): ResolvedApiKey {
    const saved = this.read(profile);
    if (saved !== undefined) return { key: saved, source: "saved" };
    const fromEnv = nonEmpty(env[apiKeyEnv]);
    return fromEnv === undefined
      ? { key: undefined, source: "none" }
      : { key: fromEnv, source: "environment" };
  }
}

export function defaultCredentialStore(env: NodeJS.ProcessEnv = process.env): FileCredentialStore {
  const home = nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? homedir();
  return new FileCredentialStore(join(home, ".thoughtsbox", "secrets"));
}
