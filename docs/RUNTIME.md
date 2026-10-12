# Runtime and verification

The product supports one task type, `csv-analysis`. A job commits canonical specification and acceptance hashes onchain, while its immutable input, artifact and verification receipt remain offchain with SHA256 commitments. Amounts use integer token base units.

The hosted API verifies wallet challenges scoped to domain, action, exact body hash, random nonce and a 60-second lifetime. It consumes valid nonces before asynchronous writes, checks the chain creator for job metadata, and atomically checks agent-profile ownership. Metadata cannot authorize an escrow transfer. SQLite uses WAL/full synchronous commits; a single active API lease protects journal ownership.

CSV inputs are at most 1 MiB, 10,000 rows and 64 columns. Uploaded CSVs are immutable hash-named files; hosted processing resolves exact owned URLs directly to checked files. The fixed worker executor has a two-second wall timeout, a 64 MiB V8 heap setting and Node permission restrictions. It evaluates no job-provided code. This permission mode is not OS network isolation.

The verifier uses its own parser and calculation to check the original input and exact artifact bytes. A receipt binds its decision to job, input and artifact commitments. Only the designated verifier wallet can approve or reject. Both parent roles share a trusted Unix UID and host; separate signers do not create OS isolation.

The supervisor continuously runs worker and verifier roles with bounded backoff and health heartbeats. Worker processing claims eligible jobs, executes the fixed task and submits a hash. Verification approves or rejects, and verified jobs settle to the assigned worker's token account. Retry reconciliation uses chain state and durable journals; ambiguous responses recover or rebroadcast the same signed transaction instead of creating duplicate financial effects.

The devnet faucet is a distinct bounded signing service. Each grant combines test SOL and custom tokens in one atomic transaction, reserves quota in SQLite, and installs a durable journal before broadcast. A wallet receives at most one grant; the instance lifetime maximum is 50 wallets. It checks reserves and rejects mainnet configuration.

The API exposes `/health`, `/config`, `/jobs`, `/jobs/:address`, `/jobs/:address/events`, `/jobs/:address/artifacts`, `/agents` and `/stats`, with signed writes for metadata, profiles, inputs and faucet requests. Public access routes through the frontend's `/api` proxy. Reads expose chain state and errors; confirmed instruction decoding binds lifecycle actions to the IDL's named job account.

Read [the integration contract](INTERFACES.md), [security model](../SECURITY.md), and [public evidence](../evidence/README.md). Run `npm test`, `npm run typecheck`, and `npm run test:critical` for separate unit/type/real-validator checks. `npm run verify:devnet` independently checks the existing live settled workflow without signing transactions.
