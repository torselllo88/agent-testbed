import fs from "node:fs";
import path from "node:path";

/**
 * Batch specs kept as files in the repository — versioned, reviewable, the
 * same for the web UI and the CLI. The UI lists every `*.batch.json` in these
 * folders (relative to where the server runs: the repository root) and loads
 * one into the batch form; nothing here writes files.
 *
 *   specs/                       the group's own specs (pilot, calibration, real runs)
 *   examples/                    examples that come with the testbed
 *   experiments/pilot-settlement/  the pilot's own specs (probe, dev runs, controls)
 */
export const DEFAULT_SPEC_DIRS = ["specs", "examples", "experiments/pilot-settlement"];

export interface SpecEntry {
  /** "<dir>/<file>" — what the UI asks for. */
  id: string;
  dir: string;
  file: string;
  name: string | null;
  description: string | null;
  /** Not valid JSON (the file is listed, but cannot be loaded). */
  error: string | null;
}

export class SpecLibrary {
  constructor(
    private readonly dirs: string[] = DEFAULT_SPEC_DIRS,
    private readonly root: string = process.cwd()
  ) {}

  list(): SpecEntry[] {
    return this.dirs.flatMap((dir) => {
      const full = path.resolve(this.root, dir);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return [];
      return fs
        .readdirSync(full)
        .filter((file) => file.endsWith(".batch.json"))
        .sort()
        .map((file) => {
          const entry: SpecEntry = { id: `${dir}/${file}`, dir, file, name: null, description: null, error: null };
          try {
            const spec = JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as { name?: unknown; description?: unknown };
            entry.name = typeof spec.name === "string" ? spec.name : null;
            entry.description = typeof spec.description === "string" ? spec.description : null;
          } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
          }
          return entry;
        });
    });
  }

  /**
   * One listed spec, parsed. Only ids the listing returns are read — no other
   * path on the machine can be asked for. A CLI-only base { "configPath" } is
   * inlined as { "config" }, so the form can show and run it.
   */
  read(id: string): unknown | null {
    const entry = this.list().find((e) => e.id === id);
    if (!entry || entry.error) return null;
    const file = path.resolve(this.root, entry.dir, entry.file);
    const spec = JSON.parse(fs.readFileSync(file, "utf8")) as { base?: Record<string, unknown> };
    if (spec.base && typeof spec.base.configPath === "string") {
      spec.base = { config: JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), spec.base.configPath), "utf8")) };
    }
    return spec;
  }
}
