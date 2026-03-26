#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildManifest, readManifestSync } from "../manifest/index.js";
import { loadPolicySync } from "../policy/index.js";

const args = process.argv.slice(2);
const command = args[0];

const policyPath =
  getArgValue(args, "--policy") ??
  process.env.SANDBOXIFY_POLICY_PATH ??
  "./sandboxify.policy.jsonc";
const manifestPath =
  getArgValue(args, "--manifest") ??
  process.env.SANDBOXIFY_MANIFEST_PATH ??
  "./.sandboxify/exports.manifest.json";

if (command === "build-manifest") {
  runBuildManifest().catch((error) => {
    console.error(`[sandboxify] build-manifest failed: ${error.message}`);
    process.exitCode = 1;
  });
} else if (command === "doctor") {
  runDoctor();
} else {
  printUsage();
  process.exitCode = command ? 1 : 0;
}

async function runBuildManifest() {
  const manifest = await buildManifest({ policyPath, manifestPath });
  const entriesCount = Object.keys(manifest.entriesByUrl ?? {}).length;
  console.log(`[sandboxify] manifest written: ${manifestPath}`);
  console.log(`[sandboxify] entries: ${entriesCount}`);
}

function runDoctor() {
  const issues = [];
  const warnings = [];

  const nodeMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "0",
    10,
  );
  if (nodeMajor < 25) {
    warnings.push(
      "Node < 25 detected: allowNet permission flag is not enforceable.",
    );
  }

  let policy;
  try {
    policy = loadPolicySync(policyPath);
  } catch (error) {
    issues.push(`Policy could not be loaded: ${error.message}`);
  }

  let manifestStatus = "missing";
  const absoluteManifestPath = path.resolve(process.cwd(), manifestPath);
  if (fs.existsSync(absoluteManifestPath)) {
    manifestStatus = "present";
    try {
      readManifestSync(manifestPath);
    } catch (error) {
      issues.push(`Manifest is invalid: ${error.message}`);
    }
  }

  console.log("[sandboxify] doctor report");
  console.log(`- node: ${process.version}`);
  console.log(`- policy: ${policyPath}`);
  console.log(`- manifest: ${manifestPath} (${manifestStatus})`);

  if (policy) {
    console.log(`- buckets: ${Object.keys(policy.buckets).length}`);
    console.log(`- package mappings: ${(policy.packageMappings ?? []).length}`);
    console.log("- package ownership: canonical from packages");
    console.log("- same-bucket imports: stay native inside the sandbox host");
    console.log(
      "- cross-bucket imports: bridge over RPC to the target bucket (requires allowChildProcess today)",
    );
    console.log("- cross-bucket cycles: unsupported");
  }

  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.log(`- warning: ${warning}`);
    }
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`- issue: ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("- status: ok");
}

function getArgValue(argsList, key) {
  const index = argsList.indexOf(key);
  if (index < 0) {
    return null;
  }

  return argsList[index + 1] ?? null;
}

function printUsage() {
  console.log("sandboxify <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  build-manifest   Build .sandboxify/exports.manifest.json");
  console.log("  doctor           Run basic compatibility checks");
  console.log("");
  console.log("Options:");
  console.log("  --policy <path>    Policy JSON/JSONC path");
  console.log("  --manifest <path>  Manifest output path");
}
