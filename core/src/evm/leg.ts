//the EVM leg of a swap: the NexusSwap contract (dex/contracts/src/NexusSwap.sol) on BSC / Polygon / a local chain
import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { LockStatus, LockView } from '../swap/types';

export const nexusSwapAbi = parseAbi([
  'function lockId(address sender, address recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef) pure returns (bytes32)',
  'function lock(address recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef) payable returns (bytes32)',
  'function claim(bytes32 id, bytes32 secret)',
  'function claimTo(bytes32 id, bytes32 secret, address to)',
  'function refund(bytes32 id)',
  'function refundTo(bytes32 id, address to)',
  'error AlreadyExists()',
  'error NotOpen()',
  'error Expired()',
  'error NotExpired()',
  'error WrongSecret()',
  'error BadParams()',
  'error TransferFailed()',
  'error WrongValue()',
  'error Reentered()',
  'error NotRecipient()',
  'error NotSender()',
  'function locks(bytes32) view returns (address sender, address recipient, address token, uint64 deadline, uint8 state, uint256 amount, bytes32 hashlock)',
  'event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef)',
  'event Claimed(bytes32 indexed id, bytes32 secret)',
  'event Refunded(bytes32 indexed id)',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const claimedEvent = parseAbiItem('event Claimed(bytes32 indexed id, bytes32 secret)');
const lockedEvent = parseAbiItem('event Locked(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashlock, uint64 deadline, bytes32 nexusRef)');

export interface EvmLockExpect {
  sender: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  hashlock: Hex; //0x + 64 hex
  nexusRef: Hex; //bytes32 swap reference
}

//the token address that stands for the chain's own coin (ETH, BNB, POL): locked by sending it with the call
export const nativeToken: Address = '0x0000000000000000000000000000000000000000';
export const isNative = (token: string) => /^0x0{40}$/i.test(token);

const stateName = ['none', 'open', 'claimed', 'refunded'] as const;

export function lockIdOf(e: EvmLockExpect, deadline: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }],
      [e.sender, e.recipient, e.token, e.amount, e.hashlock, deadline, e.nexusRef],
    ),
  );
}

//blocks per getLogs call (public RPCs cap ranges, 5000 passes on the ones in use)
const logChunk = 5000n;
//how far before its first look a swap's events are searched (its own locks come after the swap starts): a time,
//turned into blocks with the chain's recent block rate (BSC makes blocks faster every year), at most maxSearchBack
const searchBackSeconds = 6 * 3600;
const rateSample = 1000n;
const maxSearchBack = 200000n;

export class EvmLeg {
  constructor(
    readonly client: PublicClient,
    readonly swap: Address,
    readonly confirmations = 2,
    readonly fromBlock = 0n,
  ) {}

  private async finalBlock(): Promise<bigint> {
    const head = await this.client.getBlockNumber();
    return head > BigInt(this.confirmations) ? head - BigInt(this.confirmations) : 0n;
  }

  //a lock as the contract holds it now (or at blockNumber); state none = no such lock
  async state(id: Hex, blockNumber?: bigint) {
    const [sender, recipient, token, deadline, state, amount, hashlock] = await this.client.readContract({ address: this.swap, abi: nexusSwapAbi, functionName: 'locks', args: [id], blockNumber });
    return { sender, recipient, token, deadline, state: stateName[state] ?? 'none', amount, hashlock };
  }

  //the lock's state including transactions not yet in a block: someone else's claim may be waiting to be mined
  async statePending(id: Hex): Promise<string> {
    const r = await this.client.readContract({ address: this.swap, abi: nexusSwapAbi, functionName: 'locks', args: [id], blockTag: 'pending' }).catch(() => null);
    return r ? (stateName[r[4]] ?? 'none') : (await this.state(id)).state;
  }

  //every lock made between two blocks (Locked events), for keepers that watch the contract as a whole
  async locksBetween(fromBlock: bigint, toBlock: bigint): Promise<{ id: Hex; deadline: bigint }[]> {
    const logs = await this.client.getLogs({ address: this.swap, event: lockedEvent, fromBlock, toBlock });
    return logs.map((l) => ({ id: l.args.id!, deadline: l.args.deadline! }));
  }

