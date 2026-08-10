#!/usr/bin/env node
/**
 * apple-mail-auto — maximum automation pipeline for Apple Mail (no MCP needed).
 *
 * Runs on a schedule (LaunchAgent) or once from CLI:
 *   1. Learn domain→mailbox mappings (optional, every Nth run or --learn)
 *   2. Auto-sort INBOX (aggressive confidence)
 *   3. Create NL:… newsletter smart mailboxes
 *   4. Derive + execute actions (flag, Reminders, reply drafts — never send)
 *
 * Usage:
 *   apple-mail-auto                  # full max-auto run
 *   apple-mail-auto --once           # same (explicit)
 *   apple-mail-auto --dry-run        # plan only, no moves/flags/rules
 *   apple-mail-auto --no-learn       # skip clustering/LLM learn
 *   apple-mail-auto --no-actions     # skip action pipeline
 *   apple-mail-auto --no-newsletters
 *   apple-mail-auto --limit 80
 *
 * Config (optional JSON):
 *   ~/Library/Application Support/apple-mail-mcp/auto-config.json
 *
 * Env: on-device Apple AI via build/apple-mail-ai (preferred); optional XAI_API_KEY cloud fallback.
 * No IMAP required: sorts into local "On My Mac" mailboxes + smart views.
 *
 * @module auto
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseArgs } from "util";
import { AppleMailManager } from "@/services/appleMailManager.js";
import {
  learnFromMessages,
  planAutoSort,
  bumpMoves,
  memoryStatus,
} from "@/services/categoryFilter.js";
import { defaultMemoryPath, THRESHOLD_AGGRESSIVE } from "@/services/categoryMemory.js";
import {
  deriveActionsHeuristic,
  mergeIntoQueue,
  loadQueue,
  saveQueue,
  runPendingActions,
  queueSummary,
  createMailReminder,
  defaultActionQueuePath,
} from "@/services/mailActions.js";
import type { ClusterMessage } from "@/services/categoryFilter.js";

const SUPPORT = join(homedir(), "Library", "Application Support", "apple-mail-mcp");
const DEFAULT_CONFIG_PATH = join(SUPPORT, "auto-config.json");
const DEFAULT_LOG_PATH = join(SUPPORT, "auto.log");
const STATE_PATH = join(SUPPORT, "auto-state.json");

export interface AutoConfig {
  limit: number;
  bodyLimit: number;
  actionExecuteLimit: number;
  aggressive: boolean;
  learn: boolean;
  /** Run learn every N runs (1 = every time) */
  learnEveryNRuns: number;
  sort: boolean;
  newsletters: boolean;
  newsletterMinCount: number;
  newsletterDays: number;
  actions: boolean;
  /** Never auto-send email (hard safety — cannot be enabled) */
  neverAutoSend: true;
  account?: string;
  logPath: string;
}

const DEFAULTS: AutoConfig = {
  limit: 80,
  bodyLimit: 15,
  actionExecuteLimit: 25,
  aggressive: true,
  learn: true,
  learnEveryNRuns: 1,
  sort: true,
  // Newsletter smart-mailbox discovery is slow (full source scan) — opt-in
  newsletters: false,
  newsletterMinCount: 3,
  newsletterDays: 90,
  actions: true,
  neverAutoSend: true,
  logPath: DEFAULT_LOG_PATH,
};

const LOCK_PATH = join(SUPPORT, "auto.lock");

/** Prevent overlapping LaunchAgent runs (Mail.app cannot handle concurrent AS). */
function acquireLock(): boolean {
  try {
    mkdirSync(SUPPORT, { recursive: true });
    if (existsSync(LOCK_PATH)) {
      const raw = readFileSync(LOCK_PATH, "utf8").trim();
      const pid = Number(raw);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // still running?
          return false;
        } catch {
          // stale lock
        }
      }
    }
    writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch {
    return true; // best-effort
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_PATH)) {
      const raw = readFileSync(LOCK_PATH, "utf8").trim();
      if (raw === String(process.pid)) unlinkSync(LOCK_PATH);
    }
  } catch {
    /* ignore */
  }
}

function loadConfig(path: string): Partial<AutoConfig> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Partial<AutoConfig>;
  } catch {
    return {};
  }
}

