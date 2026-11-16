//English texts: trading page, simple swap ticket, market note, market panels and price chart (ui/Trade.tsx, ui/Simple.tsx, ui/MarketNote.tsx, ui/MarketCharts.tsx, ui/Chart.tsx)
import type { Plural } from '../en';

export const trade = {
  //Trade: venue picker, heading, simple/advanced switch
  trWhatToTrade: 'What to trade',
  trVenueStable: 'NXS and other chains',
  trVenueStableSub: '{coins} on {chains}', //coins and chains are comma separated lists
  trVenueNexus: 'Nexus tokens',
  trVenueNexusSub: 'NXS and tokens on the Nexus chain, Nexus profile only',
  trHeadNexusSimple: 'Trade Nexus tokens',
  trHeadNexusAdvanced: 'Nexus market',
  trHeadSimple: 'Swap NXS with other chains',
  trHeadAdvanced: 'Market',
  trLedeNexus: 'Orders live on the Nexus chain itself. Taking one pays both sides in a single transaction, so there is nothing to wait for and no other wallet to connect.',
  trLedeSimple: 'Person to person, no middleman holding your coins. Both sides lock, then both get paid, or both get their coins back.',
  trLedeAdvanced: 'Every open offer, best prices and depth. Take any offer whole, or post your own at your price.',
  trTradingView: 'Trading view',
  trSimple: 'Simple',
  trAdvanced: 'Advanced',

  //Simple: main button and its hint
  trLoadingOffers: 'Loading offers...',
  trNobodyBuying: 'Nobody is buying {coin} here right now',
  trNobodySelling: 'Nobody is selling {coin} here right now',
  trEnterAmount: 'Enter an amount like 12.5',
  trNoOfferFits: 'No offer fits this amount',
  trSmallestOffer: 'The smallest offer is {amount} {unit}.',
  trAsking: 'Asking the other side...',
  trSetUpSwaps: 'Set up swaps on your Nexus profile',
  trSignInToSwap: 'Sign in to Nexus to swap',
  trAddWallet: 'Add a wallet or receiving address',
  trConnectToPay: 'Connect a wallet to pay',
  trNotReady: 'Not ready yet',
  trSwapFor: 'Swap {pay} for {get}', //pay and get are an amount with its coin, e.g. 11.8 USDT
  //Simple: the ticket
  trTicket: 'Swap',
  trWhatToDo: 'What do you want to do',
  trSellCoin: 'Sell {coin}',
  trBuyCoin: 'Buy {coin}',
  trYouPay: 'You pay',
  trYouGet: 'You get',
  trOnNexus: 'On Nexus',
  trOnChain: 'On {chain}',
  trOnAnyChain: 'On any chain',
  trUseBalance: 'Use your whole balance',
  trBalance: 'Balance {balance}', //balance is an amount with its coin
  trSwitchToBuying: 'Switch to buying {coin}',
  trSwitchToSelling: 'Switch to selling {coin}',
  trBestFits: 'The best offer that fits is for {amount} {unit}. Offers are taken whole, so take this one and then the next for the rest.',
  trLockFirst: 'You lock first. If the other side does not finish, your {unit} comes back after {time}.',
  trOtherOffers: 'Other offers',
  trAtPrice: 'at {price}',
  trHideOwn: 'Hide your own offer',
  trOwnSell: 'Or offer your own price to sell {coin}',
  trOwnBuy: 'Or offer your own price to buy {coin}',
  //Simple: how a swap works; {b} is where the bold part (the ...Bold key) goes
  trHowTitle: 'How a swap works',
  trHow1Bold: 'You lock',
  trHow1: '{b} what you pay, on its own chain.',
  trHow2Bold: 'They lock',
  trHow2: '{b} what you get.',
  trHow3Bold: 'Both collect.',
  trHow3: '{b} If anything stops, both locks go back to their owners.',
  //Simple: coin and chain pickers
  trNexusCoin: 'Nexus coin',
  trCoinAndChain: 'Coin and chain',
  trAnyStable: 'Any stablecoin',
  trTokenOnChain: '{symbol} on {chain}',
  //Simple: your own offer
  trOwnSellField: 'Sell ({coin})',
  trOwnBuyField: 'Buy ({coin})',
  trPricePer: 'Price per {coin} ({unit})',
  trPaidIn: 'Paid in {symbol} on {chain}. Pick another coin in the ticket above to change it.',
  trOwnGetWhen: 'You get {amount} {symbol} when someone takes it.',
  trOwnPayWhen: 'You pay {amount} {symbol} when someone takes it.',
  trOwnPosted: 'Your offer is up for a day. Keep this page open: it accepts takers on its own, and the swap shows under Your swaps.',
  trPosting: 'Posting...',
  trSignIn: 'Sign in to Nexus',
  trConnectWallet: 'Connect a wallet',
  trPostOffer: 'Post your offer',

  //MarketNote
  trMarketAbout: 'Market price about ${price} ({source}).',
  trReference: 'reference', //source name when the feed gives none
  trUseIt: 'Use it',
  trNetworkFee: 'Network fee on {chain}: about {fee}.',
  trNetworkFeeShare: 'That is {pct}% of what you swap.',
  trCopyLink: 'Copy link',
  trLinkCopied: 'Link copied',
  trOfferLink: 'Link to this offer',
  trLinkGone: 'The offer from the link is not up right now: it was taken or withdrawn, or its maker is offline.',

  //MarketCharts
  trTimeRange: 'Time range',
  tr24Hours: '24 hours',
  tr7Days: '7 days',
  trCoin: 'coin', //stands in for a coin name we do not know yet
  trMarketPriceSource: 'Market price ({source})',
  trSwapsHere: 'Swaps here',
  trCoinMarket: '{coin} market',
  trCoinPrice: '{coin} price',
  trChange24: '24 h change',
  trSwapped24: 'Swapped here, 24 h',
  trInSwaps: { one: 'in {n} swap', other: 'in {n} swaps' } as Plural,
  trAllMarkets24: 'All markets, 24 h',
  trSwappedHere: 'Swapped here',
  trNoPriceYet: 'No {coin} price for this time yet: it shows once swaps go through here.',
  trPairIn: '{a} in {b}',
  trLastPrice: 'Last price, {b} per {a}',
  trTraded24: 'Traded, 24 h',
  trInTrades: { one: 'in {n} trade', other: 'in {n} trades' } as Plural,
  trTrades: 'Trades',
  trTraded: 'Traded',
  trNoPairTrades: 'No {a} / {b} trades in this time yet.',

  //Chart
  trChartEmpty: 'No trades in this time yet.',
  trPriceFromTo: 'Price from {from} to {to}',
  trTipLabel: '{label}:', //a tooltip row: the series name, then its value
} satisfies Record<string, string | Plural>;
