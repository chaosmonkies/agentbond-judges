# Running the stack

The live product is **https://otcs.ai** on Solana devnet. Judges can use it immediately without deploying infrastructure or receiving operator keys.

## Local demonstration

Install Node 24+, Anchor 0.32.1, Rust and Solana CLI. Install locked dependencies using the README command. Set `AGENTBOND_KEY_DIR` to a dedicated directory outside this checkout, such as `$HOME/.agentbond-judges/keys`, then run `npm run dev`.

The launcher starts its own validator only when the local RPC is unavailable, loads the built program, generates restricted external test keys, creates real local demonstration jobs and launches API/frontend services. It refuses a running validator that lacks the expected program. This demonstration creates local test-chain effects. Run the isolated custody regression with `npm run test:critical`.

## Autonomous hosted mode

The backend image runs `scripts/hosted.ts`, which supervises the persistent API and continuous worker/verifier roles. The separate frontend image serves the wallet UI and proxies `/api` to the backend. `compose.infra.yml` illustrates the deployed two-container layout with a private backend network, a persistent data volume, read-only credential mounts, nonroot processes, dropped capabilities and resource limits. It expects an existing Docker Caddy proxy network.

The supplied devnet profile identifies the existing public program, mint and verifier. Hosting a writable instance for those identities requires authorized external role keys; this repository contains none. An independent operator must configure its own program/mint/verifier identities and their matching network profiles, role credentials, domain, persistent volume and container names. Do not point a test deployment at another operator's live volume or credential directory.

For your own instance, provide `AGENTBOND_DOMAIN` and `AGENTBOND_CREDENTIAL_DIR`, and select the profile using `AGENTBOND_PROFILE_FILE`. Both are required explicitly by the compose template. Make credential files readable only by the container's UID 1000, mount them read-only, and pre-own persistent storage for that UID. The deployer/upgrade credential is never mounted in hosted roles. The optional devnet faucet needs separate test-SOL and demo-mint-authority credentials and enforces durable grant quotas.

The packaged `apps/web/data/public.json` preserves historical terminal-job evidence for bootstrap; its older loopback input URLs are original committed history. Hosted mode checks those terminal accounts and commitments before importing them. Current public uploaded inputs use immutable HTTPS hash URLs and are recorded in `evidence/devnet.json`.

## Mainnet configuration

`config/mainnet.env.example` and `compose.mainnet.yml` prepare a separate network profile, containers and data volume. **Mainnet is disabled by default.** A future operator must deliberately provide a separately deployed program, a supported standard SPL mint without freeze authority, its verifier and signing keys, a mainnet RPC, its own domain, and the explicit enable flag. The profile validates the RPC genesis and rejects devnet identity reuse. No demo faucet or historical devnet bootstrap belongs in that deployment.

The existing deployment's verified scope is devnet. Mainnet configuration checks are preparation, not evidence of a deployed or reviewed mainnet product.
