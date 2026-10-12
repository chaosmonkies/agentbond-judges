# Snapshot provenance

This judge-facing repository was prepared on **2026-10-12** from existing AgentBond source commit **f699a6eff7ee4523d7e2cf308d4d5a2a3bbafdfa**. The original development repository and its history are retained separately. Its earliest recorded commit is `3089171`, dated **2026-10-12T03:05:54Z**. These are recorded Git timestamps, not a claim that all development began at that time.

The live deployment was built from commit **9c395661401c0165a2800d381415b7cfbadb6c54**. The later snapshot source commit adds the recorded release evidence and documentation. Product implementation files were copied without rewriting the protocol or hosted application. [The source manifest](evidence/source-manifest.json) records Git blob hashes for unchanged files.

Export changes remove private operator records and historical deployment clutter; provide focused reviewer documentation and public evidence; make local validator fixture key generation portable; replace a machine-specific Anchor wallet path; require explicit operator domain/credential configuration in the infrastructure template; and add snapshot verification and CI. No signing credential is included.

A single initial commit in this repository represents the review snapshot. It does not replace the original history, establish contest eligibility, or establish a new development start date.

Implementation, UI, tests, documentation and release work used **OpenAI Codex assistance**, including parallel protocol, runtime and frontend agents. This is AI-assisted development and a development security review, not an independent professional audit. Dependency notices are in [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

The included 72.52-second demo is actual public devnet browser footage. A Node test driver signs real wallet actions without sending secret bytes to the browser. It does not depict or test extension wallet approval screens. It contains no narration. All displayed token values are custom test tokens.
