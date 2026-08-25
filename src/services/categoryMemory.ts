/**
 * Persistent category memory for the self-learning inbox filter.
 *
 * Maps sender domains (and optional full addresses) → mailbox names with
 * confidence scores. No preset categories — names come from clustering + LLM
 * (or domain fallback) and grow from usage / user corrections.
 *
 * Default path: ~/Library/Application Support/apple-mail-mcp/category-memory.json
 * Override: APPLE_MAIL_MCP_CATEGORY_MEMORY
 *
 * @module services/categoryMemory
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export const MEMORY_VERSION = 1 as const;

/** Default confidence for LLM-named clusters. */
export const CONFIDENCE_LLM = 0.75;
/** Default confidence when naming from domain only (no LLM). */
export const CONFIDENCE_DOMAIN_FALLBACK = 0.6;
/** Confidence after an explicit user correction. */
export const CONFIDENCE_CORRECTION = 0.95;
/** Auto-sort when confidence >= this (default policy). */
export const THRESHOLD_AUTO = 0.8;
/** Aggressive auto-sort floor. */
export const THRESHOLD_AGGRESSIVE = 0.5;

export interface CategoryMapping {
  /** Destination mailbox name in Apple Mail. */
  mailbox: string;
  /** Successful match/move count (learning signal). */
  hits: number;
  /** 0–1; auto-sort uses thresholds against this. */
  confidence: number;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** How the mailbox name was last set. */
  source: "llm" | "domain" | "correction" | "merge";
  /** Optional sample subjects kept for debugging / re-learn. */
  samples?: string[];
}

export interface CategoryMemory {
  version: typeof MEMORY_VERSION;
  /** key = lowercase domain or full email */
  mappings: Record<string, CategoryMapping>;
  mailboxesCreated: string[];
  updatedAt: string;
}

export function defaultMemoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APPLE_MAIL_MCP_CATEGORY_MEMORY;
  if (override && override.trim()) return override.trim();
  return join(
    homedir(),
    "Library",
    "Application Support",
    "apple-mail-mcp",
    "category-memory.json"
  );
}

