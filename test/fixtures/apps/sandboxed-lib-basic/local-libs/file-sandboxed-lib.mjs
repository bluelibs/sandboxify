export function multiply(a, b) {
  return a * b;
}

export async function tryChild() {
  const { execSync } = await import("node:child_process");
  return execSync("echo local-child-ok").toString().trim();
}
