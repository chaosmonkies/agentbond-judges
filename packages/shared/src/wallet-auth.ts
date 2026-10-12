export type Challenge = { nonce:string;message:string;expiresAt:number;domain:string };
export type AuthAction = 'job-metadata'|'upload-input'|'request-faucet'|'register-agent';
/** Browser/server-independent validation of the exact wallet authorization scope. */
export function validateChallenge(challenge:Challenge,scope:{domain:string;wallet:string;bodyHash:string;action?:AuthAction},now=Date.now()) {
  const lines=challenge.message.split('\n'),issued=Date.parse(lines[6]?.slice(11)??''),expires=Date.parse(lines[7]?.slice(12)??'');
  if(!/^[a-f0-9]{64}$/.test(challenge.nonce)||challenge.domain!==scope.domain||challenge.expiresAt<=now||challenge.expiresAt>now+120000||
    lines.length!==8||lines[0]!=='AgentBond wallet authorization'||lines[1]!=='Domain: '+scope.domain||lines[2]!=='Wallet: '+scope.wallet||
    lines[3]!=='Action: '+(scope.action??'job-metadata')||lines[4]!=='Body SHA256: '+scope.bodyHash||lines[5]!=='Nonce: '+challenge.nonce||
    !lines[6].startsWith('Issued at: ')||!Number.isFinite(issued)||Math.abs(now-issued)>120000||!lines[7].startsWith('Expires at: ')||
    !Number.isFinite(expires)||expires!==challenge.expiresAt)throw new Error('Unsafe wallet authorization challenge: domain, scope, body, nonce or expiry mismatch.');
}
