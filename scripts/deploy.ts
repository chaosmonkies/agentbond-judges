import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { loadExternalKeypair } from '../packages/agent-runtime/src/index.ts';
import { PROGRAM_ID } from '../packages/sdk/src/index.ts';
import { ensureKeys } from './keys.ts';
import { run } from './process.ts';
import { sha256 } from '../packages/shared/src/index.ts';

const DEVNET_RPC = 'https://api.devnet.solana.com';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export interface DeploymentInspection {
  programId: string; programData: string; programOwner: string; programDataOwner: string;
  deployedSlot: string; upgradeAuthority: string; binaryBytes: number; allocatedBinaryBytes: number;
  binaryHash: string; deployedBinaryHash: string; trailingBytesZero: boolean; binaryMatches: boolean;
}
export function decodeProgramAddress(account: AccountInfo<Buffer>): PublicKey {
  if (!account.executable || !account.owner.equals(UPGRADEABLE_LOADER)) throw new Error('Program is not an executable upgradeable-loader account');
  if (account.data.length !== 36 || account.data.readUInt32LE(0) !== 2) throw new Error('Invalid upgradeable Program account layout');
  return new PublicKey(account.data.subarray(4, 36));
}
export function decodeProgramData(account: AccountInfo<Buffer>, expectedAuthority: PublicKey) {
  if (account.executable || !account.owner.equals(UPGRADEABLE_LOADER)) throw new Error('ProgramData has an invalid owner or executable flag');
  if (account.data.length < 45 || account.data.readUInt32LE(0) !== 3) throw new Error('Invalid upgradeable ProgramData account layout');
  if (account.data[12] !== 1) throw new Error('Expected an explicitly configured upgrade authority');
  const authority = new PublicKey(account.data.subarray(13, 45));
  if (!authority.equals(expectedAuthority)) throw new Error('RPC upgrade authority does not match the external deployer');
  return { authority, deployedSlot: account.data.readBigUInt64LE(4).toString(), bytes: account.data.subarray(45) };
}
/** Read-only reconciliation; never signs or sends a transaction. */
export async function inspectDeployment(connection: Connection, programId: PublicKey, binary: Buffer, expectedAuthority: PublicKey): Promise<DeploymentInspection | null> {
  const program = await connection.getAccountInfo(programId);
  if (!program) return null;
  const dataAddress = decodeProgramAddress(program), data = await connection.getAccountInfo(dataAddress);
  if (!data) throw new Error('ProgramData account is missing');
  const decoded = decodeProgramData(data, expectedAuthority);
  const deployedBytes = decoded.bytes.subarray(0, binary.length);
  const trailingBytesZero = decoded.bytes.subarray(binary.length).every(value => value === 0);
  const binaryHash = sha256(binary), deployedBinaryHash = sha256(deployedBytes);
  return {
    programId: programId.toBase58(), programData: dataAddress.toBase58(), programOwner: program.owner.toBase58(),
    programDataOwner: data.owner.toBase58(), deployedSlot: decoded.deployedSlot, upgradeAuthority: decoded.authority.toBase58(),
    binaryBytes: binary.length, allocatedBinaryBytes: decoded.bytes.length, binaryHash, deployedBinaryHash,
    trailingBytesZero, binaryMatches: decoded.bytes.length >= binary.length && trailingBytesZero && binaryHash === deployedBinaryHash,
  };
}
export async function deployMain() {
  const verifyOnly = process.argv.includes('--verify-only');
  const rpcIndex = process.argv.indexOf('--rpc-url');
  const rpcUrl = rpcIndex < 0 ? DEVNET_RPC : process.argv[rpcIndex + 1];
  if (!rpcUrl) throw new Error('--rpc-url needs an endpoint');
  // The local endpoint override is exclusively for read-only decoder validation.
  if (!verifyOnly && rpcUrl !== DEVNET_RPC) throw new Error('Signed deployment is restricted to the configured devnet RPC');
  const url = new URL(rpcUrl);
  if (rpcUrl !== DEVNET_RPC && (!verifyOnly || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Verification RPC must be devnet or a local validator');
  const connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) });
  if (rpcUrl === DEVNET_RPC && await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Expected devnet');
  if (verifyOnly) {
    const authorityIndex = process.argv.indexOf('--authority');
    const authorityAddress = authorityIndex < 0 ? process.env.AGENTBOND_UPGRADE_AUTHORITY ?? '6aaxsWgNfc1b6aiPiMfa5PiPq96721DSXYcBerz8dVVD' : process.argv[authorityIndex + 1];
    if (!authorityAddress) throw new Error('--authority needs a public address');
    // Read-only verification has no access to signing keys and does not rebuild.
    const binary = await readFile('target/deploy/agentbond.so');
    const existing = await inspectDeployment(connection, PROGRAM_ID, binary, new PublicKey(authorityAddress));
    if (!existing) throw new Error('Program has not been deployed');
    if (!existing.binaryMatches) throw new Error('Deployed bytecode differs from the tested binary');
    console.log(JSON.stringify({ network: rpcUrl === DEVNET_RPC ? 'devnet' : 'localnet', verified: true, ...existing }, null, 2));
    return existing;
  }
  const dir = await ensureKeys(), deployerFile = join(dir, 'deployer.json'), programFile = join(dir, 'agentbond-program.json');
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(deployerFile, 'utf8'))));
  const program = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(programFile, 'utf8'))));
  if (!program.publicKey.equals(PROGRAM_ID)) throw new Error('External deployment key does not match pinned program ID');
  await run('anchor', ['build']);
  const binary = await readFile('target/deploy/agentbond.so');
  const existing = await inspectDeployment(connection, PROGRAM_ID, binary, deployer.publicKey);
  const reconciledExisting = !!existing?.binaryMatches;
  if (!reconciledExisting) {
    // Persist the buffer signer before upload. Retries reuse its allocation and
    // never make the CLI generate or print a recovery phrase.
    const bufferFile = join(dir, 'deploy-buffer.json');
    let buffer: Keypair;
    try { buffer = await loadExternalKeypair(bufferFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      buffer = Keypair.generate();
      await writeFile(bufferFile, JSON.stringify(Array.from(buffer.secretKey)), { mode: 0o600, flag: 'wx' });
    }
    const bufferAccount = await connection.getAccountInfo(buffer.publicKey);
    if (bufferAccount && (!bufferAccount.owner.equals(UPGRADEABLE_LOADER) || bufferAccount.executable || bufferAccount.data.length !== binary.length + 37 || bufferAccount.data.readUInt32LE(0) !== 1 || bufferAccount.data[4] !== 1 || !new PublicKey(bufferAccount.data.subarray(5,37)).equals(deployer.publicKey))) throw new Error('Existing deployment buffer layout or authority differs; refusing upload');
    const programRent = await connection.getMinimumBalanceForRentExemption(binary.length + 45);
    const bufferRent = bufferAccount ? 0 : await connection.getMinimumBalanceForRentExemption(binary.length + 37);
    if (await connection.getBalance(deployer.publicKey) < programRent + bufferRent + 150_000_000) throw new Error('Insufficient test SOL for remaining program and buffer rent; no deployment attempted');
    const transport = process.argv.includes('--use-rpc') ? '--use-rpc' : '--use-tpu-client';
    await writeFile('.orchestrator/devnet-upload.json', JSON.stringify({ time: new Date().toISOString(), network: 'devnet', buffer: buffer.publicKey.toBase58(), reusedBuffer: !!bufferAccount, programRent, bufferRent, transport, binaryHash: sha256(binary), state: 'UPLOAD_PENDING' }, null, 2));
    try {
      await run('solana', ['program', 'deploy', 'target/deploy/agentbond.so', '--url', DEVNET_RPC, '--keypair', deployerFile, '--upgrade-authority', deployerFile, '--program-id', programFile, '--buffer', bufferFile, transport, '--max-sign-attempts', '5']);
    } catch (error) {
      // A CLI failure may follow a successful final transaction.
      const afterFailure = await inspectDeployment(connection, PROGRAM_ID, binary, deployer.publicKey);
      if (!afterFailure?.binaryMatches) throw error;
    }
  }
  const verified = await inspectDeployment(connection, PROGRAM_ID, binary, deployer.publicKey);
  if (!verified?.binaryMatches) throw new Error('Program deployment did not verify against the tested binary');
  await writeFile('.orchestrator/devnet-program.json', JSON.stringify({ time: new Date().toISOString(), network: 'devnet', ...verified, reconciledExisting, verified: true }, null, 2));
  console.log(reconciledExisting ? 'Existing devnet bytecode and actual upgrade authority reconciled; no deployment transaction sent' : 'Devnet executable, actual upgrade authority and exact bytecode independently verified');
  return verified;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await deployMain();
