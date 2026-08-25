export interface DiagnosticEntry {
  /** 0 = error, 1 = warning, 2 = info, 3 = hint */
  severity: number;
  message: string;
  /** 0-based line */
  line: number;
  /** 0-based character */
  character: number;
}

export interface DiagnosticFile {
  uri: string;
  diagnostics: DiagnosticEntry[];
}

export interface DiagnosticsProvider {
  getDiagnostics(): DiagnosticFile[];
}
