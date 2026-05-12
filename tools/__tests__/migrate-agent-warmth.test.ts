import { describe, it, expect } from "vitest";
import {
  computeAgentRootUpdates,
  computeHandbookUpdates,
  computeGlobalPromptUpdate,
} from "../migrate-agent-warmth.js";

// Pure-logic tests for the three decision functions. The Retell + Mongo
// side-effects in main() aren't tested here (they get exercised live during
// `--dry-run` against prod). The decision logic is what catches regressions:
// if someone changes a default value without updating the OLD_* constants
// here, the customization-skip guard would silently overwrite real operator
// edits — these tests lock that down.

const OLD_DEFAULTS = {
  voice_id: "11labs-Ethan",
  voice_temperature: 0.44,
  voice_speed: 1.02,
  ambient_sound_volume: 0.95,
  interruption_sensitivity: 0.89,
  allow_user_dtmf: false,
  custom_stt_config: { provider: "deepgram", endpointing_ms: 1200 },
};

const NEW_DEFAULTS = {
  voice_id: "11labs-Billy",
  voice_temperature: 0.98,
  voice_speed: 0.98,
  ambient_sound_volume: 0.86,
  interruption_sensitivity: 0.84,
  allow_user_dtmf: true,
  custom_stt_config: { provider: "deepgram", endpointing_ms: 1540 },
};

describe("computeAgentRootUpdates", () => {
  it("migrates every field when agent is on the full set of old defaults", () => {
    const { patch, decisions } = computeAgentRootUpdates({ ...OLD_DEFAULTS });
    expect(patch.voice_id).toBe(NEW_DEFAULTS.voice_id);
    expect(patch.voice_temperature).toBe(NEW_DEFAULTS.voice_temperature);
    expect(patch.voice_speed).toBe(NEW_DEFAULTS.voice_speed);
    expect(patch.ambient_sound_volume).toBe(NEW_DEFAULTS.ambient_sound_volume);
    expect(patch.interruption_sensitivity).toBe(NEW_DEFAULTS.interruption_sensitivity);
    expect(patch.allow_user_dtmf).toBe(true);
    expect(patch.custom_stt_config).toEqual({ provider: "deepgram", endpointing_ms: 1540 });
    expect(decisions.every((d) => !d.kept)).toBe(true);
  });

  it("skips voice_id when operator chose a different voice", () => {
    const { patch, decisions } = computeAgentRootUpdates({
      ...OLD_DEFAULTS,
      voice_id: "11labs-Sarah", // operator-customized
    });
    expect(patch.voice_id).toBeUndefined();
    const v = decisions.find((d) => d.field === "voice_id");
    expect(v?.kept).toBe(true);
    expect(v?.from).toBe("11labs-Sarah");
    // Other fields still migrate.
    expect(patch.voice_temperature).toBe(NEW_DEFAULTS.voice_temperature);
  });

  it("skips voice_temperature when operator tuned it themselves", () => {
    const { patch } = computeAgentRootUpdates({ ...OLD_DEFAULTS, voice_temperature: 0.7 });
    expect(patch.voice_temperature).toBeUndefined();
    expect(patch.voice_speed).toBe(NEW_DEFAULTS.voice_speed); // others still migrate
  });

  it("emits no patch entry when already on the new value", () => {
    const { patch, decisions } = computeAgentRootUpdates({ ...NEW_DEFAULTS });
    expect(patch).toEqual({});
    // No noise logged for already-migrated fields.
    expect(decisions).toEqual([]);
  });

  it("updates custom_stt_config.endpointing_ms only when provider is deepgram + ms is 1200", () => {
    // Provider mismatch — leave alone.
    const sox = computeAgentRootUpdates({
      ...OLD_DEFAULTS,
      custom_stt_config: { provider: "soniox", endpointing_ms: 1200 },
    });
    expect(sox.patch.custom_stt_config).toBeUndefined();

    // Endpointing already customized — leave alone.
    const tuned = computeAgentRootUpdates({
      ...OLD_DEFAULTS,
      custom_stt_config: { provider: "deepgram", endpointing_ms: 800 },
    });
    expect(tuned.patch.custom_stt_config).toBeUndefined();
  });

  it("does not migrate allow_user_dtmf when operator set it to true already", () => {
    const { patch } = computeAgentRootUpdates({ ...OLD_DEFAULTS, allow_user_dtmf: true });
    expect(patch.allow_user_dtmf).toBeUndefined();
  });
});

