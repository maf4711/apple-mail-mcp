/**
 * Inbox clustering for self-learning filter (no presets).
 * Primary signal: sender domain. Secondary: shared subject tokens.
 *
 * @module services/categoryCluster
 */
import { domainToMailboxName, extractSenderKey, sanitizeMailboxName } from "./categoryMemory.js";

export interface ClusterMessage {
  id: string;
  subject: string;
  sender: string;
  account: string;
  mailbox: string;
}

export interface MessageCluster {
  /** Stable cluster id = domain key */
  key: string;
  domain: string;
  messages: ClusterMessage[];
  sampleSubjects: string[];
  sampleSenders: string[];
  /** Proposed mailbox before LLM (domain fallback) */
  fallbackName: string;
}

/**
 * Cluster messages by sender domain. Singleton domains still form a cluster
 * so the learner can name and remember them.
 */
export function clusterByDomain(messages: ClusterMessage[]): MessageCluster[] {
  const map = new Map<string, ClusterMessage[]>();
  for (const m of messages) {
    const { key, domain } = extractSenderKey(m.sender);
    const k = key || domain || "unknown";
    const list = map.get(k) ?? [];
    list.push(m);
    map.set(k, list);
  }

  const clusters: MessageCluster[] = [];
  for (const [key, msgs] of map) {
    const domain = extractSenderKey(msgs[0]?.sender ?? key).domain;
    const subjects = unique(
      msgs.map((m) => (m.subject || "").trim()).filter((s) => s.length > 0),
      8
    );
    const senders = unique(msgs.map((m) => m.sender).filter(Boolean), 5);
    clusters.push({
      key,
      domain,
      messages: msgs,
      sampleSubjects: subjects,
      sampleSenders: senders,
      fallbackName: domainToMailboxName(domain),
    });
  }

  // Larger clusters first (more signal for naming)
  clusters.sort((a, b) => b.messages.length - a.messages.length);
  return clusters;
}

/**
 * Optional merge of tiny clusters that share strong subject tokens.
 * Kept conservative: only merge size-1 clusters into another when a subject
 * token (≥5 chars) matches exactly one other cluster's samples.
 */
export function mergeTinyClusters(clusters: MessageCluster[], minSize = 2): MessageCluster[] {
  if (clusters.length <= 1) return clusters;
  const big = clusters.filter((c) => c.messages.length >= minSize);
  const tiny = clusters.filter((c) => c.messages.length < minSize);
  if (big.length === 0) return clusters;

  const result = [...big];
  for (const t of tiny) {
    const tokens = subjectTokens(t.sampleSubjects.join(" "));
    let best: MessageCluster | null = null;
    let bestScore = 0;
    for (const b of result) {
      const bTokens = new Set(subjectTokens(b.sampleSubjects.join(" ")));
      let score = 0;
      for (const tok of tokens) if (bTokens.has(tok)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best && bestScore >= 2) {
      best.messages.push(...t.messages);
      best.sampleSubjects = unique([...best.sampleSubjects, ...t.sampleSubjects], 8);
      best.sampleSenders = unique([...best.sampleSenders, ...t.sampleSenders], 5);
    } else {
      result.push(t);
    }
  }
  result.sort((a, b) => b.messages.length - a.messages.length);
  return result;
}

function subjectTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5)
    .slice(0, 20);
}

function unique(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = i.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
    if (out.length >= max) break;
  }
  return out;
}

/** Ensure LLM output is a safe mailbox label. */
export function finalizeClusterName(proposed: string | undefined, fallback: string): string {
  return sanitizeMailboxName(proposed || fallback, fallback);
}
