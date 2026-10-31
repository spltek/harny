/**
 * "The workspace folder is GONE" — one condition, one voice.
 *
 * A session works inside ONE folder; that folder is the ground the agent stands on. When it
 * disappears at runtime (an `rm -rf`, a mount that drops, a `git clean` in the wrong place)
 * every tool starts failing LOCALLY — "0 files found", "file not found", "spawn ENOENT" —
 * and a local failure is the worst possible answer to give a model: "0 files found" reads
 * as **an empty project**, and the natural next move for an empty project is to create
 * everything again. That is how a deleted folder came back as a ghost, with the agent's
 * new files inside it.
 *
 * So the rule is: the root is a PRECONDITION of using it. The host's watcher STOPS the run
 * (and its sub-agents) as soon as the folder is gone; the per-call refusal is the net for
 * the window between the deletion and that poll, and these strings are the single source.
 * Written FOR THE MODEL first, for the user second — a model that understands "do not
 * scaffold" is worth more than a message that only reads well.
 *
 * ONE branch, three voices: the CAUSE is written once (`cause`) and each audience gets the
 * sentence it needs. The cause also covers the neighbouring state — a window with no single
 * workspace folder at all — because reporting "the folder no longer exists" when there never
 * was one is the kind of detail that makes a clear message read like a bug.
 */

/** Why work is impossible here: the folder that WAS there is gone, or there is none. */
function cause(root: string | undefined): string {
  return root
    ? `the workspace folder ${root} no longer exists (it was removed while the session was open, ` +
        "and Harny never recreates one)"
    : "no single workspace folder is open (Harny works inside exactly one)";
}

/** What the model is told when a tool call cannot run. */
export function workspaceGoneToolRefusal(root: string, tool: string): string {
  return (
    `Tool ${tool} was NOT run: ${cause(root)}.\n` +
    "This is NOT an empty project — nothing was deleted from your work by you, and Harny never " +
    "recreates a workspace folder.\n" +
    "Do not scaffold, do not write, do not retry: nothing can be read or written here. Tell the user the " +
    "folder is gone and that this session has to be re-pointed (Change folder…), then stop."
  );
}

/** The persistent note that closes a run the HOST stopped, so the transcript says why. */
export function workspaceGoneRunNote(root: string): string {
  return (
    `Stopped: ${cause(root)}. ` +
    "No tool was run against it (and nothing was recreated). Re-point this session's folder " +
    "(Change folder…) and ask again."
  );
}

/** Why a message could not be sent at all (the run never started). */
export function workspaceGoneSendNote(root: string): string {
  return (
    `Harny cannot work here: ${cause(root)}. ` +
    "Pick a folder for this session (Change folder…) before sending another message."
  );
}
