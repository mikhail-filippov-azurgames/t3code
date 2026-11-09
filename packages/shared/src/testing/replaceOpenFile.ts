// @effect-diagnostics nodeBuiltinImport:off - one synchronous probe at module load, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Skip replace-while-reading fixtures where the OS denies renaming over an open file (Windows without share-delete). */
export const replaceOpenFileSupported: boolean = (() => {
  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-rename-probe-"));
    const target = NodePath.join(directory, "target.txt");
    const staging = NodePath.join(directory, "staging.txt");
    NodeFS.writeFileSync(target, "old");
    NodeFS.writeFileSync(staging, "new");
    const handle = NodeFS.openSync(target, "r");
    try {
      NodeFS.renameSync(staging, target);
      return true;
    } finally {
      NodeFS.closeSync(handle);
    }
  } catch {
    return false;
  } finally {
    try {
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
})();
