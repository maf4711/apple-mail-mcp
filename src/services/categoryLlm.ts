/**
 * LLM cluster naming for self-learning filter.
 *
 * Order (no IMAP required):
 *  1. On-device Apple Intelligence via `apple-mail-ai` (Foundation Models) — default
 *  2. OpenAI-compatible Chat Completions (xAI / OpenAI) when API key set
 *  3. Domain fallback names
 *
 * Env:
 *   APPLE_MAIL_MCP_AI_HELPER — path to apple-mail-ai binary
 *   APPLE_MAIL_MCP_FORCE_CLOUD_LLM=1 — skip Apple AI, use cloud only
 *   APPLE_MAIL_MCP_LLM_API_KEY or XAI_API_KEY or OPENAI_API_KEY
 *   APPLE_MAIL_MCP_LLM_BASE_URL (default https://api.x.ai/v1)
 *   APPLE_MAIL_MCP_LLM_MODEL (default grok-4-1-fast-non-reasoning)
 *
 * @module services/categoryLlm
 */
import type { MessageCluster } from "./categoryCluster.js";
import { finalizeClusterName } from "./categoryCluster.js";
import { nameClustersWithAppleAI } from "./appleMailAi.js";

export interface LlmNameResult {
  /** cluster key → mailbox name */
  names: Record<string, string>;
  usedLlm: boolean;
  /** true when SystemLanguageModel (on-device) was used */
  usedAppleAI?: boolean;
  error?: string;
  model?: string;
}

export interface LlmConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey =
    env.APPLE_MAIL_MCP_LLM_API_KEY || env.XAI_API_KEY || env.OPENAI_API_KEY || undefined;
  const baseUrl = (
    env.APPLE_MAIL_MCP_LLM_BASE_URL ||
    env.XAI_BASE_URL ||
    "https://api.x.ai/v1"
  ).replace(/\/$/, "");
  const model = env.APPLE_MAIL_MCP_LLM_MODEL || env.XAI_MODEL || "grok-4-1-fast-non-reasoning";
  return { apiKey, baseUrl, model };
}

/**
 * Name clusters. Uses LLM when configured; otherwise domain fallbacks.
 * Batches all unnamed clusters into one request for efficiency.
 */
export async function nameClusters(
  clusters: MessageCluster[],
  opts: {
    env?: NodeJS.ProcessEnv;
    /** Skip LLM even if key present */
    forceFallback?: boolean;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<LlmNameResult> {
  const env = opts.env ?? process.env;
  const cfg = resolveLlmConfig(env);
  const fallbackNames: Record<string, string> = {};
  for (const c of clusters) {
    fallbackNames[c.key] = c.fallbackName;
  }

  if (opts.forceFallback) {
    return { names: fallbackNames, usedLlm: false };
  }

  // 1) On-device Apple Intelligence (preferred — no network, no IMAP)
  const forceCloud = env.APPLE_MAIL_MCP_FORCE_CLOUD_LLM === "1";
  if (!forceCloud) {
    const apple = nameClustersWithAppleAI(clusters, { env });
    if (apple.usedAppleAI && Object.keys(apple.names).length > 0) {
      const names: Record<string, string> = { ...fallbackNames, ...apple.names };
      for (const c of clusters) {
        if (!names[c.key]) names[c.key] = c.fallbackName;
        else names[c.key] = finalizeClusterName(names[c.key]!, c.fallbackName);
      }
      return {
        names,
        usedLlm: true,
        usedAppleAI: true,
        model: apple.model || "SystemLanguageModel",
      };
    }
  }

  // 2) Cloud LLM when key present
  if (!cfg.apiKey) {
    return {
      names: fallbackNames,
      usedLlm: false,
      error: "No Apple AI naming and no cloud LLM key (build swift-helper or set XAI_API_KEY)",
    };
  }

  try {
    const names = await callLlmForNames(clusters, cfg, opts.fetchImpl ?? fetch);
    // Fill any missing with fallback
    for (const c of clusters) {
      if (!names[c.key]) names[c.key] = c.fallbackName;
      else names[c.key] = finalizeClusterName(names[c.key], c.fallbackName);
    }
    return { names, usedLlm: true, usedAppleAI: false, model: cfg.model };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { names: fallbackNames, usedLlm: false, error: msg, model: cfg.model };
  }
}

async function callLlmForNames(
  clusters: MessageCluster[],
  cfg: LlmConfig,
  fetchImpl: typeof fetch
): Promise<Record<string, string>> {
  const payload = clusters.map((c) => ({
    id: c.key,
    domain: c.domain,
    count: c.messages.length,
    senders: c.sampleSenders.slice(0, 3),
    subjects: c.sampleSubjects.slice(0, 5),
  }));

  const system = `You name email folder categories for a personal inbox.
Given clusters of messages (domain + sample subjects/senders), invent a short folder name per cluster.
Rules:
- German or English OK; prefer short proper nouns or clear themes (max 3 words).
- No presets required — invent from evidence only.
- Never use: Inbox, Sent, Trash, Junk, Drafts.
- Do not use path separators or colons.
- Return ONLY valid JSON object mapping cluster id → folder name string.
Example: {"amazon.de":"Amazon","github.com":"GitHub"}`;

  const user = `Name these clusters:\n${JSON.stringify(payload, null, 0)}`;

  const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return parseNameJson(content);
}

/** Extract JSON object from model output (tolerates fences). */
export function parseNameJson(content: string): Record<string, string> {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fence ? fence[1]!.trim() : trimmed;
  // Find outermost object
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  const obj = JSON.parse(jsonText.slice(start, end + 1)) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}
