# Counter budgets

One `<bench id>.json` per layer C scenario: the exact work counts (text
rasters, texture uploads, React commits, …) the scenario does. The unit tests
of `packages/perf` check them against the registered benches in `just check`;
`just perf-counters` compares them with this machine's latest measured counts.

After an intended change, `just perf-accept <id>` rewrites the file and the
diff in the commit is the review (`text.rasters: 0 → 120 (+120)`). Never edit
a budget by hand. Design: `docs/plans/perf-harness.md`.
