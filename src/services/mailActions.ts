/**
 * Derive actionable items from email subject/body and execute them safely.
 *
 * Auto-executable (default):
 *   - flag message (urgency color)
 *   - create Reminders.app reminder
 *   - create reply draft (never auto-send)
 *
 * Never auto-executed:
 *   - send email, delete, payments, external APIs
 *
 * Queue: ~/Library/Application Support/apple-mail-mcp/action-queue.json
 *
 * @module services/mailActions
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { executeAppleScript } from "@/utils/applescript.js";

/** Minimal AppleScript string escape (avoid importing the full Mail manager). */
function escapeForAppleScript(text: string): string {
  if (!text) return "";
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, "")
  );
}

export type ActionKind =
  "flag" | "reminder" | "reply_draft" | "follow_up" | "pay" | "appointment" | "review";

export type ActionStatus = "pending" | "done" | "skipped" | "failed";

export interface DerivedAction {
  id: string;
  messageId: string;
  kind: ActionKind;
  title: string;
  detail: string;
  dueDate?: string; // ISO date YYYY-MM-DD if detected
  urgency: "low" | "medium" | "high";
  /** Flag color index for Mail.app: 1 red, 2 orange, 3 yellow, 6 blue */
  flagColor?: number;
  autoExecutable: boolean;
  status: ActionStatus;
  result?: string;
  createdAt: string;
  source: "heuristic" | "llm";
  from?: string;
  subject?: string;
}

export interface ActionQueue {
  version: 1;
  updatedAt: string;
  /** message ids already fully processed (dedupe) */
  processedMessageIds: string[];
  actions: DerivedAction[];
}

export function defaultActionQueuePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APPLE_MAIL_MCP_ACTION_QUEUE;
  if (override?.trim()) return override.trim();
  return join(homedir(), "Library", "Application Support", "apple-mail-mcp", "action-queue.json");
}

export function emptyQueue(): ActionQueue {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    processedMessageIds: [],
    actions: [],
  };
}

export function loadQueue(path: string = defaultActionQueuePath()): ActionQueue {
  try {
    if (!existsSync(path)) return emptyQueue();
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ActionQueue>;
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      processedMessageIds: Array.isArray(raw.processedMessageIds)
        ? raw.processedMessageIds.filter((x): x is string => typeof x === "string")
        : [],
      actions: Array.isArray(raw.actions) ? (raw.actions as DerivedAction[]) : [],
    };
  } catch {
    return emptyQueue();
  }
}

export function saveQueue(queue: ActionQueue, path: string = defaultActionQueuePath()): void {
  queue.updatedAt = new Date().toISOString();
  queue.version = 1;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(queue, null, 2), "utf8");
  renameSync(tmp, path);
}

export interface MailSnippet {
  id: string;
  subject: string;
  sender: string;
  body?: string;
  dateReceived?: Date | string;
}

