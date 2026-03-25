import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function createTempProjectFromFixture(fixtureName) {
  const fixtureDir = path.join(
    repoRoot,
    "test",
    "fixtures",
    "apps",
    fixtureName,
  );
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandboxify-it-"));

  fs.cpSync(fixtureDir, projectDir, { recursive: true });

  return {
    projectDir,
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

export function materializePolicy(projectDir, { allowNet }) {
  const source = allowNet
    ? path.join(projectDir, "sandboxify.policy.allow-net.true.jsonc")
    : path.join(projectDir, "sandboxify.policy.allow-net.false.jsonc");
  const target = path.join(projectDir, "sandboxify.policy.jsonc");

  const projectDirUrl = pathToFileURL(
    fs.realpathSync(projectDir),
  ).href.replaceAll("/", "\\/");
  const raw = fs.readFileSync(source, "utf8");
  const rendered = raw.replaceAll("__PROJECT_DIR_URL__", projectDirUrl);
  fs.writeFileSync(target, rendered);
}
