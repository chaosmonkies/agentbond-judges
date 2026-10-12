import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { sha256, jobSpecSchema } from '../packages/shared/src/index.ts';
import { verifyArtifact } from '../apps/verifier/src/verify.ts';
import { verifyHostedWorkflow } from './verify-hosted.ts';

const bundle=JSON.parse(await readFile('evidence/devnet.json','utf8'));
const content=bundle.settledContent;
for (const [file,key,expected] of [
  ['input.csv','input',bundle.settlement.inputHash],
  ['artifact.json','artifact',bundle.settlement.artifactHash],
  ['receipt.json','receipt',bundle.settlement.receiptHash],
] as const) {
  const bytes=await readFile('evidence/'+file);
  assert.equal(bytes.toString('utf8'),content[key],`Exact ${key} bytes differ`);
  assert.equal(sha256(bytes),expected,`${key} commitment differs`);
}
assert.equal(verifyArtifact(await readFile('evidence/input.csv'),await readFile('evidence/artifact.json'),bundle.settlement.artifactHash,jobSpecSchema.parse(content.metadata.spec),bundle.settlement.job).approved,true);
for (const [file,expected] of [['demo.mp4',bundle.video.mp4Sha256],['workflow-ui.webm',bundle.video.sourceSha256]]) assert.equal(sha256(await readFile('evidence/'+file)),expected,`${file} hash differs`);
const manifest=JSON.parse(await readFile('evidence/source-manifest.json','utf8'));
for (const [name,expected] of Object.entries(manifest.unchangedFilesGitBlobHashes)) {
  const path=resolve(name);assert(path.startsWith(resolve('.')+sep),'Manifest path outside snapshot');
  const bytes=await readFile(path);
  const hash=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(hash,expected,`Snapshot file changed: ${name}`);
}
const offline=process.argv.includes('--offline');
const report={verifiedAt:new Date().toISOString(),scope:offline?'portable evidence and source integrity':'portable evidence and live hosted devnet settlement',sourceCommit:manifest.sourceCommit,status:'passed',signedTransactions:false,live:offline?undefined:await verifyHostedWorkflow({url:bundle.url,workflowFile:'evidence/browser-workflow.json'})};
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/judge-verification.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