/** Pure heuristic action extraction (DE + EN). */
export function deriveActionsHeuristic(mail: MailSnippet): DerivedAction[] {
  const subject = mail.subject || "";
  const body = (mail.body || "").slice(0, 4000);
  const text = `${subject}\n${body}`.toLowerCase();
  const now = new Date().toISOString();
  const due = extractDueDate(text, mail.dateReceived);
  const actions: DerivedAction[] = [];
  const base = {
    messageId: mail.id,
    from: mail.sender,
    subject: mail.subject,
    createdAt: now,
    source: "heuristic" as const,
    status: "pending" as const,
    dueDate: due,
  };

  const replySignals =
    /\b(please\s+reply|kindly\s+reply|awaiting\s+your|your\s+response|can you|could you|let me know|bitte\s+(um\s+)?(rückmeldung|antwort)|antwortet?\s+bitte|rückmeldung|warte\s+auf|feedback\s+erbeten|dringend\s+antworten)\b/i;
  const paySignals =
    /\b(invoice|payment\s+due|pay\s+now|amount\s+due|overdue|rechnung|zahlungsaufforderung|zahlung\s+fällig|offene\s+forderung|mahnung|betrag\s+fällig|please\s+pay)\b/i;
  const meetSignals =
    /\b(meeting|invite|invitation|calendar|zoom|teams|termin|einladung|besprechung|videokonferenz|sprechstunde)\b/i;
  const actionSignals =
    /\b(action\s+required|action\s+needed|todo|to-do|please\s+confirm|confirm\s+by|deadline|fällig|bitte\s+handeln|bitte\s+bestätigen|zu\s+erledigen|dringend|urgent|asap)\b/i;
  const reviewSignals =
    /\b(please\s+review|for\s+your\s+review|approval|genehmigung|freigabe|prüfen\s+sie|zur\s+prüfung|unterschreiben|sign\s+here)\b/i;

  let any = false;

  if (paySignals.test(text)) {
    any = true;
    actions.push({
      ...base,
      id: actionId(mail.id, "pay"),
      kind: "pay",
      title: `Zahlung prüfen: ${clip(subject, 60)}`,
      detail: "Rechnung/Zahlung erkannt — Reminder + Flag (kein Auto-Pay).",
      urgency: "high",
      flagColor: 1, // red
      autoExecutable: true,
    });
  }

  if (meetSignals.test(text)) {
    any = true;
    actions.push({
      ...base,
      id: actionId(mail.id, "appointment"),
      kind: "appointment",
      title: `Termin prüfen: ${clip(subject, 60)}`,
      detail: "Termin/Einladung erkannt — Reminder anlegen.",
      urgency: "medium",
      flagColor: 6, // blue
      autoExecutable: true,
    });
  }

  if (replySignals.test(text) || (actionSignals.test(text) && !paySignals.test(text))) {
    any = true;
    actions.push({
      ...base,
      id: actionId(mail.id, "reply_draft"),
      kind: "reply_draft",
      title: `Antwort nötig: ${clip(subject, 60)}`,
      detail: "Antwortsignal erkannt — Flag + Antwort-Entwurf (nicht senden).",
      urgency: /\b(urgent|dringend|asap|sofort)\b/i.test(text) ? "high" : "medium",
      flagColor: 2, // orange
      autoExecutable: true,
    });
  }

  if (reviewSignals.test(text)) {
    any = true;
    actions.push({
      ...base,
      id: actionId(mail.id, "review"),
      kind: "review",
      title: `Review: ${clip(subject, 60)}`,
      detail: "Freigabe/Prüfung erkannt — Reminder.",
      urgency: "medium",
      flagColor: 3, // yellow
      autoExecutable: true,
    });
  }

  // Unread-looking personal asks with "?" in subject often need follow-up
  if (!any && /\?/.test(subject) && !isBulkNoise(text, mail.sender)) {
    actions.push({
      ...base,
      id: actionId(mail.id, "follow_up"),
      kind: "follow_up",
      title: `Follow-up: ${clip(subject, 60)}`,
      detail: "Frage im Betreff — Flag zur Nachverfolgung.",
      urgency: "low",
      flagColor: 3,
      autoExecutable: true,
    });
  }

  // Always pair high-urgency items with an explicit reminder action kind for queue UX
  // (execution creates one reminder per action group per message — see execute)
  return dedupeKinds(actions);
}

function isBulkNoise(text: string, sender: string): boolean {
  const s = `${sender} ${text}`.toLowerCase();
  return /noreply|no-reply|newsletter|unsubscribe|list-unsubscribe|donotreply|do-not-reply/.test(s);
}

function extractDueDate(text: string, received?: Date | string): string | undefined {
  // DD.MM.YYYY or YYYY-MM-DD
  const de = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (de) {
    const d = `${de[3]}-${de[2]!.padStart(2, "0")}-${de[1]!.padStart(2, "0")}`;
    if (isSaneDate(d)) return d;
  }
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso && isSaneDate(iso[0]!)) return iso[0];

  // relative: "bis freitag" / "by friday" — leave undefined, reminder uses +2d
  if (/\b(heute|today|morgen|tomorrow)\b/i.test(text)) {
    const base = received ? new Date(received) : new Date();
    if (/\b(morgen|tomorrow)\b/i.test(text)) base.setDate(base.getDate() + 1);
    return base.toISOString().slice(0, 10);
  }
  return undefined;
}

