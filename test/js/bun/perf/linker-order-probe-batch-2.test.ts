// Temporary probe, part 2 of 7: more rounds of the parallel batch in which
// linker-order.test.ts's tracer case hung on linux-aarch64 CI (see
// linker-order-probe.test.ts). Each file has its own per-file budget in the
// runner, so the rounds are split across files.
import { expect, test } from "bun:test";
import { isLinux, isMusl } from "harness";
import { runHungBatchRounds } from "./functrace-probe-helpers.ts";

test.skipIf(!isLinux || isMusl || process.arch !== "arm64")(
  "linker-order.test.ts inside the parallel batch that hung, part 2",
  async () => {
    const { rounds, bad } = await runHungBatchRounds("part2", 150_000);
    for (const out of bad) console.error(`=== stalled batch output (filtered)\n${out}`);
    console.log(`part 2: ${rounds} rounds, ${bad.length} with a tracer stall`);
    expect(bad.length).toBe(0);
  },
  170_000,
);
