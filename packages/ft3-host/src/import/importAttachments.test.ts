// @effect-diagnostics nodeBuiltinImport:off - the migration test needs disposable homes.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { importAttachments } from "./importAttachments.ts";

const tempHome = (prefix: string): Promise<string> =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));

const sourceAttachments = (home: string): string => NodePath.join(home, "userdata", "attachments");

const targetAttachments = (home: string): string => NodePath.join(home, "userdata", "attachments");

const seedFile = async (home: string, name: string, bytes: Uint8Array): Promise<void> => {
  const directory = sourceAttachments(home);
  await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(directory, name), bytes);
};

const readFile = async (home: string, name: string): Promise<string> =>
  await NodeFSP.readFile(NodePath.join(targetAttachments(home), name), "utf8");

const assertMissing = async (filePath: string): Promise<void> => {
  try {
    await NodeFSP.stat(filePath);
  } catch {
    return;
  }
  assert.fail(`Expected ${filePath} to be absent`);
};

const messageImageId = "f4aa9f04-fbe4-4647-91b3-463d33ba1f52-8cc052d1-d2ea-49de-8e68-3c9e2e27756d";

describe("importAttachments", () => {
  it("copies served attachment files into the V2 home under their lookup names", async () => {
    const sourceHome = await tempHome("ft3-att-src-");
    const targetHome = await tempHome("ft3-att-dst-");
    try {
      await seedFile(sourceHome, `${messageImageId}.png`, new Uint8Array([1, 2, 3]));
      await seedFile(
        sourceHome,
        "197154b1-09f3-437f-a483-a94a4aef0ab0-60ac9ac0-b63a-493b-8676-20c60a4cd97d-xml.xml",
        new Uint8Array([4, 5, 6]),
      );

      const result = await importAttachments({ sourceHome, targetHome });

      assert.isTrue(result.changed);
      assert.equal(result.report.sourceFiles, 2);
      assert.equal(result.report.copied, 2);
      assert.equal(result.report.replaced, 0);
      assert.equal(result.report.identical, 0);
      assert.deepEqual(result.report.conflicts, []);
      assert.deepEqual(result.report.invalid, []);
      assert.equal(await readFile(targetHome, `${messageImageId}.png`), "\u0001\u0002\u0003");
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("is idempotent and leaves identical copies untouched", async () => {
    const sourceHome = await tempHome("ft3-att-src-");
    const targetHome = await tempHome("ft3-att-dst-");
    try {
      await seedFile(sourceHome, `${messageImageId}.png`, new Uint8Array([1, 2, 3]));

      const first = await importAttachments({ sourceHome, targetHome });
      const second = await importAttachments({ sourceHome, targetHome });

      assert.isTrue(first.changed);
      assert.isFalse(second.changed);
      assert.equal(second.report.copied, 0);
      assert.equal(second.report.replaced, 0);
      assert.equal(second.report.identical, 1);
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("keeps differing V2 files unless overwrite is requested", async () => {
    const sourceHome = await tempHome("ft3-att-src-");
    const targetHome = await tempHome("ft3-att-dst-");
    try {
      await seedFile(sourceHome, `${messageImageId}.png`, new Uint8Array([1, 2, 3]));
      await NodeFSP.mkdir(targetAttachments(targetHome), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(targetAttachments(targetHome), `${messageImageId}.png`),
        new Uint8Array([9, 9, 9]),
      );

      const kept = await importAttachments({ sourceHome, targetHome });
      assert.isFalse(kept.changed);
      assert.deepEqual(kept.report.conflicts, [`${messageImageId}.png`]);
      assert.equal(await readFile(targetHome, `${messageImageId}.png`), "\t\t\t");

      const replaced = await importAttachments({ sourceHome, targetHome, overwrite: true });
      assert.isTrue(replaced.changed);
      assert.equal(replaced.report.replaced, 1);
      assert.equal(replaced.report.conflicts.length, 0);
      assert.equal(await readFile(targetHome, `${messageImageId}.png`), "\u0001\u0002\u0003");
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("skips partial uploads and names V2 cannot resolve, without writing in a dry run", async () => {
    const sourceHome = await tempHome("ft3-att-src-");
    const targetHome = await tempHome("ft3-att-dst-");
    try {
      await seedFile(sourceHome, `${messageImageId}.png`, new Uint8Array([1]));
      await seedFile(sourceHome, `${messageImageId}.png.part`, new Uint8Array([2]));
      await seedFile(sourceHome, "no-extension", new Uint8Array([3]));
      await seedFile(sourceHome, "IMAGEPNG.png", new Uint8Array([4]));
      await NodeFSP.mkdir(NodePath.join(sourceAttachments(sourceHome), "nested"));

      const dry = await importAttachments({ sourceHome, targetHome, dryRun: true });
      assert.isTrue(dry.changed);
      assert.equal(dry.report.copied, 1);
      assert.deepEqual([...dry.report.invalid].sort(), [
        "IMAGEPNG.png",
        `${messageImageId}.png.part`,
        "no-extension",
      ]);
      await assertMissing(targetAttachments(targetHome));

      const real = await importAttachments({ sourceHome, targetHome });
      assert.equal(real.report.copied, 1);
      assert.equal(real.report.identical, 0);
      assert.equal(await readFile(targetHome, `${messageImageId}.png`), "\u0001");
      await assertMissing(NodePath.join(targetAttachments(targetHome), "nested"));
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });

  it("fails clearly when the source home has no attachments directory", async () => {
    const sourceHome = await tempHome("ft3-att-src-");
    const targetHome = await tempHome("ft3-att-dst-");
    try {
      let message = "";
      try {
        await importAttachments({ sourceHome, targetHome });
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      assert.match(message, /Attachment source directory not found/);
    } finally {
      await NodeFSP.rm(sourceHome, { recursive: true, force: true });
      await NodeFSP.rm(targetHome, { recursive: true, force: true });
    }
  });
});
