/** Builders for the plain-data states the decision core consumes. */

import type { BaseState, SyncState } from "../../src/core/types";

export function baseState(overrides: Partial<BaseState> = {}): BaseState {
  return {
    isRepo: true,
    root: "/repo",
    detached: false,
    branch: "feature",
    unborn: false,
    remotes: ["origin"],
    dirty: false,
    operationInProgress: null,
    ...overrides,
  };
}

export function syncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    remote: "origin",
    defaultBranch: "main",
    behindDefault: 0,
    upstream: "origin/feature",
    aheadUpstream: 0,
    behindUpstream: 0,
    ...overrides,
  };
}
