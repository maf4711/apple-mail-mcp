/**
 * Self-learning inbox filter orchestration: cluster → name → memory → sort plan.
 *
 * @module services/categoryFilter
 */
import {
  type CategoryMemory,
  type CategoryMapping,
  CONFIDENCE_DOMAIN_FALLBACK,
  CONFIDENCE_LLM,
  correctMapping,
  defaultMemoryPath,
  extractSenderKey,
  forgetKey,
  forgetMailbox,
  loadMemory,
  lookupMapping,
  recordSuccessfulMove,
  saveMemory,
  shouldAutoMove,
  upsertMapping,
} from "./categoryMemory.js";
import {
  type ClusterMessage,
  type MessageCluster,
  clusterByDomain,
  mergeTinyClusters,
} from "./categoryCluster.js";
import { nameClusters, resolveLlmConfig } from "./categoryLlm.js";

export interface LearnOptions {
  memoryPath?: string;
  /** Merge size-1 clusters by subject tokens */
  mergeTiny?: boolean;
  forceFallback?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface LearnResult {
  memoryPath: string;
  clusters: {
    key: string;
    domain: string;
    count: number;
    mailbox: string;
    source: CategoryMapping["source"];
    sampleSubjects: string[];
  }[];
  namedCount: number;
  usedLlm: boolean;
  llmError?: string;
  llmModel?: string;
  memory: CategoryMemory;
}

export interface SortPlanItem {
  id: string;
  from: string;
  subject: string;
  account: string;
  sourceMailbox: string;
  destMailbox: string;
  key: string;
  confidence: number;
  action: "move" | "skip";
  reason: string;
}

export interface SortPlan {
  items: SortPlanItem[];
  moveCount: number;
  skipCount: number;
  byMailbox: Record<string, string[]>; // mailbox → ids
}

/**
 * Learn from a batch of inbox messages: cluster, name (LLM or fallback),
 * write mappings into memory. Does not move mail.
 */
export async function learnFromMessages(
  messages: ClusterMessage[],
  opts: LearnOptions = {}
): Promise<LearnResult> {
  const memoryPath = opts.memoryPath ?? defaultMemoryPath(opts.env);
  const memory = loadMemory(memoryPath);

  let clusters = clusterByDomain(messages);
  if (opts.mergeTiny !== false) {
    clusters = mergeTinyClusters(clusters);
  }

  // Only call LLM for keys not already confidently named
  const needsNaming = clusters.filter((c) => {
    const existing = memory.mappings[c.key];
    return !existing || existing.confidence < 0.85 || existing.source === "domain";
  });

  const nameResult = await nameClusters(needsNaming.length > 0 ? needsNaming : clusters, {
    env: opts.env,
    forceFallback: opts.forceFallback,
    fetchImpl: opts.fetchImpl,
  });

  const clusterSummaries: LearnResult["clusters"] = [];

  for (const c of clusters) {
    const existing = memory.mappings[c.key];
    let mailbox: string;
    let source: CategoryMapping["source"];
    let confidence: number;

    if (existing && existing.confidence >= 0.85 && existing.source !== "domain") {
      // Keep strong learned/corrected names
      mailbox = existing.mailbox;
      source = existing.source;
      confidence = existing.confidence;
      upsertMapping(memory, c.key, mailbox, {
        confidence,
        source,
        samples: c.sampleSubjects,
        bumpHits: false,
      });
    } else {
      const proposed = nameResult.names[c.key] ?? c.fallbackName;
      mailbox = proposed;
      source = nameResult.usedLlm ? "llm" : "domain";
      confidence = nameResult.usedLlm ? CONFIDENCE_LLM : CONFIDENCE_DOMAIN_FALLBACK;
      // Don't downgrade a better existing mapping
      if (existing && existing.confidence > confidence && existing.mailbox) {
        mailbox = existing.mailbox;
        source = existing.source;
        confidence = existing.confidence;
      }
      upsertMapping(memory, c.key, mailbox, {
        confidence,
        source,
        samples: c.sampleSubjects,
      });
    }

    clusterSummaries.push({
      key: c.key,
      domain: c.domain,
      count: c.messages.length,
      mailbox,
      source,
      sampleSubjects: c.sampleSubjects.slice(0, 3),
    });
  }

  saveMemory(memory, memoryPath);

  return {
    memoryPath,
    clusters: clusterSummaries,
    namedCount: clusterSummaries.length,
    usedLlm: nameResult.usedLlm,
    llmError: nameResult.error,
    llmModel: nameResult.model,
    memory,
  };
}

/**
 * Build a move plan for messages using memory only (no LLM).
 */
export function planAutoSort(
  messages: ClusterMessage[],
  opts: {
    memoryPath?: string;
    aggressive?: boolean;
    threshold?: number;
    categories?: string[]; // only these destination mailboxes
    env?: NodeJS.ProcessEnv;
  } = {}
): SortPlan {
  const memoryPath = opts.memoryPath ?? defaultMemoryPath(opts.env);
  const memory = loadMemory(memoryPath);
  const items: SortPlanItem[] = [];
  const byMailbox: Record<string, string[]> = {};

  for (const m of messages) {
    const hit = lookupMapping(memory, m.sender);
    if (!hit) {
      items.push({
        id: m.id,
        from: m.sender,
        subject: m.subject,
        account: m.account,
        sourceMailbox: m.mailbox,
        destMailbox: "",
        key: extractSenderKey(m.sender).key,
        confidence: 0,
        action: "skip",
        reason: "unknown sender — run filter-learn first",
      });
      continue;
    }

    const conf = hit.mapping.confidence;
    const dest = hit.mapping.mailbox;
    if (opts.categories && opts.categories.length > 0 && !opts.categories.includes(dest)) {
      items.push({
        id: m.id,
        from: m.sender,
        subject: m.subject,
        account: m.account,
        sourceMailbox: m.mailbox,
        destMailbox: dest,
        key: hit.key,
        confidence: conf,
        action: "skip",
        reason: `filtered out (not in categories filter)`,
      });
      continue;
    }

    // Skip if already in destination
    if (m.mailbox.toLowerCase() === dest.toLowerCase()) {
      items.push({
        id: m.id,
        from: m.sender,
        subject: m.subject,
        account: m.account,
        sourceMailbox: m.mailbox,
        destMailbox: dest,
        key: hit.key,
        confidence: conf,
        action: "skip",
        reason: "already in destination mailbox",
      });
      continue;
    }

    if (!shouldAutoMove(conf, { aggressive: opts.aggressive, threshold: opts.threshold })) {
      items.push({
        id: m.id,
        from: m.sender,
        subject: m.subject,
        account: m.account,
        sourceMailbox: m.mailbox,
        destMailbox: dest,
        key: hit.key,
        confidence: conf,
        action: "skip",
        reason: `confidence ${conf.toFixed(2)} below threshold`,
      });
      continue;
    }

    items.push({
      id: m.id,
      from: m.sender,
      subject: m.subject,
      account: m.account,
      sourceMailbox: m.mailbox,
      destMailbox: dest,
      key: hit.key,
      confidence: conf,
      action: "move",
      reason: `learned ${hit.key} → ${dest}`,
    });
    (byMailbox[dest] ??= []).push(m.id);
  }

  return {
    items,
    moveCount: items.filter((i) => i.action === "move").length,
    skipCount: items.filter((i) => i.action === "skip").length,
    byMailbox,
  };
}

export function applyCorrection(
  from: string,
  mailbox: string,
  memoryPath?: string
): { key: string; mapping: CategoryMapping; memoryPath: string } {
  const path = memoryPath ?? defaultMemoryPath();
  const memory = loadMemory(path);
  const result = correctMapping(memory, from, mailbox);
  saveMemory(memory, path);
  return { ...result, memoryPath: path };
}

export function applyForget(opts: { key?: string; mailbox?: string; memoryPath?: string }): {
  removed: number;
  memoryPath: string;
} {
  const path = opts.memoryPath ?? defaultMemoryPath();
  const memory = loadMemory(path);
  let removed = 0;
  if (opts.key) {
    if (forgetKey(memory, opts.key)) removed++;
  }
  if (opts.mailbox) {
    removed += forgetMailbox(memory, opts.mailbox);
  }
  saveMemory(memory, path);
  return { removed, memoryPath: path };
}

export function bumpMoves(froms: string[], memoryPath?: string): void {
  const path = memoryPath ?? defaultMemoryPath();
  const memory = loadMemory(path);
  for (const f of froms) recordSuccessfulMove(memory, f);
  saveMemory(memory, path);
}

export function memoryStatus(memoryPath?: string, env?: NodeJS.ProcessEnv) {
  const path = memoryPath ?? defaultMemoryPath(env);
  const memory = loadMemory(path);
  const llm = resolveLlmConfig(env);
  const byMailbox: Record<string, number> = {};
  for (const m of Object.values(memory.mappings)) {
    byMailbox[m.mailbox] = (byMailbox[m.mailbox] ?? 0) + 1;
  }
  return {
    memoryPath: path,
    mappingCount: Object.keys(memory.mappings).length,
    mailboxes: memory.mailboxesCreated,
    byMailbox,
    updatedAt: memory.updatedAt,
    llmConfigured: Boolean(llm.apiKey),
    llmModel: llm.model,
    llmBaseUrl: llm.baseUrl,
    mappings: Object.entries(memory.mappings)
      .map(([key, m]) => ({
        key,
        mailbox: m.mailbox,
        confidence: m.confidence,
        hits: m.hits,
        source: m.source,
      }))
      .sort((a, b) => b.hits - a.hits || b.confidence - a.confidence),
  };
}

export type { MessageCluster, ClusterMessage, CategoryMemory };
