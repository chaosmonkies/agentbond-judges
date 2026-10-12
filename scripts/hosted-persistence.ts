import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { stableStringify,sha256 } from '../packages/shared/src/index.ts';
const canonicalHash=(value:unknown)=>sha256(stableStringify(value));

const local=process.argv.includes('--local'),origin=new URL(process.env.WEB_URL??'https://otcs.ai').origin;
if(!local)assert(origin.startsWith('https://'),'Remote restart proof requires HTTPS');
const workflow=JSON.parse(await readFile(process.env.AGENTBOND_WORKFLOW_EVIDENCE??(local?'artifacts/web/hosted-local/workflow-evidence.json':'artifacts/web/hosted-public/workflow-evidence.json'),'utf8'));
assert(workflow.status==='passed'&&workflow.url===origin&&workflow.job,'Verified browser workflow required before persistence test');
async function get(path:string){const r=await fetch(origin+path,{signal:AbortSignal.timeout(15000),redirect:'error'});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());}
const health=JSON.parse((await get('/api/health')).toString()),detail=JSON.parse((await get('/api/jobs/'+workflow.job)).toString());
assert(health.apiReady&&health.workersReady&&health.bootId,'Current API/agents must be ready');assert.equal(detail.job.status,'SETTLED');
const spec=detail.metadata.spec;assert.equal(spec.input.url,origin+'/api/inputs/'+spec.input.hash+'.csv');
const inputHash=sha256(await get('/api/inputs/'+spec.input.hash+'.csv')),artifactHash=sha256(await get('/api/jobs/'+workflow.job+'/artifacts?raw=artifact')),receiptHash=sha256(await get('/api/jobs/'+workflow.job+'/artifacts?raw=receipt'));
assert.equal(inputHash,spec.input.hash);assert.equal(artifactHash,detail.job.artifactHash);assert.equal(receiptHash,detail.job.verificationHash);
const metadataHash=canonicalHash(detail.metadata),fingerprint=canonicalHash({job:detail.job,metadataHash,inputHash,artifactHash,receiptHash});
const snapshot={at:new Date().toISOString(),url:origin,deployment:local?'local-production':'public',job:workflow.job,bootId:health.bootId,chainStatus:detail.job.status,inputHash,artifactHash,receiptHash,metadataHash,fingerprint};
const prefix=local?'hosted-persistence-local':'hosted-persistence';
if(process.argv.includes('--before')){await writeFile(`.orchestrator/reports/${prefix}-before.json`,JSON.stringify(snapshot,null,2));console.log(JSON.stringify(snapshot,null,2));}
else if(process.argv.includes('--after')){
 const before=JSON.parse(await readFile(`.orchestrator/reports/${prefix}-before.json`,'utf8'));assert.equal(before.url,origin);assert.equal(before.job,workflow.job);assert.notEqual(before.bootId,snapshot.bootId,'A real API restart must have occurred');assert.equal(before.fingerprint,snapshot.fingerprint,'Persisted content changed across restart');
 const proof={...snapshot,status:'passed',beforeBootId:before.bootId,afterBootId:snapshot.bootId,beforeFingerprint:before.fingerprint,afterFingerprint:snapshot.fingerprint,beforeAt:before.at};await writeFile(`.orchestrator/reports/${prefix}.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}else throw new Error('Select --before, restart the owned service, then select --after');
