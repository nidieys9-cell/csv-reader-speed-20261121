# csv-reader-speed-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/nidieys9-cell/csv-reader-speed-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/nidieys9-cell/csv-reader-speed-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in replacement for csv-reader 1.0.0 that answers exactly as the reference on every case. It parses each case in a single pass, jumping with `indexOf` to field and line boundaries instead of walking character by character, with a `split`-based fast path for quote-free records and slice-based quoted-field reads; broken rows (stray CRs, unterminated quotes, junk after closing quotes, short/long rows) are reported in the reference's exact error order.

## Run it

```sh
node main.ts
```

Reads cases from `/input/cases.json` (`$MAKEFUN_INPUT_DIR` outside a container) and writes `/output/answers.json` (`$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=zm33jpqc&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
