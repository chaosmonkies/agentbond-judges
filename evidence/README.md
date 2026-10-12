# Review evidence

`devnet.json` is a portable public evidence bundle prepared on 2026-10-12. It includes the actual successful hosted workflow, separate failed-job refund, faucet grant and retry recovery, persistence across a real backend restart, browser observations and exact committed CSV/artifact/receipt strings. Private infrastructure inventories and operator credentials are excluded; public commitments remain intact.

- `input.csv`, `artifact.json` and `receipt.json` preserve the exact successful job bytes. Reformatting them changes their hashes.
- `demo.mp4` is the 72.52-second silent H264 recording; `workflow-ui.webm` is its original browser recording. `video.json` records both hashes and the Node test signing bridge disclosure.
- `settled.png`, `refund.png` and `create-mobile.png` show actual public app views.
- `browser-workflow.json` supplies the recorded workflow identities for fresh live verification.
- `release-gates.json` summarizes the 15 product gates recorded at release. These are historical recorded results, not assertions that every gate reran during the export. No contest portal acceptance is recorded.
- `source-manifest.json` identifies the original source commit and unchanged files' Git blob hashes.
- `snapshot-checks.json` records validation run in the clean judge checkout.

The release recorded 191 unit tests and two hosted browser tests. Local validator custody tests separately exercised real protocol actions and authorization failures. Dependency review recorded 12 advisories (5 high, 7 moderate, 0 critical); no clean audit or professional audit is claimed.

Run `npm run verify:devnet -- --offline` to check exact hashes, recompute the successful artifact and check snapshot file integrity. Run `npm run verify:devnet` to additionally query the public app and devnet, decode real lifecycle transactions, check mint properties and verify exact settlement token deltas. Neither command signs transactions or transfers funds. RPC/network failure or missing historical transaction data is reported as failure.

The refund and faucet evidence includes real finalized signatures and before/after deltas. Their recorded recovery and restart observations are historical tests; checking current chain state alone cannot recreate a restart or prove a past duplicate rejection.
