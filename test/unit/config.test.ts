import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  colorEnabled,
  loadConfig,
  parseBool,
  parseConflictMode,
  parseLongLived,
  parseSyncPolicy,
} from "../../src/config";
import { configFromEntries } from "../../src/git/queries";

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

describe("loadConfig", () => {
  test("reads every key from one git config snapshot", () => {
    const config = loadConfig(
      configFromEntries([
        ["pullpal.sync", "rebase"],
        ["pullpal.onconflict", "warn"],
        ["pullpal.tests", "off"],
        ["pullpal.testcommand", "make check"],
        ["pullpal.testcache", "false"],
        ["pullpal.longlived", "main"],
        ["pullpal.longlived", "release/*"],
      ]),
    );
    expect(config).toEqual({
      syncPolicy: "rebase",
      onConflict: "warn",
      testsEnabled: false,
      testCommand: "make check",
      testCache: false,
      longLived: ["main", "release/*"],
    });
  });

  test("nothing set means the defaults", () => {
    expect(loadConfig(configFromEntries([]))).toEqual(DEFAULT_CONFIG);
  });
});

describe("git config snapshot", () => {
  // `git config --list` lowercases section and key, but keeps the subsection.
  test("section and key are case-insensitive; the branch name is not", () => {
    const config = configFromEntries([["branch.Feature-X.pushremote", "fork"]]);
    expect(config.get("branch.Feature-X.pushRemote")).toBe("fork");
    expect(config.get("branch.feature-x.pushRemote")).toBeNull();
  });

  test("the last value wins, and every value is kept", () => {
    const config = configFromEntries([
      ["remote.pushdefault", "origin"],
      ["remote.pushdefault", "fork"],
    ]);
    expect(config.get("remote.pushDefault")).toBe("fork");
    expect(config.getAll("remote.pushDefault")).toEqual(["origin", "fork"]);
  });
});