  //getLogs from `from` to the newest block in pieces, newest first, until the first match: public RPCs refuse long
  //ranges (a search over everything since the deployment fails once the chain has moved on far enough). The newest
  //piece ends at 'latest': behind a load balancer the next backend can be a block behind the head number just read,
  //and a range past its head is refused
  //best: among the matches, one that also passes this is taken first (else the newest match)
  private async firstLog<L>(get: (fromBlock: bigint, toBlock: bigint | 'latest') => Promise<L[]>, from: bigint, match: (l: L) => boolean, best?: (l: L) => boolean): Promise<L | null> {
    const start = from > this.fromBlock ? from : this.fromBlock;
    let to = await this.client.getBlockNumber();
    let newest = true;
    let fallback: L | null = null;
    while (to >= start) {
      const lo = to - logChunk + 1n > start ? to - logChunk + 1n : start;
      const hits = (await get(lo, newest ? 'latest' : to)).filter(match);
      newest = false;
      const hit = best ? hits.find(best) : hits[0];
      if (hit) {
        return hit;
      }
      fallback ??= hits[hits.length - 1] ?? null;
      to = lo - 1n;
    }
    return fallback;
  }

  //finds the lock on the chain alone: a Locked event for this recipient and swap reference, from block `from` on
  async locate(e: EvmLockExpect, from = this.fromBlock): Promise<{ id: Hex; deadline: bigint; tx: Hex } | null> {
    const hit = await this.firstLog(
      (fromBlock, toBlock) => this.client.getLogs({ address: this.swap, event: lockedEvent, args: { sender: e.sender, recipient: e.recipient }, fromBlock, toBlock }),
      from,
      (l) => l.args.nexusRef === e.nexusRef && l.args.hashlock === e.hashlock,
      //a dust lock with the same reference made first must not hide the real one: amount and token decide among them
      (l) => l.args.amount === e.amount && l.args.token?.toLowerCase() === e.token.toLowerCase(),
    );
    return hit ? { id: hit.args.id!, deadline: hit.args.deadline!, tx: hit.transactionHash } : null;
  }

  private claimedLog(id: Hex, from: bigint) {
    return this.firstLog((fromBlock, toBlock) => this.client.getLogs({ address: this.swap, event: claimedEvent, args: { id }, fromBlock, toBlock }), from, () => true);
  }

  //the transaction that claimed a lock (whoever sent it), for links to an explorer
  async claimTx(id: Hex, from = this.fromBlock): Promise<Hex | null> {
    return (await this.claimedLog(id, from))?.transactionHash ?? null;
  }

  async view(id: Hex | undefined, e: EvmLockExpect, pendingOwn?: 'lock' | 'claim' | 'refund'): Promise<LockView> {
    if (!id) {
      return { status: pendingOwn === 'lock' ? 'pending' : 'none' };
    }
    const latest = await this.state(id);
    if (latest.state === 'none') {
      return { status: pendingOwn === 'lock' ? 'pending' : 'none' };
    }
    const fin = await this.state(id, await this.finalBlock());
    const base: LockView = {
      status: 'pending',
      ref: id,
      amount: latest.amount.toString(),
      hashlock: latest.hashlock.slice(2),
      deadline: Number(latest.deadline),
      recipientOk: latest.recipient.toLowerCase() === e.recipient.toLowerCase() && latest.token.toLowerCase() === e.token.toLowerCase() && latest.sender.toLowerCase() === e.sender.toLowerCase(),
    };
    let status: LockStatus;
    if (fin.state === 'none') {
      status = 'pending';
    } else if (fin.state === 'claimed') {
      status = 'claimed';
    } else if (fin.state === 'refunded') {
      status = 'refunded';
    } else if (latest.state === 'claimed' || pendingOwn === 'claim') {
      status = 'claiming';
    } else if (latest.state === 'refunded' || pendingOwn === 'refund') {
      status = 'refunding';
    } else {
      status = 'confirmed';
    }
    return { ...base, status };
  }

  //the secret from the Claimed event (in any block, final or not: once it is public it can be used)
  async findSecret(id: Hex, from = this.fromBlock): Promise<Hex | null> {
    return (await this.claimedLog(id, from))?.args.secret ?? null;
  }

  //where a search for a swap's events can start: a little before now (the swap is younger than that)
  async searchStart(backSeconds = searchBackSeconds): Promise<bigint> {
    const head = await this.client.getBlock({ blockTag: 'latest' });
    const sampleAt = head.number > rateSample ? head.number - rateSample : 0n;
    let back = maxSearchBack;
    if (sampleAt < head.number) {
      const old = await this.client.getBlock({ blockNumber: sampleAt });
      const perBlock = Number(head.timestamp - old.timestamp) / Number(head.number - sampleAt);
      if (perBlock > 0) {
        back = BigInt(Math.ceil(backSeconds / perBlock));
        back = back > maxSearchBack ? maxSearchBack : back;
      }
    }
    return head.number > back ? head.number - back : 0n;
  }

