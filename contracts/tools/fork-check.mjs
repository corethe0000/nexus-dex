//runs test/Fork.t.sol for every chain in mainnet/chains.json (or the ids given) against a fork of that mainnet:
//the real USDT / USDC contracts and the native coin go through lock, claim and refund. Only reads from the public
//RPCs, sends nothing. Writes mainnet/fork-check.json (results and gas per step) for the contract guide.
//  cd contracts && node tools/fork-check.mjs [1 56 137 42161 8453]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('mainnet/chains.json', 'utf8'));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cfg.chains);
const out = {};
let failed = 0;
for (const id of ids) {
  const c = cfg.chains[id];
  const env = {
    ...process.env,
    FORK_RPC: c.rpc,
    FORK_TOKENS: c.tokens.map((t) => t.address).join(','),
    FORK_DECIMALS: c.tokens.map((t) => t.decimals).join(','),
  };
  let log = '';
  let ok = true;
  try {
    log = execFileSync('forge', ['test', '--match-contract', 'ForkTest', '-vv'], { env, encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch (e) {
    ok = false;
    log = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const lines = log.split('\n');
  const num = (re) => Number(lines.find((l) => re.test(l))?.match(/(\d+)\s*$/)?.[1] ?? NaN);
  //per token: the symbol line, then its three gas lines
  const tokens = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/token (0x[0-9a-fA-F]{40}) (\S+) (\d+)/);
    if (m) {
      cur = { address: m[1], symbol: m[2], decimals: Number(m[3]) };
      tokens.push(cur);
      continue;
    }
    const g = l.match(/gas (lock|claim|refund) (\d+)/);
    if (g) {
      if (!cur || cur.refund !== undefined) {
        cur = { address: 'native', symbol: c.native.symbol };
        tokens.push(cur);
      }
      cur[g[1]] = Number(g[2]);
    }
  }
  const block = lines.find((l) => /chain id/.test(l))?.match(/block (\d+)/)?.[1];
  ok = ok && /\[PASS\] testRealTokens/.test(log);
  failed += ok ? 0 : 1;
  out[id] = { name: c.name, passed: ok, forkBlock: block ? Number(block) : null, deployGas: num(/gas deploy/), tokens, at: new Date().toISOString() };
  console.log(`${c.name} (${id}): ${ok ? 'PASS' : 'FAIL'} at block ${block}`);
  for (const t of tokens) {
    console.log(`  ${t.symbol} ${t.address} lock ${t.lock} claim ${t.claim} refund ${t.refund}`);
  }
  if (!ok) {
    console.log(lines.filter((l) => /FAIL|Error|revert|assert/i.test(l)).slice(0, 12).join('\n'));
  }
}
writeFileSync('mainnet/fork-check.json', JSON.stringify(out, null, 2) + '\n');
process.exit(failed ? 1 : 0);
