// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import {
  createOpenContextDocResolver,
  parseStableIdFromFrontmatter,
  resolveOpenContextRoot,
} from "./openContextDocs.ts";

const DOCUMENTS_SCHEMA = `
  CREATE TABLE docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    abs_path TEXT NOT NULL,
    description TEXT DEFAULT '',
    stable_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

interface DocumentRow {
  readonly stableId: string;
  readonly name: string;
  readonly relPath: string;
  readonly absPath: string;
}

function writeStoreDatabase(databasePath: string, rows: readonly DocumentRow[]): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(DOCUMENTS_SCHEMA);
    const insert = database.prepare(
      "INSERT INTO docs (folder_id, name, rel_path, abs_path, stable_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(1, row.name, row.relPath, row.absPath, row.stableId, "2026-01-01", "2026-01-01");
    }
  } finally {
    database.close();
  }
}

async function makeTemporaryRoot(): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencontext-docs-test-"));
}

describe("openContextDocs", () => {
  it("parses a stable id only from the frontmatter header", () => {
    assert.strictEqual(
      parseStableIdFromFrontmatter(
        "---\nkind: note\nstable_id: 11111111-1111-1111-1111-111111111111\n---\n",
      ),
      "11111111-1111-1111-1111-111111111111",
    );
    assert.strictEqual(
      parseStableIdFromFrontmatter('---\nstable_id: "22222222-2222-2222-2222-222222222222"\n---\n'),
      "22222222-2222-2222-2222-222222222222",
    );
    assert.strictEqual(parseStableIdFromFrontmatter("---\nkind: note\n---\n\nbody\n"), null);
    const buried = `body\n${"x".repeat(5000)}\nstable_id: 33333333-3333-3333-3333-333333333333\n`;
    assert.strictEqual(parseStableIdFromFrontmatter(buried), null);
  });

  it("prefers OPENCONTEXT_HOME over the user home", () => {
    const userHome = NodePath.join("C:\\Users", "fixture");
    assert.strictEqual(
      resolveOpenContextRoot({ OPENCONTEXT_HOME: NodePath.join(userHome, "custom") }, userHome),
      NodePath.join(userHome, "custom"),
    );
    assert.strictEqual(
      resolveOpenContextRoot({}, userHome),
      NodePath.join(userHome, ".opencontext"),
    );
  });

  it("resolves a document from a read-only snapshot of the store database", async () => {
    const root = await makeTemporaryRoot();
    const documentPath = NodePath.join(root, "contexts", "notes", "plan.md");
    try {
      await NodeFSP.mkdir(NodePath.dirname(documentPath), { recursive: true });
      await NodeFSP.writeFile(documentPath, "# plan\n", "utf8");
      writeStoreDatabase(NodePath.join(root, "opencontext.db"), [
        {
          stableId: "11111111-1111-1111-1111-111111111111",
          name: "plan.md",
          relPath: "notes/plan.md",
          absPath: documentPath,
        },
      ]);

      const resolver = createOpenContextDocResolver({ root });
      const found = await resolver.resolve("11111111-1111-1111-1111-111111111111");
      assert.strictEqual(found.status, "found");
      if (found.status !== "found") return;
      assert.strictEqual(found.absolutePath, documentPath);
      assert.strictEqual(found.relativePath, "notes/plan.md");
      assert.strictEqual(found.name, "plan.md");

      const unknown = await resolver.resolve("99999999-9999-9999-9999-999999999999");
      assert.strictEqual(unknown.status, "not_found");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to frontmatter when the store database is absent", async () => {
    const root = await makeTemporaryRoot();
    const documentPath = NodePath.join(root, "contexts", "project", "decision.md");
    try {
      await NodeFSP.mkdir(NodePath.dirname(documentPath), { recursive: true });
      await NodeFSP.writeFile(
        documentPath,
        "---\nkind: decision\nstable_id: 44444444-4444-4444-4444-444444444444\n---\n\n# decision\n",
        "utf8",
      );

      const resolver = createOpenContextDocResolver({ root });
      const found = await resolver.resolve("44444444-4444-4444-4444-444444444444");
      assert.strictEqual(found.status, "found");
      if (found.status !== "found") return;
      assert.strictEqual(found.absolutePath, documentPath);
      assert.strictEqual(found.relativePath, "contexts/project/decision.md");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing store as unavailable instead of failing", async () => {
    const root = await makeTemporaryRoot();
    try {
      const resolver = createOpenContextDocResolver({
        root: NodePath.join(root, "does-not-exist"),
      });
      const result = await resolver.resolve("11111111-1111-1111-1111-111111111111");
      assert.strictEqual(result.status, "store_unavailable");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
