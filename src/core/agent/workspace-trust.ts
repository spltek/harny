/**
 * "This folder is NOT trusted" — one condition, one voice.
 *
 * VS Code's Workspace Trust exists for exactly what Harny does best: a chat that WRITES files and
 * RUNS commands. A cloned repo can carry a skill, a script, a task — and Restricted Mode is the
 * user saying "I have not read this yet". Two rules come out of that, and BOTH are needed:
 *
 *   · the panel STAYS on screen (`capabilities.untrustedWorkspaces: "limited"` in package.json).
 *     Without that declaration VS Code DISABLES the extension in Restricted Mode, so the activity
 *     bar loses Harny entirely and the user is left guessing — the field report was "Harny does not
 *     appear in the panel", never "Harny refused to build";
 *   · the WORK is read-only until the folder is trusted. The session runs as Analyze — the contract
 *     the whole stack already honours (file tools prepare VALIDATED previews, Shell keeps to the
 *     read allowlist, tools without a read-only policy are refused) — and the workspace's own
 *     skills are not loaded, because a repo's `SKILL.md` is workspace content like any other.
 *
 * These strings are the single source for the sentences that explain WHY Build is missing: the
 * disabled choice in the panel (imported by the webview bundle) and the note the host writes when
 * the user asks for it anyway. Written for the USER first — a model never reads them, there is
 * nothing for it to do (it is already in Analyze and gets the usual Analyze contract).
 */

/** The short reason: the disabled Build choice, its tooltip, and the mode pill's title. */
export function untrustedModeHint(): string {
  return (
    "Restricted Mode: this folder is not trusted, so Harny does not write files or run commands " +
    "here (Analyze only). Trust the folder to enable Build."
  );
}

/** The full sentence: what the panel says when the user asks for Build anyway. */
export function untrustedBuildNote(): string {
  return (
    "Build is unavailable: this folder is open in Restricted Mode (Workspace Trust has not been " +
    "granted), so Harny does not write files or run commands in it.\n\n" +
    "Everything else still works as Analyze — reads, and changes prepared as validated previews. " +
    "Trust the folder (Workspace Trust → “Trust”, at the top of the window) and Build is " +
    "available immediately."
  );
}
