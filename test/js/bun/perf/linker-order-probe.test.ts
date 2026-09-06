// Temporary probe for the linux-aarch64 CI hang of linker-order.test.ts's
// "function tracer > records exact entries, and keeps them across an exec'd
// child" (90 s timeout in the parallel batch, builds 110996, 111195, 111496,
// 111536). It runs the same traced fixture many times under load, and the real
// test file inside a small `bun test --parallel` batch, and prints where a run
// that stops making progress is stuck. It asserts only that no run hung.
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isMusl, tempDir } from "harness";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { readTextSymbols } from "../../../../scripts/orderfile/generate.ts";
import { childrenOf, describeSelf, describeTree, probeTracerSource, run } from "./functrace-probe-helpers.ts";

const orderfile = join(import.meta.dir, "../../../../scripts/orderfile");
const compiler = process.env.CC || Bun.which("cc") || Bun.which("clang") || Bun.which("gcc");
const canProbe = isLinux && !isMusl && !!compiler;
const STARTS_MAGIC = 0x4e55425354525453n;

async function compile(args: string[]) {
  await using proc = Bun.spawn({ cmd: [compiler!, "-O1", ...args], env: bunEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`${compiler} ${args.join(" ")} exited ${exitCode}:\n${stdout}${stderr}`);
}

async function writeStarts(path: string, addresses: Iterable<number>) {
  const list = [...addresses].map(BigInt);
  const words = new BigUint64Array(3 + list.length);
  words.set([STARTS_MAGIC, 1n, BigInt(list.length)], 0);
  words.set(list, 3);
  await Bun.write(path, new Uint8Array(words.buffer));
}

describe.skipIf(!canProbe)("function tracer hang probe", () => {
  let root: string;
  let tracer: string, fixture: string, child: string, starts: string;
  let dirHandle: ReturnType<typeof tempDir>;

  test("environment", async () => {
    dirHandle = tempDir("functrace-probe", {
      "child.c": "int main(void) { return 0; }\n",
      "functrace-probe.c": probeTracerSource(readFileSync(join(orderfile, "functrace.c"), "utf8")),
      "ctr.c": [
        "#include <stdio.h>",
        "#include <unistd.h>",
        "int main(void) {",
        "#if defined(__aarch64__)",
        '  unsigned long ctr, dczid; __asm__ volatile("mrs %0, ctr_el0" : "=r"(ctr)); __asm__ volatile("mrs %0, dczid_el0" : "=r"(dczid));',
        '  printf("CTR_EL0=%#lx IminLine=%u DminLine=%u IDC=%lu DIC=%lu DCZID_EL0=%#lx\\n", ctr, 4u << (ctr & 15), 4u << ((ctr >> 16) & 15), (ctr >> 28) & 1, (ctr >> 29) & 1, dczid);',
        "#endif",
        '  printf("pagesize=%ld nproc_onln=%ld\\n", sysconf(_SC_PAGESIZE), sysconf(_SC_NPROCESSORS_ONLN));',
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    });
    root = String(dirHandle);
    tracer = join(root, "functrace.so");
    fixture = join(root, "fixture");
    child = join(root, "child");
    starts = join(root, "starts.bin");
    const t0 = performance.now();
    await Promise.all([
      compile(["-shared", "-fPIC", "-o", tracer, join(root, "functrace-probe.c"), "-ldl", "-lpthread"]),
      compile(["-o", fixture, join(import.meta.dir, "functrace-fixture.c")]),
      compile(["-o", child, join(root, "child.c")]),
      compile(["-o", join(root, "ctr"), join(root, "ctr.c")]),
    ]);
    console.log(`compiles: ${(performance.now() - t0).toFixed(0)} ms with ${compiler}`);
    const symbols = readTextSymbols(fixture);
    await writeStarts(starts, symbols.keys());

    const facts = [
      ["uname", ["uname", "-a"]],
      [
        "cpu",
        [
          "sh",
          "-c",
          "grep -m1 -i 'model name\\|CPU part' /proc/cpuinfo; grep -c ^processor /proc/cpuinfo; cat /sys/devices/system/cpu/cpu0/regs/identification/midr_el1 2>/dev/null",
        ],
      ],
      ["ctr", [join(root, "ctr")]],
      [
        "limits",
        [
          "sh",
          "-c",
          "ulimit -c; ulimit -Hc; ulimit -s; cat /proc/sys/kernel/core_pattern; cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null; cat /sys/kernel/mm/transparent_hugepage/shmem_enabled 2>/dev/null; cat /proc/sys/vm/overcommit_memory",
        ],
      ],
      ["mem", ["sh", "-c", "free -m | head -3; cat /proc/pressure/cpu /proc/pressure/memory 2>/dev/null"]],
      [
        "cc",
        [
          "sh",
          "-c",
          `${compiler} --version | head -1; ld --version | head -1; (llvm-nm --version || nm --version) 2>/dev/null | head -2; ldd --version | head -1; gdb --version 2>/dev/null | head -1`,
        ],
      ],
      [
        "segments",
        [
          "sh",
          "-c",
          `readelf -lW ${fixture} | grep -A1 'LOAD\\|GNU_' ; readelf -SW ${fixture} | grep -E ' \\.(init|plt|text|fini|rodata|eh_frame|note[^ ]*) '`,
        ],
      ],
      ["symbols", ["sh", "-c", `(llvm-nm ${fixture} || nm ${fixture}) | grep -E '^[0-9a-f]+ [tT] '`]],
      [
        "disasm",
        [
          "sh",
          "-c",
          `objdump -d ${fixture} --start-address=0x$( (llvm-nm ${fixture} || nm ${fixture}) | awk '$3=="f0"{print $1}') --stop-address=0x$( (llvm-nm ${fixture} || nm ${fixture}) | awk '$3=="main"{print $1}') | head -120`,
        ],
      ],
      [
        "tracer syms",
        [
          "sh",
          "-c",
          `(llvm-nm ${tracer} || nm ${tracer}) | grep -E 'aarch64_|clear_cache|sync_cache|have_lse' | head -20`,
        ],
      ],
    ] as const;
    for (const [label, cmd] of facts) console.log(`--- ${label}\n${await run([...cmd])}`);
    expect(symbols.size).toBeGreaterThan(33);
  });

  type Outcome = { ok: boolean; hang: boolean; detail: string };

  /** One traced run, the way linker-order.test.ts spawns it, with a watchdog instead of the test timeout. */
  async function tracedRun(tag: string, hangAfterMs: number): Promise<Outcome> {
    const trace = join(root, `trace.${tag}.bin`);
    const diag = join(root, `diag.${tag}.txt`);
    const started = performance.now();
    await using proc = Bun.spawn({
      cmd: [fixture, child],
      env: {
        ...bunEnv,
        LD_PRELOAD: tracer,
        BUN_FUNCTRACE_STARTS: starts,
        BUN_FUNCTRACE_OUT: trace,
        BUN_FUNCTRACE_DIAG: diag,
        BUN_FUNCTRACE_DIAG_ALARM: String(Math.max(1, Math.floor(hangAfterMs / 1000) - 4)),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const settled = { stdout: false, stderr: false, exited: false };
    const all = Promise.all([
      proc.stdout.text().finally(() => (settled.stdout = true)),
      proc.stderr.text().finally(() => (settled.stderr = true)),
      proc.exited.finally(() => (settled.exited = true)),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      all,
      new Promise<"hang">(resolve => (timer = setTimeout(() => resolve("hang"), hangAfterMs))),
    ]);
    clearTimeout(timer);
    if (first !== "hang") {
      const [stdout, stderr, exitCode] = first;
      const ok = stdout.trim() === "497" && stderr === "" && exitCode === 0;
      return {
        ok,
        hang: false,
        detail: ok
          ? ""
          : `run ${tag}: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} exit=${exitCode} signal=${proc.signalCode} in ${(performance.now() - started).toFixed(0)} ms`,
      };
    }

    // Hung: say where, then take the tree down and see whether the promises notice.
    const lines = [
      `=== run ${tag} HUNG after ${hangAfterMs} ms: pid=${proc.pid} settled=${JSON.stringify(settled)} exitCode=${proc.exitCode} signal=${proc.signalCode} killed=${proc.killed}`,
    ];
    lines.push(describeSelf());
    lines.push(describeTree(proc.pid));
    lines.push(
      `--- ps\n${await run(["sh", "-c", `ps -eo pid,ppid,pgid,stat,wchan:32,etime,time,args --forest | grep -v ' ps -eo' | grep -C2 -E 'fixture|functrace|${process.pid}' | head -60`])}`,
    );
    const tree = [proc.pid, ...childrenOf(proc.pid)];
    try {
      process.kill(proc.pid, "SIGUSR1");
    } catch (error) {
      lines.push(`SIGUSR1: ${error}`);
    }
    await Bun.sleep(500);
    lines.push(`--- tracer diag file\n${existsSync(diag) ? readFileSync(diag, "utf8") : "<none>"}`);
    lines.push(`--- trace file: ${existsSync(trace) ? readFileSync(trace).byteLength + " bytes" : "<none>"}`);
    for (const pid of tree.reverse()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    const afterKill = await Promise.race([all.then(() => "settled"), Bun.sleep(5000).then(() => "still pending")]);
    lines.push(
      `--- after SIGKILL of ${JSON.stringify(tree)}: ${afterKill} settled=${JSON.stringify(settled)} exitCode=${proc.exitCode} signal=${proc.signalCode}`,
    );
    const detail = lines.join("\n");
    console.error(detail);
    return { ok: false, hang: true, detail };
  }

  async function phase(label: string, iterations: number, concurrency: number, hangAfterMs: number) {
    let hangs = 0,
      fails = 0,
      runs = 0;
    const failures: string[] = [];
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async (_, worker) => {
        for (let i = 0; i < iterations && hangs < 3; i++) {
          const outcome = await tracedRun(`${label}.${worker}.${i}`, hangAfterMs);
          runs++;
          if (outcome.hang) hangs++;
          else if (!outcome.ok) {
            fails++;
            if (failures.length < 10) failures.push(outcome.detail);
          }
        }
      }),
    );
    console.log(
      `phase ${label}: ${runs} runs, ${hangs} hung, ${fails} failed, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    for (const f of failures) console.log(f);
    return { hangs, fails };
  }

  test("traced fixture, idle machine", async () => {
    const { hangs, fails } = await phase("idle", 150, 4, 30_000);
    expect({ hangs, fails }).toEqual({ hangs: 0, fails: 0 });
  }, 300_000);

  test("traced fixture, under cpu and spawn load", async () => {
    const hogs = Array.from({ length: availableParallelism() }, () =>
      Bun.spawn({
        cmd: [bunExe(), "-e", "for (let i = 0; ; i++) if (i % 1e7 === 0) Bun.spawnSync({ cmd: ['true'] });"],
        env: bunEnv,
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    try {
      const { hangs, fails } = await phase("load", 300, 6, 30_000);
      expect({ hangs, fails }).toEqual({ hangs: 0, fails: 0 });
    } finally {
      for (const hog of hogs) hog.kill("SIGKILL");
      await Promise.all(hogs.map(hog => hog.exited));
    }
  }, 600_000);

  // The real file, the way the CI batch runs it: a --parallel worker, next to
  // files that spawn and serve. linker-order.test.ts carries its own watchdog
  // output for the tracer test (see functrace-probe-helpers.ts).
  test("linker-order.test.ts inside a --parallel batch", async () => {
    const neighbors = [
      "test/js/bun/perf/linker-order.test.ts",
      "test/js/bun/util/filesink.test.ts",
      "test/internal/fifo.test.ts",
      "test/js/bun/spawn/spawn.ipc.test.ts",
      "test/cli/run/self-reference.test.ts",
      "test/js/bun/shell/pipeline_stack.test.ts",
      "test/js/bun/http/bun-serve-html.test.ts",
      "test/js/bun/test/bun_test.test.ts",
      "test/js/web/websocket/websocket-pause.test.ts",
      "test/regression/issue/09555.test.ts",
      "test/cli/heap-prof.test.ts",
      "test/bundler/bundler_loader.test.ts",
    ];
    const repo = join(import.meta.dir, "../../../..");
    let timedOut = 0;
    const t0 = performance.now();
    for (let i = 0; i < 12 && timedOut < 2; i++) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "--parallel=3", "--timeout=70000", "--dots", ...neighbors],
        cwd: repo,
        env: { ...bunEnv, BUN_FUNCTRACE_PROBE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const out = stdout + stderr;
      const summary = /Ran \d+ tests across \d+ files\. \[[^\]]+\]/.exec(out)?.[0] ?? `exit ${proc.exitCode}`;
      const tracerLine = out.split("\n").find(line => line.includes("functrace steps:")) ?? "<no steps line>";
      console.log(`batch ${i}: ${summary} ${tracerLine.trim()}`);
      if (/timed out|HUNG|functrace watchdog/.test(out) && /linker-order|functrace/.test(out)) {
        timedOut++;
        console.error(
          `=== batch ${i} output (filtered)\n${out
            .split("\n")
            .filter(line => !/^\.+$/.test(line.trim()))
            .slice(-400)
            .join("\n")}`,
        );
      }
    }
    console.log(`batches: ${((performance.now() - t0) / 1000).toFixed(1)} s, ${timedOut} with a tracer timeout`);
    expect(timedOut).toBe(0);
  }, 1_500_000);

  test("cleanup", () => {
    dirHandle?.[Symbol.dispose]?.();
  });
});
