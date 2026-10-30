import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  colorEnabled,
  parseBool,
  parseConflictMode,
  parseLongLived,
  parseSyncPolicy,
} from "../../src/config";

describe("parseSyncPolicy", () => {
  test.each([
    ["check", "check"],
    ["rebase", "rebase"],
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

  test("the default never rewrites history", () => {
    expect(DEFAULT_CONFIG.syncPolicy).toBe("check");
  });
});

describe("parseConflictMode", () => {
  test("block unless told to warn", () => {
    expect(parseConflictMode("warn")).toBe("warn");
    expect(parseConflictMode("WARN")).toBe("warn");
    expect(parseConflictMode(null)).toBe("block");
    expect(parseConflictMode("nonsense")).toBe("block");
  });
});

describe("parseLongLived", () => {
  test("unset keeps the defaults", () => {
    expect(parseLongLived([])).toBe(DEFAULT_CONFIG.longLived);
  });

  test("values replace the defaults; separators may be spaces or commas", () => {
    expect(parseLongLived(["release/* develop", "qa,uat"])).toEqual([
      "release/*",
      "develop",
      "qa",
      "uat",
    ]);
  });

  test("an empty value means no long-lived branches at all", () => {
    expect(parseLongLived([""])).toEqual([]);
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
