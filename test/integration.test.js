import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  createTempProjectFromFixture,
  materializePolicy,
} from "./helpers/fixture-project.js";
import {
  buildManifest,
  runWithCjsRegister,
  runWithLoader,
} from "./helpers/command.js";

function withTcpServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end("ok");
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

function stripAnsi(input) {
  return String(input).replace(/\u001b\[[0-9;]*m/g, "");
}

test(
  "integration: sandboxed function call succeeds",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "success.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /RESULT\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: child_process denied when not allowed",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "child-check.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CHILD_ERR\s+/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: network denied when allowNet=false",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "net-check.mjs", {
        TEST_PORT: String(tcp.port),
      });
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /NET_ERR\s+/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: network allowed when allowNet=true",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: true });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "net-check.mjs", {
        TEST_PORT: String(tcp.port),
      });
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /NET_OK\s+connected/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: large binary args can use IPC blob offload",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "buffer-check.mjs",
        {
          SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES: "1",
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /BUFFER_SIZE\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: sandboxed function supports batch calls",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(fixture.projectDir, "batch-check.mjs");
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /BATCH_RESULT\s+3,7,11/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: large binary batch args can use IPC blob offload",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "batch-buffer-check.mjs",
        {
          SANDBOXIFY_IPC_BLOB_THRESHOLD_BYTES: "1",
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /BATCH_BUFFER_RESULT\s+1,5,7/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: importerRules route same dependency by importer path",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const restrictedResult = await runWithLoader(
        fixture.projectDir,
        "restricted/importer-net-check.mjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );
      assert.equal(
        restrictedResult.code,
        0,
        `restricted app failed (timedOut=${restrictedResult.timedOut})\nstdout:\n${restrictedResult.stdout}\nstderr:\n${restrictedResult.stderr}`,
      );
      assert.match(
        stripAnsi(restrictedResult.stdout),
        /IMPORTER_RESTRICTED_NET_ERR\s+/,
      );

      const openResult = await runWithLoader(
        fixture.projectDir,
        "open/importer-net-check.mjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );
      assert.equal(
        openResult.code,
        0,
        `open app failed (timedOut=${openResult.timedOut})\nstdout:\n${openResult.stdout}\nstderr:\n${openResult.stderr}`,
      );
      assert.match(
        stripAnsi(openResult.stdout),
        /IMPORTER_OPEN_NET_OK\s+connected/,
      );
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS require flow supports successful call",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-success.cjs",
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_RESULT\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS experimental sync mode supports sync call style",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-sync-experimental.cjs",
        {
          SANDBOXIFY_CJS_SYNC_EXPERIMENTAL: "1",
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_SYNC_RESULT\s+5/);
      assert.match(stripAnsi(result.stdout), /CJS_SYNC_BUFFER\s+5/);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "integration: CJS require flow denies network when allowNet=false",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithCjsRegister(
        fixture.projectDir,
        "cjs-net-check.cjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );
      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /CJS_NET_ERR\s+/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: import-time network side effect is denied when allowNet=false",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: false });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "sideeffect-check.mjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );

      assert.notEqual(
        result.code,
        0,
        "sideeffect import should fail when allowNet=false",
      );
      assert.match(
        stripAnsi(result.stderr),
        /ERR_ACCESS_DENIED|allow-net|permission/i,
      );
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);

test(
  "integration: import-time network side effect succeeds when allowNet=true",
  { concurrency: false },
  async () => {
    const fixture = createTempProjectFromFixture("sandboxed-lib-basic");
    const tcp = await withTcpServer();

    try {
      materializePolicy(fixture.projectDir, { allowNet: true });

      const manifestResult = await buildManifest(fixture.projectDir);
      assert.equal(
        manifestResult.code,
        0,
        `build-manifest failed (timedOut=${manifestResult.timedOut})\nstdout:\n${manifestResult.stdout}\nstderr:\n${manifestResult.stderr}`,
      );

      const result = await runWithLoader(
        fixture.projectDir,
        "sideeffect-check.mjs",
        {
          TEST_PORT: String(tcp.port),
        },
      );

      assert.equal(
        result.code,
        0,
        `app failed (timedOut=${result.timedOut})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(stripAnsi(result.stdout), /SIDEEFFECT_READY\s+true/);
    } finally {
      await tcp.close();
      fixture.cleanup();
    }
  },
);
