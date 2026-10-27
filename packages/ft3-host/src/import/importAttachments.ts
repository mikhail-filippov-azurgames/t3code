// @effect-diagnostics nodeBuiltinImport:off - one-shot migration copies chat attachment files between two T3 homes.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface AttachmentImportInput {
  /** Pre-V2 home root; its `userdata` directory holds the served attachments. */
  readonly sourceHome: string;
  /** V2 home root; the migration writes only below its `userdata` directory. */
  readonly targetHome: string;
  /** Replace target files whose bytes differ instead of keeping the V2-side copy. */
  readonly overwrite?: boolean;
  /** Report the planned actions without touching the target home. */
  readonly dryRun?: boolean;
}

export interface AttachmentImportReport {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly sourceFiles: number;
  readonly copied: number;
  readonly replaced: number;
  readonly identical: number;
  /** Differing bytes on both sides; kept because `overwrite` is off. */
  readonly conflicts: ReadonlyArray<string>;
  /** Names V2 cannot resolve as `<attachment id>.<extension>`. */
  readonly invalid: ReadonlyArray<string>;
}

export interface AttachmentImportResult {
  readonly report: AttachmentImportReport;
  readonly changed: boolean;
}

const ATTACHMENT_FILE_NAME = /^[a-z0-9_-]+\.[a-z0-9]{1,10}$/i;

// V2 resolves every stored extension in lowercase, so an uppercase name would never be found.
const isUsableAttachmentName = (name: string): boolean =>
  ATTACHMENT_FILE_NAME.test(name) && name === name.toLowerCase();

const isNodeError = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === code;

const readIfExists = async (filePath: string): Promise<Uint8Array | undefined> => {
  try {
    return await NodeFSP.readFile(filePath);
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return undefined;
    throw cause;
  }
};

const writeAtomically = async (filePath: string, bytes: Uint8Array): Promise<void> => {
  const temporaryPath = `${filePath}.importing`;
  try {
    await NodeFSP.writeFile(temporaryPath, bytes);
    await NodeFSP.rm(filePath, { force: true });
    await NodeFSP.rename(temporaryPath, filePath);
  } catch (cause) {
    await NodeFSP.rm(temporaryPath, { force: true });
    throw cause;
  }
};

const readSourceEntries = async (sourceDir: string) => {
  try {
    return await NodeFSP.readdir(sourceDir, { withFileTypes: true });
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) {
      throw new Error(`Attachment source directory not found: ${sourceDir}`, { cause });
    }
    throw cause;
  }
};

/**
 * Copy `<source>/userdata/attachments` into `<target>/userdata/attachments`.
 *
 * V2 resolves an attachment by `<id>.<extension>` inside its own home, so names
 * carry the layout and no metadata rows are needed. Identical files are left
 * alone; differing files stay untouched unless `overwrite` is set.
 */
export const importAttachments = async (
  input: AttachmentImportInput,
): Promise<AttachmentImportResult> => {
  const sourceHome = NodePath.resolve(input.sourceHome);
  const targetHome = NodePath.resolve(input.targetHome);
  const sourceDir = NodePath.join(sourceHome, "userdata", "attachments");
  const targetDir = NodePath.join(targetHome, "userdata", "attachments");

  const entries = await readSourceEntries(sourceDir);
  const overwrite = input.overwrite ?? false;
  const dryRun = input.dryRun ?? false;

  const conflicts: string[] = [];
  const invalid: string[] = [];
  let copied = 0;
  let replaced = 0;
  let identical = 0;
  let changed = false;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!isUsableAttachmentName(name)) {
      invalid.push(name);
      continue;
    }

    const sourcePath = NodePath.join(sourceDir, name);
    const targetPath = NodePath.join(targetDir, name);
    const sourceBytes = await NodeFSP.readFile(sourcePath);
    const targetBytes = await readIfExists(targetPath);

    if (targetBytes !== undefined && Buffer.from(targetBytes).equals(sourceBytes)) {
      identical += 1;
      continue;
    }

    if (targetBytes !== undefined && !overwrite) {
      conflicts.push(name);
      continue;
    }

    if (targetBytes === undefined) copied += 1;
    else replaced += 1;
    changed = true;
    if (dryRun) continue;

    await NodeFSP.mkdir(targetDir, { recursive: true });
    await writeAtomically(targetPath, sourceBytes);
  }

  return {
    changed,
    report: {
      sourceDir,
      targetDir,
      sourceFiles: entries.filter((entry) => entry.isFile()).length,
      copied,
      replaced,
      identical,
      conflicts,
      invalid,
    },
  };
};
