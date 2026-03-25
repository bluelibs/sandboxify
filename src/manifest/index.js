import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadPolicySync } from "../policy/index.js";

export async function buildManifest({
  policyPath = "./sandboxify.policy.jsonc",
  manifestPath = "./.sandboxify/exports.manifest.json",
} = {}) {
  const policy = loadPolicySync(policyPath);
  const specifiers = expandPolicySpecifiers(policy);
  const entriesByUrl = {};
  const entriesBySpecifier = {};

  for (const specifier of specifiers) {
    const resolved = resolveSpecifierFromCwd(specifier);
    if (!resolved) {
      continue;
    }

    const realUrl = pathToFileURL(resolved).href;

    let namespace;
    try {
      namespace = await import(realUrl);
    } catch {
      continue;
    }

    const exportNames = Object.keys(namespace);
    if ("default" in namespace && !exportNames.includes("default")) {
      exportNames.unshift("default");
    }

    const entry = {
      package: packageNameFromSpecifier(specifier),
      specifier,
      realUrl,
      exportNames,
      generatedAt: new Date().toISOString(),
    };

    entriesByUrl[realUrl] = entry;
    entriesBySpecifier[specifier] = {
      package: entry.package,
      realUrl,
      exportNames,
    };
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    entriesByUrl,
    entriesBySpecifier,
  };

  const absoluteManifestPath = path.resolve(process.cwd(), manifestPath);
  fs.mkdirSync(path.dirname(absoluteManifestPath), { recursive: true });
  fs.writeFileSync(absoluteManifestPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

export function readManifestSync(
  manifestPath = "./.sandboxify/exports.manifest.json",
) {
  const absoluteManifestPath = path.resolve(process.cwd(), manifestPath);
  const raw = fs.readFileSync(absoluteManifestPath, "utf8");
  return JSON.parse(raw);
}

export function getManifestEntry(manifest, realUrl, specifier) {
  return (
    manifest?.entriesByUrl?.[realUrl] ??
    manifest?.entriesBySpecifier?.[specifier] ??
    null
  );
}

function expandPolicySpecifiers(policy) {
  const discoveredPackages = listInstalledPackages(process.cwd());
  const output = new Set();

  for (const mapping of policy.packageMappings ?? []) {
    if (mapping.type === "exact") {
      output.add(mapping.pattern);
      continue;
    }

    for (const pkg of discoveredPackages) {
      if (pkg.startsWith(mapping.prefix)) {
        output.add(pkg);
      }
    }
  }

  return [...output].sort();
}

function listInstalledPackages(cwd) {
  const nodeModulesPath = path.join(cwd, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    return [];
  }

  const directEntries = fs.readdirSync(nodeModulesPath, {
    withFileTypes: true,
  });
  const results = [];

  for (const entry of directEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith("@")) {
      const scopePath = path.join(nodeModulesPath, entry.name);
      const scopedEntries = fs.readdirSync(scopePath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          results.push(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }

    results.push(entry.name);
  }

  return results;
}

function resolveSpecifierFromCwd(specifier) {
  const cwd = process.cwd();
  const packageJsonPath = path.join(cwd, "package.json");
  const require = createRequire(
    fs.existsSync(packageJsonPath)
      ? packageJsonPath
      : path.join(cwd, "index.js"),
  );

  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }

  return specifier.split("/")[0];
}
