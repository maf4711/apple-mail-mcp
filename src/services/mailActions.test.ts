import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deriveActionsHeuristic,
  mergeIntoQueue,
  emptyQueue,
  loadQueue,
  saveQueue,
  executeAction,
  runPendingActions,
  type DerivedAction,
} from "./mailActions.js";

let dir: string;
let qPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-act-"));
  qPath = join(dir, "queue.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deriveActionsHeuristic", () => {
  it("detects invoice / payment", () => {
    const a = deriveActionsHeuristic({
      id: "1",
      subject: "Rechnung 2026-04 fällig",
      sender: "billing@shop.de",
      body: "Bitte überweisen Sie den Betrag. Payment due.",
    });
    expect(a.some((x) => x.kind === "pay")).toBe(true);
    expect(a.find((x) => x.kind === "pay")?.autoExecutable).toBe(true);
  });

  it("detects reply needed", () => {
    const a = deriveActionsHeuristic({
      id: "2",
      subject: "Projektstand",
      sender: "chef@firma.de",
      body: "Bitte um Rückmeldung bis Freitag. Can you confirm?",
    });
    expect(a.some((x) => x.kind === "reply_draft")).toBe(true);
  });

  it("detects meeting", () => {
    const a = deriveActionsHeuristic({
      id: "3",
      subject: "Einladung: Zoom Meeting",
      sender: "cal@firma.de",
      body: "Join the meeting tomorrow",
    });
    expect(a.some((x) => x.kind === "appointment")).toBe(true);
  });

  it("skips pure newsletter noise for question-only path", () => {
    const a = deriveActionsHeuristic({
      id: "4",
      subject: "Was gibt's Neues?",
      sender: "noreply@newsletter.com",
      body: "unsubscribe here",
    });
    // may be empty or not follow_up
    expect(a.every((x) => x.kind !== "follow_up" || !/noreply/.test(x.from || ""))).toBe(true);
  });

  it("extracts DE due date", () => {
    const a = deriveActionsHeuristic({
      id: "5",
      subject: "Mahnung",
      sender: "a@b.de",
      body: "Zahlung fällig bis 15.08.2026",
    });
    expect(a[0]?.dueDate).toBe("2026-08-15");
  });
});

describe("queue merge + execute", () => {
  it("persists and merges without dupes", () => {
    const q = emptyQueue();
    const derived = deriveActionsHeuristic({
      id: "10",
      subject: "Rechnung",
      sender: "x@y.de",
      body: "invoice payment due",
    });
    const r1 = mergeIntoQueue(q, derived);
    expect(r1.added).toBeGreaterThan(0);
    const r2 = mergeIntoQueue(q, derived);
    expect(r2.added).toBe(0);
    saveQueue(q, qPath);
    const loaded = loadQueue(qPath);
    expect(loaded.actions.length).toBe(q.actions.length);
  });

  it("executeAction flags and marks done", () => {
    const action: DerivedAction = {
      id: "1:follow_up",
      messageId: "1",
      kind: "follow_up",
      title: "t",
      detail: "d",
      urgency: "low",
      flagColor: 3,
      autoExecutable: true,
      status: "pending",
      createdAt: new Date().toISOString(),
      source: "heuristic",
    };
    const r = executeAction(action, {
      flagMessage: () => true,
      replyDraft: () => false,
      createReminder: () => ({ ok: true }),
    });
    expect(r.ok).toBe(true);
    expect(action.status).toBe("done");
  });

  it("runPendingActions processes batch", () => {
    const q = emptyQueue();
    mergeIntoQueue(
      q,
      deriveActionsHeuristic({
        id: "99",
        subject: "Action required",
        sender: "a@b.com",
        body: "please confirm by Friday urgent",
      })
    );
    const { done, results } = runPendingActions(q, {
      flagMessage: () => true,
      replyDraft: () => true,
      createReminder: () => ({ ok: true }),
    });
    expect(results.length).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(0);
    expect(q.actions.every((a) => a.status !== "pending")).toBe(true);
  });
});