describe("computeHandbookUpdates", () => {
  it("flips all three warmth flags when currently false", () => {
    const { patch, decisions } = computeHandbookUpdates({
      handbook_config: {
        default_personality: false,
        natural_filler_words: false,
        high_empathy: false,
        echo_verification: true, // unrelated — preserved
      },
    });
    expect((patch as any).handbook_config).toMatchObject({
      default_personality: true,
      natural_filler_words: true,
      high_empathy: true,
      echo_verification: true, // preserved
    });
    expect(decisions.every((d) => !d.kept)).toBe(true);
  });

  it("preserves any flag the operator already set to true (silent — no decision noise)", () => {
    const { patch, decisions } = computeHandbookUpdates({
      handbook_config: {
        default_personality: true, // already on
        natural_filler_words: false,
        high_empathy: false,
      },
    });
    expect((patch as any).handbook_config).toMatchObject({
      default_personality: true,
      natural_filler_words: true,
      high_empathy: true,
    });
    // Already-at-target flags don't appear in decisions — would be noise in
    // the dry-run log. Only the two flags we actually flipped show up.
    expect(decisions.find((d) => d.flag === "default_personality")).toBeUndefined();
    expect(decisions.find((d) => d.flag === "natural_filler_words")).toBeDefined();
  });

  it("emits empty patch when already fully migrated", () => {
    const { patch } = computeHandbookUpdates({
      handbook_config: {
        default_personality: true,
        natural_filler_words: true,
        high_empathy: true,
      },
    });
    expect(patch).toEqual({});
  });

  it("handles missing handbook_config gracefully", () => {
    const { patch, decisions } = computeHandbookUpdates({});
    // No handbook_config → no flags are 'currently false' so no patch.
    // (We never CREATE a handbook_config from scratch — that's a generator
    // responsibility, not a migration.)
    expect(patch).toEqual({});
    // Each missing flag gets a kept:true decision so the dry-run log
    // surfaces "this agent has no handbook_config, please review".
    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.kept)).toBe(true);
  });
});

describe("computeGlobalPromptUpdate", () => {
  const oldPrompt = `You are Anthony.

Ask one question at a time.

Once you know the caller's first name, use it in the opening and ending of the call, nowhere else.

Unless otherwise asked of you, do not repeat back what the caller said back to them.

Acknowledge by using the available short acknowledgments listed here:
- Got it
- Understood
`;

  it("removes the first-name line + softens the ack-intro", () => {
    const { newPrompt, notes } = computeGlobalPromptUpdate(oldPrompt);
    expect(newPrompt).not.toBeNull();
    expect(newPrompt!).not.toContain("first name in the opening");
    expect(newPrompt!).toContain("When appropriate to acknowledge, only use short acknowledgments such as:");
    expect(newPrompt!).not.toContain("Acknowledge by using the available short acknowledgments listed here:");
    expect(notes.some((n) => n.includes("removed first-name rule"))).toBe(true);
    expect(notes.some((n) => n.includes("softened acknowledgment-list intro"))).toBe(true);
  });

  it("returns null when prompt is undefined", () => {
    const { newPrompt } = computeGlobalPromptUpdate(undefined);
    expect(newPrompt).toBeNull();
  });

  it("returns null when both edits are already applied (idempotent)", () => {
    const alreadyNew = oldPrompt
      .replace("\nOnce you know the caller's first name, use it in the opening and ending of the call, nowhere else.\n\n", "\n")
      .replace(
        "Acknowledge by using the available short acknowledgments listed here:",
        "When appropriate to acknowledge, only use short acknowledgments such as:",
      );
    const { newPrompt } = computeGlobalPromptUpdate(alreadyNew);
    expect(newPrompt).toBeNull();
  });

  it("returns null when operator customized the prompt enough that neither pattern matches", () => {
    const customized = `You are a different agent. Be brief. Ack when needed.`;
    const { newPrompt } = computeGlobalPromptUpdate(customized);
    expect(newPrompt).toBeNull();
  });

  it("applies only one edit when only one pattern is present", () => {
    // Just the name-rule, no ack-intro pattern.
    const partial = `You are Anthony.

Once you know the caller's first name, use it in the opening and ending of the call, nowhere else.

The rest of the prompt is custom — operator wrote their own ack section.`;
    const { newPrompt } = computeGlobalPromptUpdate(partial);
    expect(newPrompt).not.toBeNull();
    expect(newPrompt!).not.toContain("first name in the opening");
    // Custom section preserved verbatim.
    expect(newPrompt!).toContain("operator wrote their own ack section");
  });
});
