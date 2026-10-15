/**
 * Installs this package's agent roles and saved workflows where pi-ultracode
 * discovers them (~/.pi/ultracode/{agents,workflows}).
 *
 * Ownership rule: a target file is "managed" if it contains MANAGED_MARKER.
 *   - missing            -> written
 *   - managed + changed  -> updated (package upgrade)
 *   - unmanaged          -> never touched (you customized it; delete the marker line to take ownership)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MANAGED_MARKER = "managedBy: pi-ultracode-verify";

export interface SyncReport {
  written: string[];
  updated: string[];
  skippedUserOwned: string[];
  unchanged: number;
}

export const ULTRACODE_HOME = path.join(os.homedir(), ".pi", "ultracode");

function syncDir(
  srcDir: string,
  destDir: string,
  filter: (f: string) => boolean,
  report: SyncReport,
) {
  let files: string[];
  try {
    files = fs.readdirSync(srcDir).filter(filter);
  } catch {
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const src = fs.readFileSync(path.join(srcDir, f), "utf8");
    const dest = path.join(destDir, f);
    let current: string | undefined;
    try {
      current = fs.readFileSync(dest, "utf8");
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      fs.writeFileSync(dest, src);
      report.written.push(dest);
    } else if (!current.includes(MANAGED_MARKER)) {
      report.skippedUserOwned.push(dest);
    } else if (current !== src) {
      fs.writeFileSync(dest, src);
      report.updated.push(dest);
    } else {
      report.unchanged++;
    }
  }
}

export function syncAssets(assetsDir: string, home = ULTRACODE_HOME): SyncReport {
  const report: SyncReport = { written: [], updated: [], skippedUserOwned: [], unchanged: 0 };
  syncDir(
    path.join(assetsDir, "agents"),
    path.join(home, "agents"),
    (f) => f.endsWith(".md"),
    report,
  );
  syncDir(
    path.join(assetsDir, "workflows"),
    path.join(home, "workflows"),
    (f) => f.endsWith(".workflow.js"),
    report,
  );
  return report;
}