function isSaneDate(iso: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const y = new Date(t).getFullYear();
  return y >= 2020 && y <= 2035;
}

function actionId(messageId: string, kind: ActionKind): string {
  return `${messageId}:${kind}`;
}

function clip(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function dedupeKinds(actions: DerivedAction[]): DerivedAction[] {
  const seen = new Set<string>();
  const out: DerivedAction[] = [];
  for (const a of actions) {
    if (seen.has(a.kind)) continue;
    seen.add(a.kind);
    out.push(a);
  }
  return out;
}

/** Merge newly derived actions into queue (skip existing action ids / processed msgs). */
export function mergeIntoQueue(
  queue: ActionQueue,
  derived: DerivedAction[],
  opts: { reprocess?: boolean } = {}
): { queue: ActionQueue; added: number } {
  const existingIds = new Set(queue.actions.map((a) => a.id));
  const processed = new Set(queue.processedMessageIds);
  let added = 0;
  for (const a of derived) {
    if (
      !opts.reprocess &&
      processed.has(a.messageId) &&
      !queue.actions.some((x) => x.messageId === a.messageId && x.status === "pending")
    ) {
      // Allow new kinds if message only partially done? Keep simple: skip if all done for msg
      const pendingForMsg = queue.actions.filter(
        (x) => x.messageId === a.messageId && x.status === "pending"
      );
      if (pendingForMsg.length === 0 && queue.actions.some((x) => x.messageId === a.messageId)) {
        continue;
      }
    }
    if (existingIds.has(a.id)) continue;
    queue.actions.push(a);
    existingIds.add(a.id);
    added++;
  }
  return { queue, added };
}

export interface ExecuteDeps {
  flagMessage: (id: string, colorIndex?: number) => boolean;
  replyDraft: (id: string, body: string) => boolean;
  createReminder: (
    title: string,
    body: string,
    dueDate?: string
  ) => { ok: boolean; error?: string };
}

export interface ExecuteResult {
  action: DerivedAction;
  ok: boolean;
  note: string;
}

/**
 * Execute a single action. Safe side-effects only.
 */
export function executeAction(action: DerivedAction, deps: ExecuteDeps): ExecuteResult {
  if (!action.autoExecutable) {
    action.status = "skipped";
    action.result = "not auto-executable";
    return { action, ok: true, note: "skipped (manual)" };
  }

  try {
    switch (action.kind) {
      case "flag":
      case "follow_up": {
        const ok = deps.flagMessage(action.messageId, action.flagColor);
        action.status = ok ? "done" : "failed";
        action.result = ok ? "flagged" : "flag failed";
        return { action, ok, note: action.result };
      }
      case "pay":
      case "appointment":
      case "review": {
        const flagged = deps.flagMessage(action.messageId, action.flagColor);
        const rem = deps.createReminder(
          action.title,
          `${action.detail}\nFrom: ${action.from || "?"}\nSubject: ${action.subject || "?"}\nMail-ID: ${action.messageId}`,
          action.dueDate
        );
        const ok = flagged || rem.ok;
        action.status = rem.ok ? "done" : flagged ? "done" : "failed";
        action.result = `flag=${flagged}; reminder=${rem.ok ? "ok" : rem.error || "fail"}`;
        return { action, ok, note: action.result };
      }
      case "reply_draft": {
        const flagged = deps.flagMessage(action.messageId, action.flagColor ?? 2);
        const body = buildReplyStub(action);
        const drafted = deps.replyDraft(action.messageId, body);
        // Also reminder so it doesn't vanish in drafts
        const rem = deps.createReminder(
          action.title,
          `Antwort-Entwurf angelegt.\n${action.detail}\nFrom: ${action.from || "?"}`,
          action.dueDate
        );
        const ok = drafted || flagged || rem.ok;
        action.status = ok ? "done" : "failed";
        action.result = `flag=${flagged}; draft=${drafted}; reminder=${rem.ok}`;
        return { action, ok, note: action.result };
      }
      default: {
        action.status = "skipped";
        action.result = "unknown kind";
        return { action, ok: true, note: "skipped" };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    action.status = "failed";
    action.result = msg;
    return { action, ok: false, note: msg };
  }
}

function buildReplyStub(action: DerivedAction): string {
  return [
    "Hallo,",
    "",
    "danke für Ihre Nachricht — ich melde mich in Kürze mit einer konkreten Antwort.",
    "",
    "(Automatisch vorbereiteter Entwurf aus apple-mail-mcp filter-actions — bitte prüfen vor dem Senden.)",
    "",
    `Bezüglich: ${action.subject || ""}`,
  ].join("\n");
}

/** Create a reminder in Reminders.app (list "Mail Actions" or default). */
export function createMailReminder(
  title: string,
  body: string,
  dueDate?: string,
  listName = "Mail Actions"
): { ok: boolean; error?: string } {
  const safeTitle = escapeForAppleScript(clip(title, 120));
  const safeBody = escapeForAppleScript(clip(body, 500));
  const safeList = escapeForAppleScript(listName);

  let dueBlock = "";
  if (dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    const [y, m, d] = dueDate.split("-").map(Number);
    dueBlock = `
      set dueDate to current date
      set year of dueDate to ${y}
      set month of dueDate to ${m}
      set day of dueDate to ${d}
      set hours of dueDate to 9
      set minutes of dueDate to 0
      set seconds of dueDate to 0
      set due date of r to dueDate
    `;
  } else {
    // default: day after tomorrow 9:00
    dueBlock = `
      set dueDate to (current date) + (2 * days)
      set hours of dueDate to 9
      set minutes of dueDate to 0
      set seconds of dueDate to 0
      set due date of r to dueDate
    `;
  }

  const script = `
tell application "Reminders"
  try
    set lst to missing value
    repeat with L in lists
      if name of L is "${safeList}" then set lst to L
    end repeat
    if lst is missing value then
      set lst to make new list with properties {name:"${safeList}"}
    end if
    set r to make new reminder at end of lst with properties {name:"${safeTitle}", body:"${safeBody}"}
    ${dueBlock}
    return "ok"
  on error errMsg
    return "error:" & errMsg
  end try
end tell
`;

  const res = executeAppleScript(script, { timeoutMs: 30000 });
  if (!res.success || res.output.startsWith("error:")) {
    return { ok: false, error: res.error || res.output.replace(/^error:/, "") };
  }
  return { ok: true };
}

/**
 * Run all pending auto-executable actions.
 */
export function runPendingActions(
  queue: ActionQueue,
  deps: ExecuteDeps,
  opts: { limit?: number; kinds?: ActionKind[] } = {}
): { queue: ActionQueue; results: ExecuteResult[]; done: number; failed: number } {
  const limit = opts.limit ?? 50;
  const results: ExecuteResult[] = [];
  let done = 0;
  let failed = 0;
  let n = 0;

  for (const action of queue.actions) {
    if (n >= limit) break;
    if (action.status !== "pending") continue;
    if (opts.kinds && !opts.kinds.includes(action.kind)) continue;
    const r = executeAction(action, deps);
    results.push(r);
    n++;
    if (r.action.status === "done") done++;
    else if (r.action.status === "failed") failed++;
  }

  // Mark messages fully processed when no pending left for them
  const byMsg = new Map<string, DerivedAction[]>();
  for (const a of queue.actions) {
    const list = byMsg.get(a.messageId) ?? [];
    list.push(a);
    byMsg.set(a.messageId, list);
  }
  for (const [mid, list] of byMsg) {
    if (list.every((a) => a.status === "done" || a.status === "skipped" || a.status === "failed")) {
      if (!queue.processedMessageIds.includes(mid)) queue.processedMessageIds.push(mid);
    }
  }

  return { queue, results, done, failed };
}

export function queueSummary(queue: ActionQueue) {
  const pending = queue.actions.filter((a) => a.status === "pending");
  const done = queue.actions.filter((a) => a.status === "done");
  const failed = queue.actions.filter((a) => a.status === "failed");
  const byKind: Record<string, number> = {};
  for (const a of pending) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  }
  return {
    total: queue.actions.length,
    pending: pending.length,
    done: done.length,
    failed: failed.length,
    processedMessages: queue.processedMessageIds.length,
    byKind,
    updatedAt: queue.updatedAt,
  };
}
