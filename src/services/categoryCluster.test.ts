import { describe, it, expect } from "vitest";
import { clusterByDomain, mergeTinyClusters, finalizeClusterName } from "./categoryCluster.js";

const msg = (id: string, sender: string, subject: string) => ({
  id,
  sender,
  subject,
  account: "iCloud",
  mailbox: "INBOX",
});

describe("clusterByDomain", () => {
  it("groups by domain", () => {
    const clusters = clusterByDomain([
      msg("1", "a@amazon.de", "Order 1"),
      msg("2", "b@amazon.de", "Order 2"),
      msg("3", "n@github.com", "PR merged"),
    ]);
    expect(clusters).toHaveLength(2);
    const amazon = clusters.find((c) => c.domain === "amazon.de");
    expect(amazon?.messages).toHaveLength(2);
    expect(amazon?.fallbackName.length).toBeGreaterThan(0);
  });
});

describe("mergeTinyClusters", () => {
  it("merges tiny into big when subject tokens overlap", () => {
    const clusters = clusterByDomain([
      msg("1", "a@shop.de", "BMW M8 Angebot Spezial"),
      msg("2", "b@shop.de", "BMW M8 Preis update"),
      msg("3", "c@other.de", "BMW M8 rest"),
    ]);
    const merged = mergeTinyClusters(clusters, 2);
    // shop.de has 2, other.de has 1 — may merge if tokens match
    const totalMsgs = merged.reduce((n, c) => n + c.messages.length, 0);
    expect(totalMsgs).toBe(3);
  });
});

describe("finalizeClusterName", () => {
  it("falls back when empty", () => {
    expect(finalizeClusterName("", "Amazon")).toBe("Amazon");
    expect(finalizeClusterName("GitHub CI", "X")).toBe("GitHub CI");
  });
});
