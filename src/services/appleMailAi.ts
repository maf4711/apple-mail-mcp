/**
 * Bridge to the on-device Swift helper (Foundation Models / Apple Intelligence).
 *
 * Binary: build/apple-mail-ai (from swift-helper/)
 * Override: APPLE_MAIL_MCP_AI_HELPER
 *
 * @module services/appleMailAi
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { MessageCluster } from "./categoryCluster.js";
import { finalizeClusterName } from "./categoryCluster.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveAppleMailAiBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.APPLE_MAIL_MCP_AI_HELPER && existsSync(env.APPLE_MAIL_MCP_AI_HELPER)) {
    return env.APPLE_MAIL_MCP_AI_HELPER;
  }
  // From src/services → ../../build; from bundled build/index.js → ./apple-mail-ai
  const candidates = [
    join(__dirname, "..", "..", "build", "apple-mail-ai"),
    join(__dirname, "apple-mail-ai"),
    join(process.cwd(), "build", "apple-mail-ai"),
    join(process.cwd(), "swift-helper", ".build", "release", "apple-mail-ai"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface AppleAiStatus {
  available: boolean;
  availability?: string;
  reason?: string;
  error?: string;
  binary?: string | null;
}

export function appleAiStatus(env: NodeJS.ProcessEnv = process.env): AppleAiStatus {
  const bin = resolveAppleMailAiBinary(env);
  if (!bin) return { available: false, error: "apple-mail-ai binary not found", binary: null };
  const r = spawnSync(bin, ["status"], { encoding: "utf8", timeout: 30_000 });
  if (r.error) return { available: false, error: r.error.message, binary: bin };
  try {
    const j = JSON.parse((r.stdout || "").trim()) as {
      available?: boolean;
      availability?: string;
      reason?: string;
      error?: string;
    };
    return {
      available: !!j.available,
      availability: j.availability,
      reason: j.reason,
      error: j.error,
      binary: bin,
    };
  } catch {
    return {
      available: false,
      error: `bad status output: ${(r.stdout || r.stderr || "").slice(0, 200)}`,
      binary: bin,
    };
  }
}

export interface AppleAiNameResult {
  names: Record<string, string>;
  usedAppleAI: boolean;
  error?: string;
  model?: string;
  details?: { id: string; mailbox: string; kind: string; confidence: number }[];
}

/**
 * Name clusters via on-device SystemLanguageModel.
 * Returns usedAppleAI=false on any failure (caller falls back).
 */
export function nameClustersWithAppleAI(
  clusters: MessageCluster[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): AppleAiNameResult {
  const env = opts.env ?? process.env;
  const bin = resolveAppleMailAiBinary(env);
  if (!bin) {
    return { names: {}, usedAppleAI: false, error: "apple-mail-ai binary not found" };
  }
  if (clusters.length === 0) {
    return { names: {}, usedAppleAI: true, model: "SystemLanguageModel" };
  }

  const payload = clusters.map((c) => ({
    id: c.key,
    domain: c.domain,
    count: c.messages.length,
    senders: c.sampleSenders.slice(0, 3),
    subjects: c.sampleSubjects.slice(0, 5),
  }));

  const r = spawnSync(bin, ["name-clusters"], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...env },
  });

  if (r.error) {
    return { names: {}, usedAppleAI: false, error: r.error.message };
  }
  if (r.status !== 0) {
    return {
      names: {},
      usedAppleAI: false,
      error: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 300),
    };
  }

  try {
    const j = JSON.parse((r.stdout || "").trim()) as {
      ok?: boolean;
      names?: Record<string, string>;
      details?: { id: string; mailbox: string; kind: string; confidence: number }[];
      error?: string;
      model?: string;
    };
    if (!j.ok || !j.names) {
      return { names: {}, usedAppleAI: false, error: j.error || "apple-mail-ai ok=false" };
    }
    const names: Record<string, string> = {};
    for (const c of clusters) {
      const raw = j.names[c.key];
      names[c.key] = raw ? finalizeClusterName(raw, c.fallbackName) : c.fallbackName;
    }
    return {
      names,
      usedAppleAI: true,
      model: j.model || "SystemLanguageModel",
      details: j.details,
    };
  } catch (e) {
    return {
      names: {},
      usedAppleAI: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
