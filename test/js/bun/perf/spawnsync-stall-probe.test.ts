// Temporary probe. The linux-aarch64 CI hang of linker-order.test.ts's tracer
// case is a `spawnSync` (llvm-nm, piped stdout/stderr) that does not return
// until the bun:test deadline kills the child: a watchdog `setTimeout` in the
// test never fired, and the test failed 0.1 ms after its deadline, which is
// spawnSync's isolated loop waking at `bun_test_timeout`. This file calls the
// same spawnSync many times, alone and next to the async children the real
// file has in flight at that moment, with a watcher process that prints the
// kernel-side state of a call that stalls (spawnsync-stall-watcher.ts).
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isMusl, tempDir } from "harness";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const compiler = process.env.CC || Bun.which("cc") || Bun.which("clang") || Bun.which("gcc");
const nm = Bun.which("llvm-nm") || Bun.which("nm");
const canProbe = isLinux && !isMusl && !!compiler && !!nm;

describe.skipIf(!canProbe)("spawnSync stall probe", () => {
  let root = "";
  let dirHandle: ReturnType<typeof tempDir>;
  let fixture = "";
  let ptyrun = "";
  let preload = "";

  const probe = [
    `process.stdin.once("data", data => {`,
    `  process.stdout.write([Boolean(process.stdin.isTTY), process.env.LD_PRELOAD ?? "none", data.toString().trim()].join(" ") + "\\n");`,
    `  process.stdin.pause();`,
    `});`,
  ].join("\n");

  async function compile(args: string[]) {
    await using proc = Bun.spawn({ cmd: [compiler!, "-O1", ...args], env: bunEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`${compiler} ${args.join(" ")} exited ${exitCode}:\n${stdout}${stderr}`);
  }

  test("setup", async () => {
    dirHandle = tempDir("spawnsync-stall", { "empty.c": "int ptyrun_nothing;\n" });
    root = String(dirHandle);
    fixture = join(root, "fixture");
    ptyrun = join(root, "ptyrun");
    preload = join(root, "empty.so");
    await Promise.all([
      compile(["-o", fixture, join(import.meta.dir, "functrace-fixture.c")]),
      compile(["-o", ptyrun, join(import.meta.dir, "../../../../scripts/orderfile/ptyrun.c"), "-lutil"]),
      compile(["-shared", "-fPIC", "-o", preload, join(root, "empty.c")]),
    ]);
    console.log(`nm=${nm} ss=${Bun.which("ss")} watcher threshold 2000 ms`);
  });

  function startWatcher() {
    return Bun.spawn({
      cmd: [bunExe(), join(import.meta.dir, "spawnsync-stall-watcher.ts"), String(process.pid), "llvm-nm", "2000"],
      env: bunEnv,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  /** One `readTextSymbols`-shaped call. Returns ms taken, or -ms when it stalled past `timeout`. */
  function nmOnce(timeoutMs: number): number {
    const started = performance.now();
    const r = spawnSync(nm!, [fixture], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 29, timeout: timeoutMs });
    const took = performance.now() - started;
    if (r.error || took > timeoutMs - 100) {
      console.error(
        `STALLED spawnSync: ${took.toFixed(0)} ms error=${r.error?.message} status=${r.status} signal=${r.signal} stdout=${r.stdout?.length} stderr=${JSON.stringify(r.stderr?.toString().slice(0, 200))}`,
      );
      return -took;
    }
    if (r.status !== 0 || !r.stdout?.length) throw new Error(`nm exited ${r.status}: ${r.stderr}`);
    return took;
  }

  async function run(label: string, budgetMs: number, churn: () => Promise<void> | void) {
    await using watcher = startWatcher();
    let calls = 0,
      stalls = 0,
      slowest = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs && stalls < 3) {
      await churn();
      const took = nmOnce(8000);
      calls++;
      if (took < 0) stalls++;
      else slowest = Math.max(slowest, took);
    }
    watcher.kill("SIGKILL");
    console.log(
      `${label}: ${calls} spawnSync calls, ${stalls} stalled, slowest ok ${slowest.toFixed(0)} ms, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    return stalls;
  }

  const budget = Number(process.env.SPAWNSYNC_PROBE_BUDGET_MS) || (process.arch === "arm64" ? 45_000 : 15_000);

  test("alone", async () => {
    expect(await run("alone", budget, () => {})).toBe(0);
  }, 120_000);

  test("next to async children on pipes", async () => {
    // Like the pty case's `bun -e probe` on pipes plus two exiting compiles.
    const live = new Set<Promise<unknown>>();
    const stalls = await run("pipes", budget, async () => {
      while (live.size >= 3) await Promise.race(live);
      for (const cmd of [
        [bunExe(), "-e", probe],
        ["/bin/sh", "-c", "echo out; echo err >&2"],
      ]) {
        const proc = Bun.spawn({ cmd, env: bunEnv, stdin: new Blob(["hi\n"]), stdout: "pipe", stderr: "pipe" });
        const p = Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]).finally(() => live.delete(p));
        live.add(p);
      }
    });
    await Promise.all(live);
    expect(stalls).toBe(0);
  }, 120_000);

  test("next to a child under a pty", async () => {
    // The pty case exactly: ptyrun bun -e probe (Blob stdin, LD_PRELOAD handed down) and bun -e probe.
    const live = new Set<Promise<unknown>>();
    const stalls = await run("pty", budget, async () => {
      while (live.size >= 2) await Promise.race(live);
      const pty = Bun.spawn({
        cmd: [ptyrun, bunExe(), "-e", probe],
        env: { ...bunEnv, PTYRUN_PRELOAD: preload },
        stdin: new Blob(["hi\n"]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const pipe = Bun.spawn({
        cmd: [bunExe(), "-e", probe],
        env: bunEnv,
        stdin: new Blob(["hi\n"]),
        stdout: "pipe",
        stderr: "pipe",
      });
      for (const proc of [pty, pipe]) {
        const p = Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]).finally(() => live.delete(p));
        live.add(p);
      }
    });
    await Promise.all(live);
    expect(stalls).toBe(0);
  }, 120_000);

  test("cleanup", () => {
    dirHandle?.[Symbol.dispose]?.();
  });
});
