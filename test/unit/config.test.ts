import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, colorEnabled, parseBool, parseSyncPolicy } from "../../src/config";

describe("parseSyncPolicy", () => {
  test.each([
    ["default", "default"],
    ["upstream", "upstream"],
    ["off", "off"],
    ["none", "off"],
    ["false", "off"],
    ["UPSTREAM", "upstream"],
  ] as const)("%s → %s", (input, expected) => {
    expect(parseSyncPolicy(input)).toBe(expected);
  });

  test.each([[null], ["nonsense"], [""]])("%p falls back to the default", (input) => {
    expect(parseSyncPolicy(input)).toBe(DEFAULT_CONFIG.syncPolicy);
  });
});

describe("parseBool", () => {
  test.each([
    ["on", true],
    ["true", true],
    ["yes", true],
    ["1", true],
    ["off", false],
    ["false", false],
    ["no", false],
    ["0", false],
  ] as const)("%s → %p", (input, expected) => {
    expect(parseBool(input, !expected)).toBe(expected);
  });

  test("unrecognised values keep the caller's fallback", () => {
    expect(parseBool("maybe", true)).toBe(true);
    expect(parseBool(null, false)).toBe(false);
  });
});

describe("colorEnabled", () => {
  test("NO_COLOR disables colour regardless of anything else", () => {
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  });

  test("an empty NO_COLOR is not a signal", () => {
    expect(colorEnabled({ NO_COLOR: "", FORCE_COLOR: "1" })).toBe(true);
  });

  test("FORCE_COLOR enables colour when not piped", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" })).toBe(true);
  });
});
