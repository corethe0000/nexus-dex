//writes SK256 test vectors (32 byte inputs) and the Skein-256-256 IV for the Solidity port
//runs from a copy in the wallet tree: cp to ~/wallet/src/lib/dex-sk256-vectors.test.ts, OUT=<file> npx vitest run src/lib/dex-sk256-vectors.test.ts
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { skeinIv } from './skein';
import { sk256 } from './tritium';

const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');

it('writes vectors', () => {
  const inputs: Uint8Array[] = [new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => i), new Uint8Array(32).fill(0xff)];
  for (let i = 0; i < 20; i++) {
    inputs.push(crypto.getRandomValues(new Uint8Array(32)));
  }
  const out = {
    iv: skeinIv(256, 256).map((v) => '0x' + v.toString(16).padStart(16, '0')),
    inputs: inputs.map(hex),
    hashes: inputs.map((x) => hex(sk256(x))),
  };
  writeFileSync(process.env.OUT || 'sk256-vectors.json', JSON.stringify(out, null, 2));
});
