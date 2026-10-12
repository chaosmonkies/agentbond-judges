'use strict';
// Fixed, trusted executable. Marketplace text is parsed as data and never evaluated.
// Node permission mode removes filesystem writes, child processes, native addons,
// and workers. The fixed analysis function exposes no network operations. Node's
// permission mode does not itself provide operating-system network isolation.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 2200000) process.exit(2); });
process.stdin.on('end', () => {
  try {
    const { csv, spec } = JSON.parse(input);
    const rows = []; let row = [], cell = '', quoted = false, closed = false;
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i];
      if (quoted) {
        if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') { quoted = false; closed = true; }
        else cell += c;
      } else if (c === '"') { if (cell || closed) throw Error('Malformed CSV quote'); quoted = true; }
      else if (c === ',' || c === '\n' || c === '\r') {
        row.push(cell); cell = ''; closed = false;
        if (c !== ',') { if (c === '\r' && csv[i + 1] === '\n') i++; rows.push(row); row = []; }
      } else { if (closed) throw Error('Text after quoted field'); cell += c; }
      if (rows.length > 10001 || row.length > 64 || cell.length > 10000) throw Error('CSV resource limit');
    }
    if (quoted) throw Error('Unclosed quote');
    if (cell || row.length || closed) { row.push(cell); rows.push(row); }
    if (rows.length < 2 || rows.length > 10001) throw Error('CSV row count limit');
    const headers = rows.shift();
    if (headers.length > 64 || headers.some(h => !h || h.length > 100) || new Set(headers).size !== headers.length) throw Error('Invalid CSV headers');
    if (rows.some(r => r.length !== headers.length)) throw Error('Inconsistent CSV width');
    const columns = Object.create(null), anomalies = [];
    const numeric = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
    for (const name of spec.acceptance.numericColumns) {
      const index = headers.indexOf(name); if (index < 0) throw Error('Missing numeric column');
      let sum = 0, min = Infinity, max = -Infinity;
      for (let r = 0; r < rows.length; r++) {
        const raw = rows[r][index].trim(); if (!numeric.test(raw)) throw Error('Invalid numeric cell');
        const value = Number(raw); if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw Error('Numeric resource limit');
        sum += value; min = Math.min(min, value); max = Math.max(max, value);
        const rule = spec.acceptance.anomaly;
        if (name === rule.column && (rule.direction === 'above' ? value > rule.threshold : value < rule.threshold)) anomalies.push({ row: r + 1, column: name, value });
      }
      columns[name] = { count: rows.length, sum, mean: sum / rows.length, min, max };
    }
    process.stdout.write(JSON.stringify({ version: 1, inputHash: spec.input.hash, rowCount: rows.length, columns, anomalies }));
  } catch (e) { process.stderr.write(String(e.message)); process.exitCode = 1; }
});
