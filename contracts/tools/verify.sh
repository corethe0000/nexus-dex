#!/bin/sh
#publishes the NexusSwap source on the chain's explorer (Etherscan, BscScan, PolygonScan, Arbiscan, BaseScan all take
#one Etherscan API v2 key). Run from contracts/ after tools/deploy-mainnet.ts wrote mainnet/deployments/<id>.json.
#  ETHERSCAN_API_KEY=<key> sh tools/verify.sh 56
#Without a key: upload mainnet/NexusSwap.standard-input.json on the explorer's "Verify and Publish" page
#(Solidity, standard JSON input, compiler v0.8.28).
set -e
id="$1"
addr=$(node -e "console.log(require('./mainnet/deployments/$id.json').swap)")
forge verify-contract "$addr" src/NexusSwap.sol:NexusSwap --chain "$id" --verifier etherscan \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --compiler-version 0.8.28 --num-of-optimizations 200 --watch
