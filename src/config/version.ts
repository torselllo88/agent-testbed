import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

export interface TestbedVersion {
  packageVersion: string;
  /** null when not running from a git checkout (e.g. an unpacked archive). */
  gitCommit: string | null;
  /** True when the working tree had uncommitted changes — such a run is not reproducible from gitCommit alone. */
  gitDirty: boolean | null;
  nodeVersion: string;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: env.projectRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

let cached: TestbedVersion | undefined;

/** Resolved once per process — recorded on every experiment so a run can be tied to the exact code that produced it. */
export function getTestbedVersion(): TestbedVersion {
  if (cached) return cached;
  const pkg = JSON.parse(fs.readFileSync(path.join(env.projectRoot, "package.json"), "utf-8")) as { version?: string };
  const gitCommit = git(["rev-parse", "HEAD"]);
  const status = gitCommit ? git(["status", "--porcelain"]) : null;
  cached = {
    packageVersion: pkg.version ?? "0.0.0",
    gitCommit,
    gitDirty: status === null ? null : status.length > 0,
    nodeVersion: process.version,
  };
  return cached;
}
