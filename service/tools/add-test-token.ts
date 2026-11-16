//deploys one more mintable test token on the local chain and gives it to the anvil accounts plus any addresses given;
//prints the token entry for the relay config (chains.31337.tokens).
//  CONTRACTS=$HOME/dex/contracts/out EVM_RPC=http://127.0.0.1:8545 npx tsx tools/add-test-token.ts TETH "Test Ether" 18 [0xaddr ...]
import type { Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { keys } from '../../core/src/testing/local';
import { deployTestToken } from './deploy-lib';

const [symbol, name, decimalsText, ...extra] = process.argv.slice(2);
if (!symbol || !name || !decimalsText) {
  throw new Error('usage: add-test-token.ts SYMBOL "Name" DECIMALS [address ...]');
}
const decimals = Number(decimalsText);
const anvilMnemonic = 'test test test test test test test test test test test junk';
const holders = [...Array.from({ length: 10 }, (_, i) => mnemonicToAccount(anvilMnemonic, { addressIndex: i }).address), ...(extra as Address[])];
const address = await deployTestToken({ out: process.env.CONTRACTS!, rpc: process.env.EVM_RPC ?? 'http://127.0.0.1:8545', chainId: 31337, deployerKey: keys.deploy, name, symbol, decimals, holders, mintEach: 100n * 10n ** BigInt(decimals) });
console.log(JSON.stringify({ address: address.toLowerCase(), symbol, decimals }));
