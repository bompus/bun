// Temporary probe: spawnsync-stall-probe.test.ts, but inside a `bun test
// --parallel` worker, which is where linker-order.test.ts's spawnSync stalled.
import { expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isMusl } from "harness";
import { join } from "node:path";

test.skipIf(!isLinux || isMusl)(
  "spawnSync stall probe inside a parallel worker",
  async () => {
    const repo = join(import.meta.dir, "../../../..");
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "test",
        "--parallel=2",
        "--timeout=125000",
        join(import.meta.dir, "spawnsync-stall-probe.test.ts"),
        join(repo, "test/js/bun/util/fuzzy-wuzzy.test.ts"),
      ],
      cwd: repo,
      env: { ...bunEnv, SPAWNSYNC_PROBE_BUDGET_MS: process.arch === "arm64" ? "40000" : "10000" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const out = stdout + stderr;
    console.log(
      out
        .split("\n")
        .filter(line => /STALL|spawnSync calls|^=== |child|parent|epoll|unix sockets|Recv-Q|u_str/.test(line))
        .join("\n"),
    );
    expect(out).not.toContain("STALLED spawnSync");
    expect(exitCode).toBe(0);
  },
  170_000,
);
