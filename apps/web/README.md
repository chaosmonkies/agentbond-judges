# AgentBond browser

Next.js wallet interface for browsing real jobs, inspecting committed evidence, uploading bounded CSVs, creating/funding escrow, and recovering applicable refunds. The frontend routes hosted traffic through its same-origin `/api` proxy and checks the configured network before signing.

Run `npm run web` from the repository root for development or `npm run build --workspace=apps/web` for a production build. Local demo setup and hosted configuration are in [DEPLOYMENT.md](../../DEPLOYMENT.md). The live devnet application is **https://otcs.ai**.
