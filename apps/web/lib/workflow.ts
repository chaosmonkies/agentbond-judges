import {api,ChainJob} from './types';
import {AuthAction,Challenge,InjectedWallet,validateChallenge} from './wallet';
export const stable=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(stable).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';
export const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const base64=(bytes:Uint8Array)=>btoa(Array.from(bytes,x=>String.fromCharCode(x)).join(''));
export async function authorizedRequest<T>(wallet:InjectedWallet,action:AuthAction,path:string,body:string,contentType='application/json'):Promise<T>{
 if(!wallet.publicKey||!wallet.signMessage)throw new Error('Connect a wallet with message signing support.');
 const address=wallet.publicKey.toBase58(),bodyHash=await hash(body);
 const challenge=await api<Challenge>('/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:address,action,bodyHash})});
 validateChallenge(challenge,{domain:window.location.host,wallet:address,bodyHash,action});
 const signed=await wallet.signMessage(new TextEncoder().encode(challenge.message));
 const authorization='AgentBond '+base64(new TextEncoder().encode(JSON.stringify({wallet:address,nonce:challenge.nonce,signature:base64(signed.signature)})));
 return api<T>(path,{method:'POST',headers:{'Content-Type':contentType,Authorization:authorization},body});
}
export function budgetUnits(decimal:string,decimals:number){if(!Number.isInteger(decimals)||decimals<0||decimals>18||!/^\d+(\.\d+)?$/.test(decimal))throw new Error('Enter a valid positive token budget.');const [whole,fraction='']=decimal.split('.');if(fraction.length>decimals)throw new Error(`Budget supports at most ${decimals} decimal places.`);const amount=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');if(amount<=0n||amount>18446744073709551615n)throw new Error('Budget is outside the supported token range.');return amount}
export function refundAvailable(job:ChainJob,now=Math.floor(Date.now()/1000)){return job.status==='REJECTED'||job.status==='FUNDED'&&now>=(job.claimDeadline??Infinity)||job.status==='CLAIMED'&&now>=(job.submitDeadline??Infinity)||job.status==='SUBMITTED'&&now>=(job.verifyDeadline??Infinity)}
export function csvPreview(csv:string){
 if(new TextEncoder().encode(csv).byteLength>1024*1024)throw new Error('Choose a UTF-8 CSV file no larger than 1 MiB.');
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 for(let i=0;i<csv.length;i++){const c=csv[i];if(quoted){if(c==='"'&&csv[i+1]==='"'){cell+='"';i++}else if(c==='"'){quoted=false;closed=true}else cell+=c}else if(c==='"'){if(cell||closed)throw new Error('Malformed CSV quote.');quoted=true}else if(c===','||c==='\n'||c==='\r'){row.push(cell);cell='';closed=false;if(c!==','){if(c==='\r'&&csv[i+1]==='\n')i++;rows.push(row);row=[]}}else{if(closed)throw new Error('Text after quoted CSV field.');cell+=c}if(rows.length>10001||row.length>64||cell.length>10000)throw new Error('CSV exceeds supported row, column or cell limits.');}
 if(quoted)throw new Error('Unclosed CSV quote.');if(cell||row.length||closed){row.push(cell);rows.push(row)}
 if(rows.length<2||rows.length>10001)throw new Error('CSV must contain 1–10,000 data rows.');const headers=rows.shift()!;
 if(headers.length>64||headers.some(h=>!h||h.length>100)||new Set(headers).size!==headers.length)throw new Error('CSV needs unique nonempty column headers (up to 64).');if(rows.some(r=>r.length!==headers.length))throw new Error('CSV rows have inconsistent column counts.');
 const numeric=/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
 const numericColumns=headers.filter((_,i)=>rows.every(r=>{const value=r[i].trim();return numeric.test(value)&&Number.isFinite(Number(value))&&Math.abs(Number(value))<=1e12}));
 if(!numericColumns.length)throw new Error('CSV has no supported numeric columns.');return {headers,numericColumns,rowCount:rows.length};
}
