# Nexus DEX

Swap NXS and Nexus tokens with USDT, USDC and the native coins of EVM chains (BSC, Polygon, Ethereum, Arbitrum, Base), person to person, with atomic swaps. Nobody holds the coins in between: each side locks its own coins on its own chain with the same secret hash, and either both get paid or both get their coins back.

It runs as a website and as a module inside the Nexus desktop wallet.

**Status (November 2026):** complete and tested on test networks: a private Nexus chain (LLL-TAO 5.1.6) with local EVM chains, Sepolia and BSC testnet, and the desktop wallet module in Nexus Wallet 3.1.5. The swap contract was tested on forks of the five mainnets with the real stablecoins. Not on mainnet yet; see `docs/pdf/Nexus-DEX-What-Mainnet-Needs.pdf`.

## Documents

- `docs/pdf/Nexus-DEX-Overview.pdf` - what it is and how a swap works, with screenshots
- `docs/pdf/NexusSwap-Contract-Guide.pdf` - the contract, tests, costs, and how to deploy and verify it
- `docs/pdf/Nexus-DEX-What-Mainnet-Needs.pdf` - services, hosting options, keys, settings, launch plan

## Layout

| Folder | What |
| --- | --- |
| `contracts/` | `NexusSwap.sol` (hash time locked swaps, no owner, no fees) and `Sk256.sol` (the Nexus SK256 hash), Foundry tests, mainnet kit (`mainnet/`, `tools/`) |
| `core/` | swap engine and runner (both chains, deadlines, claims and refunds), order book messages, EVM and Nexus legs |
| `service/` | relay (order book and watcher), independent keeper, maker program, deploy tools |
| `app/` | the website (React); also built as the desktop wallet module |
| `module/` | desktop wallet module packaging |
| `docs/` | documents (HTML sources and PDFs) and screenshots |

## Build

The DEX uses code from the Nexus browser wallet (Tritium transaction signing). Clone both side by side, with the wallet in a folder named `wallet`:

```
git clone https://github.com/corethe0000/nexus-browser-wallet wallet
git clone https://github.com/corethe0000/nexus-dex dex
cd wallet && npm install && cd ../dex
npm install
```

Website:

```
cd app
npm run dev        # development server, services from public/config.json
npm run build      # static site in app/dist
```

`app/public/config.json` names the services per network (relay, Nexus node, EVM RPCs, swap contract addresses, tokens). Set `walletConnectProjectId` there (from cloud.reown.com) to offer phone wallets.

Desktop wallet module:

```
node module/build.mjs --config app/public/config.json --base https://your.relay.host
```

The folder `module/dist` is the module (`nxs_package.json`, `config.js`, `index.html`, one script). In Nexus Wallet: Settings, Application, Developer mode on, then Settings, Modules, Add a development module, and pick the folder. The module talks to Nexus through the wallet's own core.

Contracts (Foundry):

```
cd contracts
forge build
forge test
node tools/fork-check.mjs        # lock, claim, refund on forks of the five mainnets (reads public RPCs only)
```

Services (Node.js 24; example configs in `service/config.example.json` and `service/keeper.example.json`):

```
cd service
DEX_CONFIG=config.json npx tsx src/main.ts            # relay
KEEPER_CONFIG=keeper.json npx tsx src/keeper-main.ts  # keeper
MAKER_CONFIG=maker.json npx tsx src/maker-bot-main.ts # maker program (optional)
```

Deploying the contract on a mainnet: see `docs/pdf/NexusSwap-Contract-Guide.pdf`, section 8 (`service/tools/deploy-mainnet.ts`, `contracts/tools/verify.sh`, `contracts/tools/configs.mjs`).

## Tests

```
npx vitest run --exclude "**/*.e2e.test.ts" --exclude "**/*.int.test.ts" --exclude "spikes/**"
```

The end-to-end tests (`*.e2e.test.ts`, `*.int.test.ts`, `app/tools/*-e2e.mjs`) need a private Nexus chain and anvil (`NEXUS_NODE`, `EVM_RPC`, `CONTRACTS`), see `core/src/testing/local.ts`.

## License

MIT, see `LICENSE`.
