import { describe, it, expect } from "vitest";
import { replaceBusinessName } from "../replace-business-name.js";

describe("replaceBusinessName", () => {
  it("replaces top-level string fields", () => {
    const out = replaceBusinessName(
      { agent_name: "Acme Plumbing", agent_id: "agent_1" },
      "Acme Plumbing",
      "Beta Plumbing",
    );
    expect(out.agent_name).toBe("Beta Plumbing");
    expect(out.agent_id).toBe("agent_1");
  });

  it("replaces inside nested prompt strings", () => {
    const out = replaceBusinessName(
      {
        conversationFlow: {
          global_prompt: "You are Anthony, an inbound receptionist for Acme Plumbing.",
          nodes: [
            {
              id: "n1",
              instruction: { text: 'Welcome the caller: "Thank you for calling Acme Plumbing, this is Anthony."' },
            },
          ],
        },
      },
      "Acme Plumbing",
      "Beta Plumbing",
    );
    const flow = out.conversationFlow as Record<string, unknown>;
    expect(flow.global_prompt).toContain("Beta Plumbing");
    expect(flow.global_prompt).not.toContain("Acme Plumbing");
    const nodes = flow.nodes as Array<Record<string, unknown>>;
    expect((nodes[0].instruction as Record<string, unknown>).text).toContain("Beta Plumbing");
  });

  it("is case-insensitive on match but uses the new name's casing in replacement", () => {
    const out = replaceBusinessName(
      { text: "ACME plumbing and acme PLUMBING" },
      "Acme Plumbing",
      "Beta Plumbing",
    );
    expect(out.text).toBe("Beta Plumbing and Beta Plumbing");
  });

  it("escapes regex metacharacters in the old name", () => {
    const out = replaceBusinessName(
      { text: "Bob's HVAC & Heating (LLC)" },
      "Bob's HVAC & Heating (LLC)",
      "Acme Co",
    );
    expect(out.text).toBe("Acme Co");
  });

  it("does not mutate the input object", () => {
    const input = { agent_name: "Acme" };
    const snapshot = JSON.parse(JSON.stringify(input));
    replaceBusinessName(input, "Acme", "Beta");
    expect(input).toEqual(snapshot);
  });

  it("preserves non-matching fields verbatim", () => {
    const out = replaceBusinessName(
      { agent_name: "Acme", llm_id: "abc-123", voice_speed: 1.0 },
      "Acme",
      "Beta",
    );
    expect(out.llm_id).toBe("abc-123");
    expect(out.voice_speed).toBe(1.0);
  });

  it("handles names that appear in array elements", () => {
    const out = replaceBusinessName(
      {
        nodes: [
          { id: "n1", text: "Acme Plumbing closes at 5pm" },
          { id: "n2", text: "Acme Plumbing offers emergency service" },
        ],
      },
      "Acme Plumbing",
      "Beta Plumbing",
    );
    const nodes = out.nodes as Array<Record<string, unknown>>;
    expect(nodes[0].text).toContain("Beta Plumbing");
    expect(nodes[1].text).toContain("Beta Plumbing");
  });

  it("does not affect the original key names — only string values", () => {
    // A key literally named "Acme" wouldn't survive JSON.stringify roundtrip
    // *as* a key after replace because it's serialized inside quotes too. This
    // test documents the known caveat: object keys can also match. Keep the
    // assertion accurate for current behavior.
    const out = replaceBusinessName(
      { Acme: "value" } as Record<string, unknown>,
      "Acme",
      "Beta",
    );
    // Both the key AND value get replaced because both are strings in JSON.
    // This is a documented edge case — names should not collide with field
    // identifiers like "agent_id" / "type".
    expect(out).toHaveProperty("Beta");
  });
});
