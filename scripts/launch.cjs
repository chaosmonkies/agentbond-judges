const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
let binary = process.execPath;
if (Number(process.versions.node.split('.')[0]) < 24) {
  const local = '/opt/homebrew/opt/node@24/bin/node';
  if (!existsSync(local)) { console.error('AgentBond requires Node.js 24+. Install the version in .node-version.'); process.exit(1); }
  binary = local;
}
const mode = process.argv[2];
const args = mode === 'test' ? ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(3)] : ['--import', 'tsx', `scripts/${mode}.ts`, ...process.argv.slice(3)];
const result = spawnSync(binary, args, { stdio: 'inherit', env: { ...process.env, PATH: require('node:path').dirname(binary) + ':' + process.env.PATH } });
process.exit(result.status ?? 1);
