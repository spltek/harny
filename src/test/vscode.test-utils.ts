/**
 * The `vscode` module, as the TEST RUNNER needs to RESOLVE it.
 *
 * Nothing here is meant to be *used*: every test that touches the extension host
 * replaces it with `vi.mock("vscode", …)`. But an import of a bare module is
 * resolved at TRANSFORM time, and `vscode` exists only inside a running VS Code —
 * so under the jsdom environment (a separate module runner, where the mock is not
 * yet known while a dynamic `await import("vscode")` is being compiled) the
 * resolution fails outright and the whole suite dies with "Does the file exist?".
 *
 * This stub gives the resolver something to point at. The exports are deliberately
 * inert: if a test ever REACHES them instead of its own mock, the failure should be
 * loud (a call to `undefined`), not a silent fake success.
 */
export const window = undefined;
export const workspace = undefined;
export const commands = undefined;
export const Uri = undefined;
export const env = undefined;
export const extensions = undefined;
export const ThemeIcon = undefined;
export const EventEmitter = undefined;
export const Disposable = undefined;
export const ViewColumn = undefined;
export const StatusBarAlignment = undefined;
