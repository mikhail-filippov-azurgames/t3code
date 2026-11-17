// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - Builds a temp tree and fresh document ids.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { scanRepository, scanText } from "./check-fork-boundary.ts";

const NIL_ID = "00000000-0000-0000-0000-000000000000";

function fixture(files: Record<string, string>) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-boundary-"));
  for (const [file, content] of Object.entries(files)) {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  }
  return root;
}

it("flags account-specific paths and document ids in fork sources", () => {
  const documentId = globalThis.crypto.randomUUID();
  const violations = scanText(
    "packages/ft3-board/src/a.ts",
    [
      'const a = "C:\\\\Users\\\\owner-account\\\\.t3";',
      'const b = "/Users/owner-account/code";',
      'const c = "/home/owner-account/code/";',
      `const d = "oc://doc/${documentId}";`,
      'const e = "C:\\\\Users\\\\User\\\\.t3";',
    ].join("\n"),
  );
  expect(violations.map((violation) => [violation.line, violation.reason])).toEqual([
    [1, "user-specific absolute path"],
    [2, "user-specific absolute path"],
    [3, "user-specific absolute path"],
    [4, "oc:// document id"],
    [5, "user-specific absolute path"],
  ]);
});

it("accepts placeholder names and the nil id only in test files", () => {
  const line = `const a = "/home/user/.t3"; const b = "oc://doc/${NIL_ID}";`;
  expect(scanText("packages/ft3-board/src/a.ts", line)).toHaveLength(1);
  expect(scanText("packages/ft3-board/src/a.test.ts", line)).toEqual([]);
});

it("scans fork source and assets, skipping excluded and out-of-scope files", () => {
  const root = fixture({
    "packages/ft3-board/src/a.ts": 'const a = "/home/owner-account/x/";',
    "packages/ft3-board/assets/plan.md": 'path: "C:\\\\Users\\\\owner-account\\\\x\\\\";',
    "packages/ft3-board/src/node_modules/b.ts": 'const b = "/home/owner-account/x/";',
    "packages/ft3-board/src/.repos/c.ts": 'const c = "/home/owner-account/x/";',
    "packages/ft3-board/src/dist/d.ts": 'const d = "/home/owner-account/x/";',
    "packages/ft3-board/src/bin.dat": "\0/home/owner-account/x/",
    "packages/shared/src/e.ts": 'const e = "/home/owner-account/x/";',
    "docs/f.md": 'path: "/home/owner-account/x/"',
  });
  try {
    const { violations } = scanRepository(root);
    expect(violations.map((violation) => violation.file).sort()).toEqual([
      "packages/ft3-board/assets/plan.md",
      "packages/ft3-board/src/a.ts",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["apps/web/src/filePathDisplay.test.ts", "mike"],
  ["apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts", "private"],
  ["apps/server/src/process/externalLauncher.test.ts", "server"],
  ["apps/server/src/usage/usageTranscriptReader.test.ts", "User"],
])("accepts only the upstream fixture pair %s and %s", (file, name) => {
  const text = 'const path = "/home/' + name + '/fixture";';
  expect(scanText(file, text)).toEqual([]);
  expect(scanText("packages/ft3-board/src/other.test.ts", text)).toHaveLength(1);
  expect(scanText(file, 'const path = "/home/owner-account/fixture";')).toHaveLength(1);
});
