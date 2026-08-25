import { languages, type Uri, type Diagnostic as VscodeDiagnostic } from "vscode";
import type { DiagnosticFile, DiagnosticsProvider } from "./diagnostics-provider";

/**
 * Adapts VS Code's languages.getDiagnostics() to the core DiagnosticsProvider.
 */
export class VscodeDiagnosticsProvider implements DiagnosticsProvider {
  getDiagnostics(): DiagnosticFile[] {
    return languages.getDiagnostics().map(([uri, diagnostics]) => ({
      uri: uri.fsPath,
      diagnostics: diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
        line: d.range.start.line,
        character: d.range.start.character,
      })),
    }));
  }
}
