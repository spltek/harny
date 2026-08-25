import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
    const ctx = await service.buildContext([
      { name: "a.txt", path: txt, size: 12, isImage: false },
    ]);

    expect(ctx.text).toContain('Attached file "a.txt":');
    expect(ctx.text).toContain("line 1\nline 2");
    expect(ctx.text).toContain("```");
    expect(ctx.images).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds context with an image note for images", async () => {
    const service = makeService(async () => []);
    const ctx = await service.buildContext([
      { name: "image.png", path: "/x/image.png", size: 2048, isImage: true },
    ]);

    expect(ctx.text).toContain("[Image attached: image.png (2.0KB)");
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
