/**
 * Vitest setup: expose the bundled Prism instance as a GLOBAL before any test
 * file imports view.ts. The Prism grammar components (imported statically by
 * prism.ts) attach to the bare global `Prism`; in the real webview that global
 * is rewired at build time (define+inject), in vitest we mirror it here.
 */
import Prism from "prismjs";

(globalThis as { Prism?: unknown }).Prism = Prism;