export function emptyMemory(): CategoryMemory {
  return {
    version: MEMORY_VERSION,
    mappings: {},
    mailboxesCreated: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadMemory(path: string = defaultMemoryPath()): CategoryMemory {
  try {
    if (!existsSync(path)) return emptyMemory();
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CategoryMemory>;
    if (!raw || typeof raw !== "object") return emptyMemory();
    return {
      version: MEMORY_VERSION,
      mappings:
        raw.mappings && typeof raw.mappings === "object"
          ? (raw.mappings as Record<string, CategoryMapping>)
          : {},
      mailboxesCreated: Array.isArray(raw.mailboxesCreated)
        ? raw.mailboxesCreated.filter((x): x is string => typeof x === "string")
        : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptyMemory();
  }
}

export function saveMemory(memory: CategoryMemory, path: string = defaultMemoryPath()): void {
  memory.updatedAt = new Date().toISOString();
  memory.version = MEMORY_VERSION;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(memory, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Extract a stable learning key from a From header.
 * Prefers domain (amazon.de); falls back to full email lowercased.
 */
export function extractSenderKey(from: string): { key: string; domain: string; email: string } {
  const raw = (from || "").trim();
  const angle = raw.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : raw).trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at > 0 && at < email.length - 1) {
    const domain = email.slice(at + 1).replace(/[>\s]+$/g, "");
    return { key: domain, domain, email };
  }
  // No email — use a sanitized token of the whole string
  const token =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9.@_-]+/g, " ")
      .trim() || "unknown";
  return { key: token, domain: token, email: token };
}

/** Sanitize a proposed mailbox name for Apple Mail. */
export function sanitizeMailboxName(name: string, fallback = "Unsorted"): string {
  let s = (name || "").trim();
  // Strip path separators and control chars
  s = s
    .replace(/[/\\:\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Avoid empty / too long
  if (!s) s = fallback;
  if (s.length > 48) s = s.slice(0, 48).trim();
  // Reserved-ish
  const lower = s.toLowerCase();
  if (["inbox", "posteingang", "sent", "trash", "junk", "drafts"].includes(lower)) {
    s = fallback;
  }
  return s;
}

/** Domain-derived fallback mailbox name (no LLM). */
export function domainToMailboxName(domain: string): string {
  const d = (domain || "unknown").toLowerCase();
  // strip common TLD noise for friendlier folder names
  const base = d
    .replace(/^(mail|email|e-mail|newsletter|news|noreply|no-reply)\./, "")
    .replace(/\.(com|de|net|org|io|co|uk|app|ai)$/i, "");
  const parts = base.split(".").filter(Boolean);
  const label = parts.length >= 2 ? parts[parts.length - 1]! : parts[0] || d;
  // Capitalize first letter
  const pretty = label.charAt(0).toUpperCase() + label.slice(1);
  return sanitizeMailboxName(pretty, sanitizeMailboxName(d));
}

export function lookupMapping(
  memory: CategoryMemory,
  from: string
): { key: string; mapping: CategoryMapping } | null {
  const { key, email, domain } = extractSenderKey(from);
  // Prefer exact email mapping (user correction), then domain
  for (const k of [email, domain, key]) {
    const m = memory.mappings[k];
    if (m) return { key: k, mapping: m };
  }
  return null;
}

export function upsertMapping(
  memory: CategoryMemory,
  key: string,
  mailbox: string,
  opts: {
    confidence: number;
    source: CategoryMapping["source"];
    samples?: string[];
    bumpHits?: boolean;
  }
): CategoryMapping {
  const k = key.toLowerCase().trim();
  const existing = memory.mappings[k];
  const now = new Date().toISOString();
  const next: CategoryMapping = {
    mailbox: sanitizeMailboxName(mailbox),
    hits: (existing?.hits ?? 0) + (opts.bumpHits ? 1 : 0),
    confidence: clamp01(opts.confidence),
    updatedAt: now,
    source: opts.source,
    samples: opts.samples?.slice(0, 5) ?? existing?.samples,
  };
  memory.mappings[k] = next;
  if (!memory.mailboxesCreated.includes(next.mailbox)) {
    memory.mailboxesCreated.push(next.mailbox);
  }
  return next;
}

export function recordSuccessfulMove(memory: CategoryMemory, from: string): void {
  const hit = lookupMapping(memory, from);
  if (!hit) return;
  hit.mapping.hits += 1;
  hit.mapping.confidence = clamp01(Math.min(0.99, hit.mapping.confidence + 0.01));
  hit.mapping.updatedAt = new Date().toISOString();
}

export function correctMapping(
  memory: CategoryMemory,
  from: string,
  mailbox: string
): { key: string; mapping: CategoryMapping } {
  const { email, domain } = extractSenderKey(from);
  // Store on domain so future mail from same org follows; also email for precision
  const mapping = upsertMapping(memory, domain, mailbox, {
    confidence: CONFIDENCE_CORRECTION,
    source: "correction",
  });
  if (email !== domain) {
    upsertMapping(memory, email, mailbox, {
      confidence: CONFIDENCE_CORRECTION,
      source: "correction",
    });
  }
  return { key: domain, mapping };
}

export function forgetKey(memory: CategoryMemory, key: string): boolean {
  const k = key.toLowerCase().trim();
  if (!(k in memory.mappings)) return false;
  delete memory.mappings[k];
  return true;
}

export function forgetMailbox(memory: CategoryMemory, mailbox: string): number {
  const target = mailbox.trim();
  let n = 0;
  for (const [k, m] of Object.entries(memory.mappings)) {
    if (m.mailbox === target) {
      delete memory.mappings[k];
      n++;
    }
  }
  memory.mailboxesCreated = memory.mailboxesCreated.filter((x) => x !== target);
  return n;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function shouldAutoMove(
  confidence: number,
  opts: { aggressive?: boolean; threshold?: number } = {}
): boolean {
  const floor = opts.threshold ?? (opts.aggressive ? THRESHOLD_AGGRESSIVE : THRESHOLD_AUTO);
  return confidence >= floor;
}
