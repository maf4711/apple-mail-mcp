import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  learnFromMessages,
  planAutoSort,
  applyCorrection,
  memoryStatus,
} from "./categoryFilter.js";
import { parseNameJson } from "./categoryLlm.js";
import { loadMemory, upsertMapping, emptyMemory, saveMemory } from "./categoryMemory.js";

let dir: string;
let memPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-flt-"));
  memPath = join(dir, "mem.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const msg = (id: string, sender: string, subject: string) => ({
  id,
  sender,
  subject,
  account: "iCloud",
  mailbox: "INBOX",
});

describe("parseNameJson", () => {
  it("parses fenced and raw JSON", () => {
    expect(parseNameJson('```json\n{"a.com":"Alpha"}\n```')["a.com"]).toBe("Alpha");
    expect(parseNameJson('Here: {"b.com":"Beta"} done')["b.com"]).toBe("Beta");
  });
});

describe("learnFromMessages", () => {
  it("learns with domain fallback when no LLM key", async () => {
    const result = await learnFromMessages(
      [
        msg("1", "a@amazon.de", "Bestellung"),
        msg("2", "b@amazon.de", "Versand"),
        msg("3", "x@github.com", "Security alert"),
      ],
      { memoryPath: memPath, forceFallback: true, env: {} }
    );
    expect(result.usedLlm).toBe(false);
    expect(result.namedCount).toBe(2);
    const mem = loadMemory(memPath);
    expect(mem.mappings["amazon.de"]).toBeDefined();
    expect(mem.mappings["github.com"]).toBeDefined();
  });

  it("uses LLM names when fetch succeeds", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"amazon.de":"Amazon Shop","github.com":"GitHub"}' } }],
      }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const result = await learnFromMessages(
      [msg("1", "a@amazon.de", "Order"), msg("2", "n@github.com", "PR")],
      {
        memoryPath: memPath,
        env: {
          XAI_API_KEY: "test-key",
          APPLE_MAIL_MCP_LLM_BASE_URL: "https://example.test/v1",
          // Force cloud path so this unit test does not call on-device Apple AI
          APPLE_MAIL_MCP_FORCE_CLOUD_LLM: "1",
        },
        fetchImpl,
      }
    );
    expect(result.usedLlm).toBe(true);
    expect(result.memory.mappings["amazon.de"]?.mailbox).toBe("Amazon Shop");
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("planAutoSort", () => {
  it("moves high-confidence mappings and skips unknown", () => {
    const m = emptyMemory();
    upsertMapping(m, "amazon.de", "Amazon", { confidence: 0.9, source: "llm" });
    saveMemory(m, memPath);

    const plan = planAutoSort(
      [msg("1", "a@amazon.de", "Order"), msg("2", "z@unknown.example", "Hi")],
      { memoryPath: memPath }
    );
    expect(plan.moveCount).toBe(1);
    expect(plan.skipCount).toBe(1);
    expect(plan.byMailbox["Amazon"]).toEqual(["1"]);
  });

  it("skips low confidence unless aggressive", () => {
    const m = emptyMemory();
    upsertMapping(m, "x.com", "X", { confidence: 0.55, source: "domain" });
    saveMemory(m, memPath);
    const normal = planAutoSort([msg("1", "a@x.com", "t")], { memoryPath: memPath });
    expect(normal.moveCount).toBe(0);
    const agg = planAutoSort([msg("1", "a@x.com", "t")], {
      memoryPath: memPath,
      aggressive: true,
    });
    expect(agg.moveCount).toBe(1);
  });
});

describe("applyCorrection + memoryStatus", () => {
  it("stores correction and shows in status", () => {
    applyCorrection("Me <tax@finanzamt.de>", "Steuer", memPath);
    const st = memoryStatus(memPath, {});
    expect(st.mappingCount).toBeGreaterThanOrEqual(1);
    expect(st.mappings.some((x) => x.mailbox === "Steuer")).toBe(true);
  });
});
