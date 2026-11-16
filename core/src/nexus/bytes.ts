//byte helpers shared by the Nexus modules (the format code itself lives in the wallet's tritium.ts)
export { memoryOfAddress, memoryOfHex, addressOfMemory, hexOfMemory } from '../../../../wallet/src/lib/tritium';

export function toHexBytes(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHexBytes(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
