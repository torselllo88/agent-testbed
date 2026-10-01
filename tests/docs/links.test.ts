import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Every relative link in the README and docs/ points at a file that exists, and every #anchor at a heading in it. */

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? markdownFiles(full) : e.name.endsWith(".md") ? [full] : [];
  });
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file: string): Set<string> {
  const text = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)));
}

const files = [path.resolve("README.md"), ...markdownFiles(path.resolve("docs"))];

describe("documentation links", () => {
  it("every relative link and anchor resolves", () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target!)) continue; // http(s), mailto
        const [rel, anchor] = target!.split("#");
        const resolved = rel ? path.resolve(path.dirname(file), rel) : file;
        const where = `${path.relative(process.cwd(), file)} → ${target}`;
        if (!fs.existsSync(resolved)) {
          broken.push(`${where} (no such file)`);
          continue;
        }
        if (anchor && resolved.endsWith(".md") && !anchorsOf(resolved).has(anchor)) broken.push(`${where} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