  async clock(): Promise<number> {
    const b = await this.client.getBlock({ blockTag: 'latest' });
    return Number(b.timestamp);
  }

  //--- actions (wallet signs) ---

  //a sent transaction: still waiting in the network's queue (fee too low, chain stalled), in a block (final or not),
  //in a block but failed, or not known at all (dropped, or its block was reorganized away)
  async txState(hash: Hex): Promise<'queued' | 'mined' | 'failed' | 'unknown'> {
    const tx = await this.client.getTransaction({ hash }).catch(() => null);
    if (!tx) {
      return 'unknown';
    }
    if (tx.blockNumber === null) {
      return 'queued';
    }
    const receipt = await this.client.getTransactionReceipt({ hash }).catch(() => null);
    return receipt?.status === 'reverted' ? 'failed' : 'mined';
  }

  //a transaction still in the queue sent again with the same nonce and a higher fee, so the new one replaces it
  //(nodes want both fees up by at least 10 %; this goes up 30 % or to what the chain asks now, whichever is more).
  //null = it is not queued any more. A wallet that picks its own nonce sends it as a second transaction instead: the
  //one mined later fails (lock already claimed), which costs its fee and nothing else
  async speedUp(wallet: WalletClient, hash: Hex): Promise<Hex | null> {
    const tx = await this.client.getTransaction({ hash }).catch(() => null);
    if (!tx || tx.blockNumber !== null || !tx.to) {
      return null;
    }
    //only our own call to the swap contract is signed again, never what an RPC hands back under that hash
    if (tx.from.toLowerCase() !== wallet.account!.address.toLowerCase() || tx.to.toLowerCase() !== this.swap.toLowerCase()) {
      throw new Error('the queued transaction is not our call to the swap contract');
    }
    const up = (v: bigint | null | undefined) => ((v ?? 0n) * 13n) / 10n + 1n;
    const max = (a: bigint, b: bigint | undefined) => (b !== undefined && b > a ? b : a);
    const base = { account: wallet.account!, chain: wallet.chain, to: tx.to, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas };
    if (tx.maxFeePerGas !== undefined && tx.maxFeePerGas !== null) {
      const now = await this.client.estimateFeesPerGas().catch(() => undefined);
      const maxPriorityFeePerGas = max(up(tx.maxPriorityFeePerGas), now?.maxPriorityFeePerGas);
      const maxFeePerGas = max(max(up(tx.maxFeePerGas), now?.maxFeePerGas), maxPriorityFeePerGas);
      return wallet.sendTransaction({ ...base, maxFeePerGas, maxPriorityFeePerGas });
    }
    const now = await this.client.getGasPrice().catch(() => undefined);
    return wallet.sendTransaction({ ...base, gasPrice: max(up(tx.gasPrice), now) });
  }

  async lock(wallet: WalletClient, e: EvmLockExpect, deadline: number): Promise<{ id: Hex; tx: Hex }> {
    const account = wallet.account!;
    //the contract makes the lock id from the signing account: another account than the swap's sender (an account
    //switched in the wallet) would lock under an id this swap never finds
    if (account.address.toLowerCase() !== e.sender.toLowerCase()) {
      throw new Error(`the wallet signs with ${account.address}, this swap locks from ${e.sender}`);
    }
    const native = isNative(e.token);
    //a token needs the allowance first; the native coin goes along with the lock call itself
    if (!native) {
      const allowance = await this.client.readContract({ address: e.token, abi: erc20Abi, functionName: 'allowance', args: [account.address, this.swap] });
      if (allowance < e.amount) {
        //USDT on Ethereum refuses to change one allowance that is not 0 into another: back to 0 first
        if (allowance > 0n) {
          await this.approve(wallet, e.token, 0n);
        }
        await this.approve(wallet, e.token, e.amount);
      }
    }
    const tx = await wallet.writeContract({ address: this.swap, abi: nexusSwapAbi, functionName: 'lock', args: [e.recipient, e.token, e.amount, e.hashlock, BigInt(deadline), e.nexusRef], account, chain: wallet.chain, value: native ? e.amount : undefined });
    return { id: lockIdOf(e, BigInt(deadline)), tx };
  }

