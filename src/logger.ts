import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { window, type OutputChannel } from "vscode";

/** Temp debug log path — cross-platform (never hardcode /tmp). */
const LOG_FILE = join(tmpdir(), "harny-debug.log");
const enabled = !!process.env.HARNY_DEBUG;

let outputChannel: OutputChannel | undefined;

/** Always-visible output channel (View > Output > Harny). No env var needed. */
export function getOutputChannel(): OutputChannel {
  if (!outputChannel) {
    outputChannel = window.createOutputChannel("Harny");
  }
  return outputChannel;
}

export function infoLog(...args: any[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  try {
    getOutputChannel().appendLine(line);
  } catch {
    /* ignore */
  }
}

export function debugLog(...args: any[]): void {
  if (!enabled) return;
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* ignore */
  }
  console.log(line);
}