function loadState(): { runs: number; lastRun?: string } {
  try {
    if (!existsSync(STATE_PATH)) return { runs: 0 };
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as { runs: number; lastRun?: string };
  } catch {
    return { runs: 0 };
  }
}

function saveState(state: { runs: number; lastRun: string }): void {
  mkdirSync(SUPPORT, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(line: string, logPath: string): void {
  const ts = new Date().toISOString();
  const full = `[${ts}] ${line}`;
  console.log(full);
  try {
    mkdirSync(SUPPORT, { recursive: true });
    appendFileSync(logPath, full + "\n");
  } catch {
    /* ignore log write errors */
  }
}

function toCluster(
  messages: { id: string; subject: string; sender: string; account: string; mailbox: string }[]
): ClusterMessage[] {
  return messages.map((m) => ({
    id: m.id,
    subject: m.subject ?? "",
    sender: m.sender ?? "",
    account: m.account ?? "",
    mailbox: m.mailbox ?? "INBOX",
  }));
}

export interface AutoResult {
  dryRun: boolean;
  scanned: number;
  learned: number;
  moved: number;
  moveFailed: number;
  newsletters: number;
  actionsDerived: number;
  actionsDone: number;
  actionsFailed: number;
  memoryPath: string;
  queuePath: string;
  lines: string[];
}

export async function runAutoPipeline(opts: {
  dryRun?: boolean;
  forceLearn?: boolean;
  noLearn?: boolean;
  noActions?: boolean;
  noNewsletters?: boolean;
  noSort?: boolean;
  limit?: number;
  configPath?: string;
}): Promise<AutoResult> {
  const fileCfg = loadConfig(opts.configPath ?? DEFAULT_CONFIG_PATH);
  const cfg: AutoConfig = { ...DEFAULTS, ...fileCfg };
  if (opts.limit) cfg.limit = opts.limit;
  if (opts.noLearn) cfg.learn = false;
  if (opts.noActions) cfg.actions = false;
  if (opts.noNewsletters) cfg.newsletters = false;
  if (opts.noSort) cfg.sort = false;

  const dryRun = !!opts.dryRun;
  const lines: string[] = [];
  const push = (s: string) => {
    lines.push(s);
    log(s, cfg.logPath);
  };

  push(`apple-mail-auto start dryRun=${dryRun} aggressive=${cfg.aggressive} limit=${cfg.limit}`);

  const mail = new AppleMailManager();
  const { messages: raw } = mail.listMessagesWithDiagnostics("INBOX", cfg.account, cfg.limit);
  const messages = toCluster(raw);
  push(`INBOX scanned: ${messages.length}`);

  const state = loadState();
  const runNumber = state.runs + 1;
  let learned = 0;

  // every N runs: N=1 → always; N=4 → runs 1,5,9,…
  const learnEvery = Math.max(1, cfg.learnEveryNRuns);
  const shouldLearn = cfg.learn && (opts.forceLearn || (runNumber - 1) % learnEvery === 0);

  if (shouldLearn && messages.length > 0 && !dryRun) {
    push("Learn: clustering + naming (Apple AI on-device preferred)…");
    // forceFallback only when explicitly disabled; Apple AI runs without XAI_API_KEY
    const result = await learnFromMessages(messages, {
      forceFallback: process.env.APPLE_MAIL_MCP_FORCE_DOMAIN_NAMES === "1",
    });
    learned = result.namedCount;
    push(
      `Learn: ${learned} clusters (llm=${result.usedLlm} model=${result.llmModel || "domain"}${result.llmError ? ` err=${result.llmError}` : ""}) → ${result.memoryPath}`
    );
  } else if (shouldLearn && dryRun) {
    push("Learn: skipped (dry-run)");
  } else if (shouldLearn && messages.length === 0) {
    push("Learn: skipped (INBOX empty or Mail.app timeout — will retry next tick)");
  } else {
    push(`Learn: skipped (every ${cfg.learnEveryNRuns} runs; this is #${runNumber})`);
  }

  // --- Actions BEFORE sort (messages must still be findable in INBOX) ---
  let actionsDerived = 0;
  let actionsDone = 0;
  let actionsFailed = 0;
  const queuePath = defaultActionQueuePath();

  if (cfg.actions && messages.length > 0) {
    const queue = loadQueue(queuePath);
    // Subject/sender only by default (body reads thrash Mail.app).
    const readBodies = process.env.APPLE_MAIL_MCP_ACTION_BODIES === "1";
    const candidates = messages.slice(0, cfg.bodyLimit);
    const allDerived = [];
    for (const m of candidates) {
      let body = "";
      if (!dryRun && readBodies) {
        try {
          const c = mail.getMessageContent(m.id, false, {
            account: m.account,
            mailbox: m.mailbox,
          });
          body = c?.plainText?.slice(0, 2000) ?? "";
        } catch {
          body = "";
        }
      }
      const derived = deriveActionsHeuristic({
        id: m.id,
        subject: m.subject,
        sender: m.sender,
        body,
      });
      allDerived.push(...derived);
    }
    actionsDerived = allDerived.length;
    const { added } = mergeIntoQueue(queue, allDerived);
    push(`Actions: derived=${actionsDerived} added=${added}`);

    if (!dryRun) {
      const run = runPendingActions(
        queue,
        {
          // Prefer reminders (reliable). Flag is best-effort — messages may move next.
          flagMessage: (id, color) => {
            try {
              return mail.flagMessage(id, color);
            } catch {
              return false;
            }
          },
          replyDraft: (id, body) => {
            try {
              return mail.replyToMessage(id, body, false, false);
            } catch {
              return false;
            }
          },
          createReminder: (title, body, due) => createMailReminder(title, body, due),
        },
        { limit: cfg.actionExecuteLimit }
      );
      actionsDone = run.done;
      actionsFailed = run.failed;
      saveQueue(run.queue, queuePath);
      const sum = queueSummary(run.queue);
      push(`Actions executed: done=${actionsDone} failed=${actionsFailed} pending=${sum.pending}`);
    } else {
      saveQueue(queue, queuePath);
      push("Actions: not executed (dry-run)");
    }
  }

  // --- Sort: file INBOX → On My Mac/<category> (real empty-inbox) ---
  let moved = 0;
  let moveFailed = 0;
  const mem = memoryStatus();
  if (cfg.sort && messages.length > 0) {
    if (mem.mappingCount === 0 && !dryRun) {
      push("Sort: no memory yet — forcing learn first");
      const result = await learnFromMessages(messages, {
        forceFallback: process.env.APPLE_MAIL_MCP_FORCE_DOMAIN_NAMES === "1",
      });
      learned = result.namedCount;
      push(`Learn(forced): ${learned} clusters`);
    }

    const plan = planAutoSort(messages, {
      aggressive: cfg.aggressive,
      threshold: cfg.aggressive ? THRESHOLD_AGGRESSIVE : undefined,
    });
    push(`Sort plan: move=${plan.moveCount} skip=${plan.skipCount}`);

    if (!dryRun && plan.moveCount > 0) {
      /**
       * Always file into local "On My Mac" mailboxes. AppleScript can MOVE
       * Gmail/IMAP messages into local boxes even when it cannot CREATE server folders.
       * Uses inbox-scoped lookup (fast) — not full mailbox tree walk.
       */
      const byLocal = new Map<
        string,
        { mailbox: string; items: { id: string; account?: string }[]; froms: string[] }
      >();
      const idTo = new Map(messages.map((m) => [m.id, m]));

      for (const item of plan.items) {
        if (item.action !== "move") continue;
        const m = idTo.get(item.id);
        const localName = item.destMailbox.slice(0, 48);
        let g = byLocal.get(localName);
        if (!g) {
          g = { mailbox: localName, items: [], froms: [] };
          byLocal.set(localName, g);
        }
        g.items.push({ id: item.id, account: item.account || m?.account });
        if (m?.sender) g.froms.push(m.sender);
      }

      let localCreated = 0;
      for (const g of byLocal.values()) {
        const created = mail.createLocalMailbox(g.mailbox);
        if (!created.success) {
          push(`Sort ERROR: cannot create On My Mac/${g.mailbox}: ${created.error}`);
          moveFailed += g.items.length;
          continue;
        }
        if (!created.alreadyExisted) localCreated++;

        const results = mail.moveFromInboxesToLocal(g.items, g.mailbox);
        let groupOk = 0;
        let groupFail = 0;
        for (const r of results) {
          if (r.success) {
            moved++;
            groupOk++;
          } else {
            moveFailed++;
            groupFail++;
          }
        }
        if (groupOk > 0) bumpMoves(g.froms);
        push(`Sort On My Mac/${g.mailbox}: ok=${groupOk} fail=${groupFail} (of ${g.items.length})`);
      }
      push(
        `Sort applied: moved=${moved} failed=${moveFailed} localBoxesCreated=${localCreated} categories=${byLocal.size}`
      );
    } else if (dryRun) {
      const sample = plan.items
        .filter((i) => i.action === "move")
        .slice(0, 8)
        .map((i) => `  would move ${i.id} → ${i.destMailbox}`)
        .join("\n");
      if (sample) push(sample);
    }
  }

  let newsletterCount = 0;
  if (cfg.newsletters) {
    const nl = mail.createNewsletterSmartMailboxes(
      dryRun,
      cfg.newsletterMinCount,
      cfg.newsletterDays
    );
    newsletterCount = nl.count;
    push(
      `Newsletters: ${dryRun ? "would process" : "processed"} ${newsletterCount} NL smart mailboxes`
    );
  }

  if (!dryRun) {
    saveState({ runs: runNumber, lastRun: new Date().toISOString() });
  }

  push(`DONE moved=${moved} nl=${newsletterCount} actionsDone=${actionsDone} learned=${learned}`);

  return {
    dryRun,
    scanned: messages.length,
    learned,
    moved,
    moveFailed,
    newsletters: newsletterCount,
    actionsDerived,
    actionsDone,
    actionsFailed,
    memoryPath: defaultMemoryPath(),
    queuePath,
    lines,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      learn: { type: "boolean", default: false },
      "no-learn": { type: "boolean", default: false },
      "no-actions": { type: "boolean", default: false },
      "no-newsletters": { type: "boolean", default: false },
      "no-sort": { type: "boolean", default: false },
      limit: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`apple-mail-auto — REAL inbox automation for Apple Mail

  Files mail into local "On My Mac" mailboxes (works without IMAP config).
  Learns domain→folder, flags/actions via heuristics. Never auto-sends.

  apple-mail-auto              Full pipeline
  apple-mail-auto --dry-run    Plan only
  apple-mail-auto --learn      Force learn this run
  apple-mail-auto --no-actions
  apple-mail-auto --limit 80

Config: ${DEFAULT_CONFIG_PATH}
Log:    ${DEFAULT_LOG_PATH}
`);
    process.exit(0);
  }

  if (!values["dry-run"] && !acquireLock()) {
    console.error("apple-mail-auto: another run is active (lock); skipping");
    process.exit(0);
  }

  try {
    mkdirSync(SUPPORT, { recursive: true });
    // Always refresh config defaults keys without wiping user edits
    const existing = loadConfig(DEFAULT_CONFIG_PATH);
    writeFileSync(
      DEFAULT_CONFIG_PATH,
      JSON.stringify(
        {
          ...DEFAULTS,
          ...existing,
          neverAutoSend: true,
          _comment:
            "Files to On My Mac. newsletters=false by default (slow). neverAutoSend enforced.",
        },
        null,
        2
      )
    );

    const result = await runAutoPipeline({
      dryRun: values["dry-run"],
      forceLearn: values.learn,
      noLearn: values["no-learn"],
      noActions: values["no-actions"],
      noNewsletters: values["no-newsletters"],
      noSort: values["no-sort"],
      limit: values.limit ? parseInt(values.limit, 10) : undefined,
      configPath: DEFAULT_CONFIG_PATH,
    });

    // Exit 0 if we moved anything or had nothing to do; 1 only on hard failure with no progress
    const hardFail = result.scanned > 0 && result.moved === 0 && result.moveFailed > 10;
    process.exit(hardFail ? 1 : 0);
  } finally {
    releaseLock();
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("auto.js") ||
    process.argv[1].endsWith("auto.ts") ||
    process.argv[1].includes("apple-mail-auto"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
