import { createServer } from 'node:http';
import { once } from 'node:events';

export const CSV = Buffer.from('day,revenue,orders\nMon,120,6\nTue,180,9\nWed,140,7\nThu,220,11\nFri,1800,12\nSat,160,8\nSun,200,10\n');
export const INPUT_ORIGIN = 'http://127.0.0.1:4101';
export async function inputServer() {
  const server = createServer((req, res) => {
    if (req.url === '/inputs/demo.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-length': CSV.length }); res.end(CSV); }
    else if (req.url === '/health') { res.end('AgentBond public demo input'); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(4101, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
