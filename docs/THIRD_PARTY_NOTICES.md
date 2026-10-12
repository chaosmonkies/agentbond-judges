# Third-party notices and assistance disclosure

Inventory date: 2026-10-12. The versions and license expressions below come from this workspace's installed package metadata, the lockfiles and cached Cargo manifests. They describe dependency packages, not a license for AgentBond's own source.

## Repository license

No repository license has been selected. The root and web package manifests mark the project private; the program manifest has no `license` field. This document does not select or grant an MIT, Apache or other license for AgentBond code, artwork or submission materials. A maintainer must make that decision explicitly.

## Direct JavaScript runtime dependencies

These packages are declared in [the root manifest](../package.json) or [the web manifest](../apps/web/package.json). Metadata paths are relative to the repository root after installing dependencies.

| Package | Installed version | Declared license expression | Metadata source |
| --- | --- | --- | --- |
| `@coral-xyz/anchor` | 0.32.1 | `(MIT OR Apache-2.0)` | `node_modules/@coral-xyz/anchor/package.json` |
| `@solana/spl-token` | 0.4.14 | `Apache-2.0` | `node_modules/@solana/spl-token/package.json` |
| `@solana/web3.js` | 1.98.4 | `MIT` | `node_modules/@solana/web3.js/package.json` |
| `bn.js` | 5.2.5 | `MIT` | `node_modules/bn.js/package.json` |
| `bs58` | 6.0.0 | `MIT` | `node_modules/bs58/package.json` |
| `tweetnacl` | 1.0.3 | `Unlicense` | `node_modules/tweetnacl/package.json` |
| `undici` | 8.11.2 | `MIT` | `node_modules/undici/package.json` |
| `zod` | 3.25.76 | `MIT` | `node_modules/zod/package.json` |
| `next` | 16.4.0 | `MIT` | `node_modules/next/package.json` |
| `react` | 19.3.0 | `MIT` | `node_modules/react/package.json` |
| `react-dom` | 19.3.0 | `MIT` | `node_modules/react-dom/package.json` |

The Anchor JavaScript metadata declares a choice of licenses; this inventory does not choose a branch of that expression. No top-level license or notice text was present in the installed `@coral-xyz/anchor` package during this inspection. Its source repository is [coral-xyz/anchor](https://github.com/coral-xyz/anchor).

## Direct build, typing and test dependencies

| Package | Installed version | Declared license expression | Metadata source |
| --- | --- | --- | --- |
| `@playwright/test` | 1.64.0 | `Apache-2.0` | `node_modules/@playwright/test/package.json` |
| `@types/bn.js` | 5.2.0 | `MIT` | `node_modules/@types/bn.js/package.json` |
| `@types/node` | 22.18.10 | `MIT` | `node_modules/@types/node/package.json` |
| `@types/react` | 19.2.14 | `MIT` | `node_modules/@types/react/package.json` |
| `@types/react-dom` | 19.2.3 | `MIT` | `node_modules/@types/react-dom/package.json` |
| `tsx` | 4.20.6 | `MIT` | `node_modules/tsx/package.json` |
| `typescript` | 5.9.3 | `Apache-2.0` | `node_modules/typescript/package.json` |
| `vite` | 8.1.5 | `MIT` | `node_modules/vite/package.json` |
| `vitest` | 5.0.3 | `MIT` | `node_modules/vitest/package.json` |
| `tailwindcss` | 4.3.3 | `MIT` | `node_modules/tailwindcss/package.json` |
| `@tailwindcss/postcss` | 4.3.3 | `MIT` | `node_modules/@tailwindcss/postcss/package.json` |
| `postcss` | 8.5.29 | `MIT` | `node_modules/postcss/package.json` |

The web manifest declares PostCSS 8.5.6, while the root override and installed package resolve to 8.5.29. The table intentionally records the installed version.

Package license texts remain alongside installed metadata: usually `LICENSE`, with `next/license.md`, `vite/LICENSE.md`, `vitest/LICENSE.md`, and `typescript/LICENSE.txt`. Playwright includes both `LICENSE` and `NOTICE`; TypeScript also includes `ThirdPartyNoticeText.txt`. Those original texts carry the dependency authors' notices. This file does not replace them or claim that every transitive dependency has been inventoried.

## Rust program dependencies

[The program manifest](../programs/agentbond/Cargo.toml) directly pins `anchor-lang = 0.32.1` and `anchor-spl = 0.32.1`. Versions below were matched against [Cargo.lock](../Cargo.lock), then read from the corresponding installed Cargo registry `Cargo.toml` files.

| Crate | Locked version | Declared license expression | Role |
| --- | --- | --- | --- |
| `anchor-lang` | 0.32.1 | `Apache-2.0` | Direct program dependency |
| `anchor-spl` | 0.32.1 | `Apache-2.0` | Direct program dependency |
| `solana-program-entrypoint` | 2.3.0 | `Apache-2.0` | Locked Solana component |
| `solana-program-error` | 2.2.2 | `Apache-2.0` | Locked Solana component |
| `solana-program-option` | 2.2.1 | `Apache-2.0` | Locked Solana component |
| `solana-program-pack` | 2.2.1 | `Apache-2.0` | Locked Solana component |
| `solana-sdk-ids` | 2.2.1 | `Apache-2.0` | Locked Solana component |
| `spl-token` | 8.0.0 | `Apache-2.0` | Locked SPL dependency |
| `spl-token-2022` | 8.0.1 | `Apache-2.0` | Locked SPL dependency |

The local manifest evidence follows `~/.cargo/registry/src/<registry>/<crate>-<version>/Cargo.toml`. The lockfile uses modular Solana crates; no monolithic `solana-program` crate appears in this lockfile. This inventory records dependency presence and does not expand the escrow program's supported token policy.

## AI assistance

AgentBond's implementation, UI, tests, documentation and submission drafts were developed with OpenAI Codex assistance, including parallel agents assigned protocol, runtime, frontend and release work. This is AI-assisted implementation; it should not be described as exclusively human-authored or as a professional security audit. Test, deployment and payment claims require their actual recorded execution evidence.

The AgentBond monogram is a code-native SVG created during this work, rather than a downloaded third-party logo. No project-wide license for that asset is selected by this document.

## Included recording

The judge demo is a silent, actual public devnet workflow recording. The test driver signs through a Node wallet bridge; it does not show or test wallet extension approval screens. No synthetic narration or cloned voice is included. See [recording evidence](../evidence/video.json).
