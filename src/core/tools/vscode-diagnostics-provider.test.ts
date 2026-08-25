import { describe, it, expect, vi, beforeEach } from "vitest";

const diagnosticsMock = { getDiagnostics: vi.fn() };
vi.mock("vscode", () => ({
  languages: diagnosticsMock,
}));

const { VscodeDiagnosticsProvider } = await import("./vscode-diagnostics-provider");

describe("VscodeDiagnosticsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps vscode diagnostics to the core DiagnosticFile shape", () => {
    diagnosticsMock.getDiagnostics.mockReturnValue([
      [
        { fsPath: "/workspace/a.ts" },
        [
          {
            severity: 0,
            message: "syntax error",
            range: { start: { line: 2, character: 4 } },
          },
          { severity: 1, message: "warn", range: { start: { line: 0, character: 1 } } },
        ],
      ],
    ]);

    const provider = new VscodeDiagnosticsProvider();
    const files = provider.getDiagnostics();

    expect(files).toEqual([
      {
        uri: "/workspace/a.ts",
        diagnostics: [
          { severity: 0, message: "syntax error", line: 2, character: 4 },
          { severity: 1, message: "warn", line: 0, character: 1 },
        ],
      },
    ]);
  });
});
