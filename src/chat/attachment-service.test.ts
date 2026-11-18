import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentService } from "./attachment-service";
import { nodeFileSystem } from "../core/tools/file-system";

function makeService(dialog: () => Promise<string[] | undefined>): AttachmentService {
  return new AttachmentService(nodeFileSystem, dialog);
}

describe("AttachmentService", () => {
  let dir: string;

  it("returns an empty list when the dialog is cancelled", async () => {
    const service = makeService(async () => undefined);
    expect(await service.pick()).toEqual([]);
  });

  it("returns metadata for picked files", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const txt = join(dir, "sample.txt");
    const img = join(dir, "image.png");
    writeFileSync(txt, "content");
    writeFileSync(img, "x");

    const service = makeService(async () => [txt, img]);
    const files = await service.pick();

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ name: "sample.txt", path: txt, size: 7, isImage: false });
    expect(files[1].isImage).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("builds context with file contents wrapped in a code block", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const txt = join(dir, "a.txt");
    writeFileSync(txt, "line 1\nline 2");

    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "a.txt", path: txt, size: 12, isImage: false }]);

    expect(ctx.text).toContain('Attached file "a.txt":');
    expect(ctx.text).toContain("line 1\nline 2");
    expect(ctx.text).toContain("```");
    expect(ctx.images).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds context with an image note for images", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "image.png", path: "/x/image.png", size: 2048, isImage: true }]);

    expect(ctx.text).toContain("[Image attached: image.png (2.0KB)");
  });

  it("uses a clipboard image's data URI directly (no file on disk)", async () => {
    const service = makeService(async () => []);
    const dataUri = "data:image/png;base64,AAAA";
    const ctx = await service.buildContext([{ name: "pasted-image.png", path: "", size: 4, isImage: true, dataUri }]);

    expect(ctx.images).toEqual([dataUri]);
    expect(ctx.text).toContain("pasted from clipboard");
  });

  it("returns numbered parts for per-sub-agent attachment forwarding", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([
      { name: "a.txt", path: "", size: 3, isImage: false, content: "AAA" },
      { name: "img.png", path: "", size: 4, isImage: true, dataUri: "data:image/png;base64,AAAA" },
    ]);
    expect(ctx.text).toContain("[User attachments");
    expect(ctx.text).toContain('1. "a.txt" (text)');
    expect(ctx.text).toContain('2. "img.png" (image)');
    expect(ctx.parts).toHaveLength(2);
    expect(ctx.parts[0]).toMatchObject({ name: "a.txt", isImage: false, text: "AAA" });
    expect(ctx.parts[1]).toMatchObject({ name: "img.png", isImage: true, dataUri: "data:image/png;base64,AAAA" });
  });

  it("omits the numbered header and parts when there are no attachments", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([]);
    expect(ctx.text).toBe("");
    expect(ctx.parts).toEqual([]);
    expect(ctx.images).toEqual([]);
  });

  it("inlines a pasted text file's content (no path)", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([
      { name: "notes.md", path: "", size: 5, isImage: false, content: "# hi\n" },
    ]);
    expect(ctx.text).toContain('Attached file "notes.md":');
    expect(ctx.text).toContain("# hi");
  });

  it("notes a pasted binary file whose content is unavailable", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "report.pdf", path: "", size: 12345, isImage: false }]);
    expect(ctx.text).toContain('Attached file "report.pdf"');
    expect(ctx.text).toContain("binary");
  });

  it("detects an attached BINARY file from its content and never inlines it", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const pdf = join(dir, "report.pdf");
    writeFileSync(pdf, "%PDF-1.7\n1 0 obj\nstream\n\u0000\u0001binary\nendstream");

    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "report.pdf", path: pdf, size: 40, isImage: false }]);

    expect(ctx.text).toContain("PDF");
    expect(ctx.text).toContain("not inlined");
    // The undecodable bytes are NOT inlined into the model context.
    expect(ctx.text).not.toContain("%PDF-1.7");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a ZIP container as ZIP (the model knows a .docx is a ZIP)", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const docx = join(dir, "memo.docx");
    writeFileSync(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));

    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "memo.docx", path: docx, size: 8, isImage: false }]);

    expect(ctx.text).toContain("ZIP");
    expect(ctx.text).toContain("memo.docx");
    expect(ctx.text).toContain("not inlined");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fromPaths returns metadata only for existing paths", () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const txt = join(dir, "a.txt");
    writeFileSync(txt, "hi");
    const service = makeService(async () => []);
    const files = service.fromPaths([txt, join(dir, "missing.txt"), ""]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "a.txt", path: txt, size: 2, isImage: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("fromPaths refuses a DIRECTORY, and says which of the two it was", () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const sub = join(dir, "src");
    const txt = join(dir, "a.txt");
    mkdirSync(sub);
    writeFileSync(txt, "hi");
    const service = makeService(async () => []);

    // A folder dragged from the Explorer is a real gesture. It used to come back as a CHIP named
    // after the directory (exists() is true for dirs) whose only payload, one turn later, was a
    // note saying the content was not available.
    expect(service.fromPaths([sub])).toEqual([]);
    expect(service.refusalReason(sub)).toBe("folder");
    expect(service.refusalReason(join(dir, "gone.txt"))).toBe("missing");
    expect(service.refusalReason(txt)).toBe("unreadable"); // readable, but fromPaths took it
    rmSync(dir, { recursive: true, force: true });
  });

  it("fromPaths survives a path whose stat() throws instead of failing the whole gesture", () => {
    const service = new AttachmentService(
      {
        ...nodeFileSystem,
        exists: () => true,
        isDirectory: () => false,
        size: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
      async () => [],
    );
    // Unguarded, `fs.size` threw straight out of the webview message handler: the reader got
    // nothing at all, not even the message they were already owed.
    expect(service.fromPaths(["/secret/x.txt"])).toEqual([]);
    expect(service.refusalReason("/secret/x.txt")).toBe("unreadable");
  });

  it("fromPaths includes an inline data URI for image files (for previews)", () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const png = join(dir, "image.png");
    writeFileSync(png, "png-bytes");
    const service = makeService(async () => []);
    const files = service.fromPaths([png]);
    expect(files[0].isImage).toBe(true);
    expect(String(files[0].dataUri)).toMatch(/^data:image\/png;base64,/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncates very large files", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const big = join(dir, "big.txt");
    writeFileSync(big, "a".repeat(40000));

    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "big.txt", path: big, size: 40000, isImage: false }]);

    expect(ctx.text.length).toBeLessThan(31000);
    expect(ctx.text).toContain("[Content truncated...]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a data-URI for a real image file", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const png = join(dir, "image.png");
    writeFileSync(png, "png-bytes");

    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "image.png", path: png, size: 9, isImage: true }]);

    expect(ctx.images).toHaveLength(1);
    expect(ctx.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(ctx.text).toContain("[Image attached: image.png");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not attach oversized images and says so", async () => {
    dir = mkdtempSync(join(tmpdir(), "harny-att-"));
    const big = join(dir, "image.png");
    writeFileSync(big, "x".repeat(16 * 1024 * 1024));

    const service = makeService(async () => []);
    const ctx = await service.buildContext([{ name: "image.png", path: big, size: 16 * 1024 * 1024, isImage: true }]);

    expect(ctx.images).toHaveLength(0);
    expect(ctx.text).toContain("too large");
    rmSync(dir, { recursive: true, force: true });
  });

  it("notes unreadable files", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([
      { name: "missing.txt", path: "/tmp/does-not-exist-xyz.txt", size: 0, isImage: false },
    ]);

    expect(ctx.text).toContain("[Could not read file: missing.txt]");
  });
});
