import { describe, it, expect } from "vitest";
import { workspaceGoneRunNote, workspaceGoneSendNote, workspaceGoneToolRefusal } from "./workspace-gone";

/**
 * The three voices that share one cause. What is pinned here is not the prose but the two
 * things a message can get WRONG: blaming a deletion that did not happen, and failing to tell
 * the model the one thing it cannot infer.
 */

describe("workspace-gone messages", () => {
  it("names the folder that disappeared, in every voice", () => {
    for (const text of [
      workspaceGoneToolRefusal("/p/gone", "Read"),
      workspaceGoneRunNote("/p/gone"),
      workspaceGoneSendNote("/p/gone"),
    ]) {
      expect(text).toContain("/p/gone");
      expect(text).toContain("no longer exists");
      expect(text).toContain("never recreates one");
    }
  });

  it("does NOT blame a deletion when there never was a single folder", () => {
    // A window with 0 or 2+ folders: the refusal is the same, the CAUSE is not. Saying "the
    // folder no longer exists" there reads like a bug (there was no folder to lose).
    for (const text of [workspaceGoneToolRefusal("", "Read"), workspaceGoneRunNote(""), workspaceGoneSendNote("")]) {
      expect(text).toContain("no single workspace folder is open");
      expect(text).not.toContain("no longer exists");
    }
  });

  it("tells the model the three things it cannot infer", () => {
    const text = workspaceGoneToolRefusal("/p/gone", "Write");
    expect(text).toContain("Write"); // which tool refused
    expect(text).toContain("NOT an empty project"); // the reflex this stops
    expect(text).toContain("never recreates a workspace folder"); // what it must not try
    expect(text).toContain("Do not scaffold"); // and what to do instead
  });

  it("tells the user where the way out is, in the two user-facing voices", () => {
    expect(workspaceGoneRunNote("/p/gone")).toContain("Change folder…");
    expect(workspaceGoneSendNote("/p/gone")).toContain("Change folder…");
  });
});
