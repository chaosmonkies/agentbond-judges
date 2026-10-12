import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { PROGRAM_ID } from '../packages/sdk/src/index.ts';
import { loggedProcess, rpcReady, run, waitFor } from './process.ts';

await run('anchor', ['build']);
await mkdir('.orchestrator/logs', { recursive: true });
const rpc = 'http://127.0.0.1:18999';
if (await rpcReady(rpc)) throw new Error('Port 18999 is already occupied; will not reset an unknown validator.');
const ledger = await mkdtemp(join(tmpdir(), 'agentbond-critical-'));
// RPC websocket uses RPC+1 (19000), distinct from gossip/IP-echo and dynamic ports.
const child = loggedProcess('critical-validator', 'solana-test-validator', ['--ledger', ledger, '--rpc-port', '18999', '--faucet-port', '19900', '--gossip-port', '19100', '--dynamic-port-range', '19101-19150', '--bpf-program', PROGRAM_ID.toBase58(), 'target/deploy/agentbond.so', '--quiet']);
const startedAt = new Date().toISOString();
let success = false;
try {
  await waitFor(() => rpcReady(rpc), 60000);
  const account = await new Connection(rpc).getAccountInfo(PROGRAM_ID);
  if (!account?.executable) throw new Error('Program was not loaded as executable');
  await run(process.execPath, ['--import', 'tsx', 'tests/chain/lifecycle.ts'], { ...process.env, RPC_URL: rpc, SOLANA_RPC_URL: rpc, ANCHOR_PROVIDER_URL: rpc });
  await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/runtime', 'tests/security']);
  success = true;
} finally {
  child.kill('SIGTERM');
  await writeFile('.orchestrator/critical-result.json', JSON.stringify({ startedAt, endedAt: new Date().toISOString(), success, rpcUrl: rpc, programId: PROGRAM_ID.toBase58(), ledger, validatorLog: '.orchestrator/logs/critical-validator.log' }, null, 2));
}