  private async approve(wallet: WalletClient, token: Address, amount: bigint) {
    const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [this.swap, amount], account: wallet.account!, chain: wallet.chain });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`the token refused the approval ${hash}`);
    }
  }

  //claim, claimTo, refund and refundTo are tried first and not sent when the contract would refuse them: a failed
  //claim still puts the secret on chain for anyone to read, and a payment the recipient cannot take (a frozen token
  //address, an address that refuses the coin) is EvmCannotReceive, so the page offers another address at once
  private async send(wallet: WalletClient, functionName: 'claim' | 'claimTo' | 'refund' | 'refundTo', args: readonly unknown[]): Promise<Hex> {
    const call = { address: this.swap, abi: nexusSwapAbi, functionName, args, account: wallet.account! } as unknown as Parameters<PublicClient['simulateContract']>[0];
    try {
      await this.client.simulateContract(call);
    } catch (e) {
      const name = revertName(e);
      if (name === 'TransferFailed') {
        throw new EvmCannotReceive(`${functionName}: the receiving address cannot take this payment`);
      }
      if (name) {
        throw new Error(`${functionName} refused by the contract: ${name}`);
      }
      throw e;
    }
    return wallet.writeContract({ ...call, chain: wallet.chain } as Parameters<WalletClient['writeContract']>[0]);
  }

  async claim(wallet: WalletClient, id: Hex, secret: Hex): Promise<Hex> {
    return this.send(wallet, 'claim', [id, secret]);
  }

  //the recipient itself has its claim paid to another of its addresses (a token that froze the recipient refuses claim)
  async claimTo(wallet: WalletClient, id: Hex, secret: Hex, to: Address): Promise<Hex> {
    return this.send(wallet, 'claimTo', [id, secret, to]);
  }

  async refund(wallet: WalletClient, id: Hex): Promise<Hex> {
    return this.send(wallet, 'refund', [id]);
  }

  //the sender itself has its refund paid to another of its addresses
  async refundTo(wallet: WalletClient, id: Hex, to: Address): Promise<Hex> {
    return this.send(wallet, 'refundTo', [id, to]);
  }

  //for helpers that pay gas for other people's locks (relay watcher, keeper): the call is tried first and not sent
  //when it would fail (a token that refuses the transfer, a sender contract that refuses the coin) or needs more
  //than maxGas (a token that burns gas on transfer); EvmGasRefused then
  async guarded(wallet: WalletClient, call: { fn: 'claim'; id: Hex; secret: Hex } | { fn: 'refund'; id: Hex }, maxGas: bigint): Promise<Hex> {
    const req = call.fn === 'claim' ? { functionName: 'claim' as const, args: [call.id, call.secret] as const } : { functionName: 'refund' as const, args: [call.id] as const };
    let gas: bigint;
    try {
      gas = await this.client.estimateContractGas({ address: this.swap, abi: nexusSwapAbi, ...req, account: wallet.account! } as Parameters<PublicClient['estimateContractGas']>[0]);
    } catch (e) {
      throw new EvmGasRefused(`${call.fn} would fail: ${(e as Error).message.split('\n')[0]}`);
    }
    if (gas > maxGas) {
      throw new EvmGasRefused(`${call.fn} needs ${gas} gas, more than ${maxGas}`);
    }
    return wallet.writeContract({ address: this.swap, abi: nexusSwapAbi, ...req, gas: (gas * 12n) / 10n, account: wallet.account!, chain: wallet.chain } as Parameters<WalletClient['writeContract']>[0]);
  }
}

//gas a maker must still hold before it accepts a take: its lock (with an approval) or its claim, twice over for a
//rising gas price or a claim sent again
const makerGas = 600000n;

//the chain's coin a maker holds is short of the gas for its own steps, after `alsoNative` (a coin it also locks);
//null = enough, else how much it holds and needs (base units)
export async function gasShort(client: PublicClient, address: Address, alsoNative = 0n): Promise<{ has: bigint; needs: bigint } | null> {
  const [has, price] = await Promise.all([client.getBalance({ address }), client.getGasPrice()]);
  const needs = price * makerGas + alsoNative;
  return has >= needs ? null : { has, needs };
}

export class EvmGasRefused extends Error {}
export class EvmCannotReceive extends Error {}

//the contract's error name in a failed simulation, if it is one of ours
function revertName(e: unknown): string | undefined {
  let c: any = e;
  for (let i = 0; c && i < 8; i++, c = c.cause) {
    if (c.data?.errorName) {
      return c.data.errorName as string;
    }
  }
  return undefined;
}

//most a helper pays for one claim or refund: a claim is about 305000 (the SK256 check of the secret is most of it),
//a refund much less
export const helperMaxGas = 450000n;
