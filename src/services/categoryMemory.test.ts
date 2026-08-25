import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractSenderKey,
  sanitizeMailboxName,
  domainToMailboxName,
  emptyMemory,
  loadMemory,
  saveMemory,
  upsertMapping,
  lookupMapping,
  correctMapping,
  forgetKey,
  forgetMailbox,
  shouldAutoMove,
  CONFIDENCE_CORRECTION,
  THRESHOLD_AUTO,
} from "./categoryMemory.js";

let dir: string;
let memPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-mem-"));
  memPath = join(dir, "category-memory.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("extractSenderKey", () => {
  it("parses Name <email@domain>", () => {
    const r = extractSenderKey("Amazon.de <bestellung@amazon.de>");
    expect(r.email).toBe("bestellung@amazon.de");
    expect(r.domain).toBe("amazon.de");
    expect(r.key).toBe("amazon.de");
  });

  it("parses bare email", () => {
    const r = extractSenderKey("noreply@github.com");
    expect(r.domain).toBe("github.com");
  });
});

describe("sanitizeMailboxName / domainToMailboxName", () => {
  it("strips path chars and reserves inbox", () => {
    expect(sanitizeMailboxName("foo/bar")).toBe("foo bar");
    expect(sanitizeMailboxName("Inbox")).toBe("Unsorted");
  });

  it("makes a friendly name from domain", () => {
    expect(domainToMailboxName("mail.amazon.de").toLowerCase()).toContain("amazon");
  });
});

describe("memory persistence", () => {
  it("round-trips save/load", () => {
    const m = emptyMemory();
    upsertMapping(m, "amazon.de", "Amazon", {
      confidence: 0.8,
      source: "llm",
      samples: ["Your order"],
    });
    saveMemory(m, memPath);
    expect(existsSync(memPath)).toBe(true);
    const loaded = loadMemory(memPath);
    expect(loaded.mappings["amazon.de"]?.mailbox).toBe("Amazon");
    expect(loaded.mappings["amazon.de"]?.samples).toEqual(["Your order"]);
  });

  it("lookup prefers domain mapping", () => {
    const m = emptyMemory();
    upsertMapping(m, "amazon.de", "Amazon", { confidence: 0.9, source: "llm" });
    const hit = lookupMapping(m, "Shop <orders@amazon.de>");
    expect(hit?.mapping.mailbox).toBe("Amazon");
  });

  it("correctMapping writes high-confidence domain+email", () => {
    const m = emptyMemory();
    correctMapping(m, "Foo <a@bank.de>", "Finanzen");
    expect(m.mappings["bank.de"]?.confidence).toBe(CONFIDENCE_CORRECTION);
    expect(m.mappings["a@bank.de"]?.mailbox).toBe("Finanzen");
  });

  it("forgetKey and forgetMailbox", () => {
    const m = emptyMemory();
    upsertMapping(m, "x.com", "X", { confidence: 0.7, source: "domain" });
    upsertMapping(m, "y.com", "X", { confidence: 0.7, source: "domain" });
    expect(forgetKey(m, "x.com")).toBe(true);
    expect(forgetMailbox(m, "X")).toBe(1);
    expect(Object.keys(m.mappings)).toHaveLength(0);
  });

  it("writes valid JSON file", () => {
    const m = emptyMemory();
    upsertMapping(m, "a.com", "A", { confidence: 0.5, source: "domain" });
    saveMemory(m, memPath);
    expect(() => JSON.parse(readFileSync(memPath, "utf8"))).not.toThrow();
  });
});

describe("shouldAutoMove", () => {
  it("respects default and aggressive thresholds", () => {
    expect(shouldAutoMove(THRESHOLD_AUTO)).toBe(true);
    expect(shouldAutoMove(0.6)).toBe(false);
    expect(shouldAutoMove(0.6, { aggressive: true })).toBe(true);
  });
});
