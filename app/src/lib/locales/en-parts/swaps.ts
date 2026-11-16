//English texts: your swaps page with its swap cards and steps (ui/Swaps.tsx), how it works (ui/Help.tsx), tab title and notifications (lib/attention.ts)
import type { Plural } from '../en';

export const swaps = {
  //Swaps: page
  swTitle: 'Your swaps',
  swLede: 'A swap is four steps: you both lock what you pay, then you both receive. A lock is not a payment: if the other side stops, your coins come back to you. Keep this page open until a swap says Swapped.',
  swLedeIn: "A swap is four steps: you both lock what you pay, then you both receive. A lock is not a payment: if the other side stops, your coins come back to you. Keep the Nexus wallet open until a swap says Swapped.",
  swEmpty: 'No swaps yet.',
  swEmptyText: 'Swaps you start on the Swap page show up here, with every step as it happens.',
  swRunning: 'Running', //followed by the count
  swHistory: 'History', //followed by the count
  swDownloadCsv: 'Download as CSV',
  //Swaps: history row; {nexus} and {evm} are amounts with their coin, e.g. "12 NXS"
  swSold: 'Sold {nexus} for {evm}',
  swBought: 'Bought {nexus} for {evm}',
  swUnits: '{amount} units', //an amount of a token whose name is not known yet
  //Swaps: state of a swap (short, in a badge)
  swStateAsking: 'Waiting for the other side to accept',
  swStateLapsed: 'Not accepted, nothing was locked',
  swStateSwapped: 'Swapped',
  swStateRefunded: 'Refunded',
  swStateLost: 'Lost',
  swStateStopped: 'Stopped: {reason}', //{reason} comes from the swap engine, in English
  swStateInProgress: 'In progress',
  //Swaps: swap card
  swCardLabel: 'Swap {id}',
  swPair: '{pay} for {get}', //what you pay for what you get, e.g. "12 NXS for 3 USDT"
  swRoleTook: 'You took an offer',
  swRoleTaken: 'Your offer was taken',
  swLastFailed: 'Last try failed: {reason}. It is tried again by itself.', //{reason} is an error text, in English
  swStop: 'Stop this swap (nothing of yours is locked yet)',
  //Swaps: transactions list; {what} is one of the swTx kinds below, {chain} a chain name
  swTxs: 'Transactions ({n})',
  swTxMine: 'Your {what} on {chain}',
  swTxTheirs: 'Their {what} on {chain}',
  swTxService: 'Service {what} on {chain}',
  swTxLock: 'lock',
  swTxReveal: 'secret written',
  swTxClaim: 'collect',
  swTxRefund: 'refund',
  swTxCopy: 'Copy the transaction id',
  //Swaps: collect it yourself; {amount} with its coin, {gas} the fee coin of {chain}, {address} a short address
  swCollectTitle: 'Collect it yourself',
  swCollectText: 'The Nexus DEX service has not collected your {amount} yet. You can send the collect from any wallet in this browser that has a little {gas} on {chain} for the fee. The payment still goes only to {address}.',
  swCollectTextWhy: 'The Nexus DEX service has not collected your {amount} yet ({reason}). You can send the collect from any wallet in this browser that has a little {gas} on {chain} for the fee. The payment still goes only to {address}.', //{reason} is an error text, in English
  swCollectBefore: 'Collect before {time}, after that it goes back to the other side.', //added after swCollectText
  swNoWallet: 'No wallet found in this browser. Install MetaMask or Binance Wallet, then reload this page; the swap waits here.',
  swNoWalletIn: "Inside the Nexus wallet there is no browser wallet. Connect a phone wallet with WalletConnect (top right) if it is offered; the swap waits here.",
  swCollectWith: 'Collect with {wallet}',
  //Swaps: receive at another address (NexusSwap claimTo); {amount} with its coin, {address} a short address
  swToTitle: 'Receive at another address',
  swToText: 'Your {amount} could not be collected to {address}. If that address cannot receive it (for example the token issuer froze it), your wallet for {address} can have the payment sent to another address of yours. Check the address: a payment sent there cannot be undone.',
  swToLabel: 'Your other address on {chain}',
  swToSend: 'Send it there',
  swToSent: 'Sent to your other address. The swap finishes once {chain} confirms it.',
  swRefundToTitle: "Refund to another address",
  swRefundToText: "Your refund of {amount} could not be sent back to {address}. If that address cannot receive it (for example the token issuer froze it), your wallet for {address} can have the refund sent to another address of yours. Check the address: a payment sent there cannot be undone.",
  swRefundToSent: "Refund sent to your other address. The swap ends once {chain} confirms it.",
  swToBadAddress: 'That is not an address on this chain.',
  swToSameAddress: 'Use another address than the one that cannot receive, and not the swap contract.',
  swToUnavailable: 'This payment cannot go to another address now: it was collected or refunded, or the wallet of the receiving address is not connected here.',
  //Swaps: what the swap waits for (the engine's reasons in plain words)
  swWaitOwnLock: 'Waiting for your lock to be confirmed.',
  swWaitOwnCollect: 'Waiting for your collection to be confirmed.',
  swWaitOwnRefund: 'Waiting for your refund to be confirmed.',
  swWaitOtherLockFinal: 'Waiting for the other lock to be confirmed.',
  swWaitOtherLock: 'Waiting for the other side to lock.',
  swWaitOtherCollect: 'Waiting for the other side to collect.',
  swWaitReadKey: 'Reading the key from the other side\'s collection.',
  swWaitTooLate: 'Too late to collect safely, so your coins come back to you.',
  swWaitLockWrong: 'The other lock does not match the offer, so it is not used and your coins come back to you.',
  //Swaps: a wallet window waits for the user; {what} is one of the swStep texts below
  swApproveNexus: 'Approve "{what}" in the Nexus Wallet window (unlock it first if it asks). The swap waits for you.',
  swConfirmWallet: 'Confirm "{what}" in your wallet (MetaMask or the one you connected). The swap waits for you.',
  swStepCreateSlot: 'set up swaps',
  swStepLock: 'lock your coins',
  swStepReveal: 'publish the key of this swap',
  swStepClaim: 'collect',
  swStepRefund: 'take your coins back',
  swStepApprove: 'allow the swap contract to move your coins',
  //Swaps: the one sentence on top of a swap card; {amount} with its coin, {chain} a chain name
  swStatusAsking: 'Waiting for the other side to accept. Nothing is locked yet.',
  swStatusLapsed: 'The other side did not accept in time. Nothing was locked.',
  swStatusSwapped: 'Done. You received {amount} on {chain}.',
  swStatusRefunded: 'The swap did not finish. Your {amount} came back to you.',
  swStatusLost: 'Your {amount} could not be taken back in time.',
  swStatusStopped: 'Stopped: {reason}. Nothing of yours was locked.', //{reason} comes from the swap engine, in English
  swStatusWorking: 'Working on it.',
  swStatusTheirLock: 'Waiting for the other side to lock {amount}.',
  swStatusLockSent: 'Your lock is sent. Waiting for {chain} to confirm it.',
  swStatusLocking: 'Locking your {amount}.',
  swStatusCollecting: 'Collecting your {amount}.',
  swStatusTheirCollect: 'Waiting for the other side to collect {amount}.',
  //Swaps: the four steps; each shows who, the amount, then swOnChain
  swOnChain: 'on {chain}',
  swBackToYou: 'Back to you',
  swYouLocked: 'You locked',
  swTheyLocked: 'They locked',
  swYouLock: 'You lock',
  swTheyLock: 'They lock',
  swYouReceived: 'You received',
  swTheyReceived: 'They received',
  swYouReceive: 'You receive',
  swTheyReceive: 'They receive',
  //Swaps: while your coins are locked; {time} a clock time, {wait} a duration like "20 min"
  swSafeAfter: 'Your {amount} is locked, not sent. If the other side stops, it comes back to you after {time} (in {wait}).',
  swSafeNow: 'Your {amount} is locked, not sent. If the other side stops, it comes back to you now.',
  //attention: tab title ({title} is the rest of the title, e.g. "Nexus DEX") and desktop notifications
  swTabTestnet: 'Testnet: {title}',
  swTabAction: 'Action needed: {title}',
  swNoteSwapped: 'Swap finished',
  swNoteSwappedText: 'Both sides are paid.',
  swNoteRefunded: 'Swap refunded',
  swNoteRefundedText: 'Your coins came back to you.',
  swNoteAccepted: 'Swap accepted',
  swNoteAcceptedText: 'The other side accepted. Keep the page open while it runs.',
  swNoteWallet: 'Your wallet is waiting',
  swNoteWalletNexus: 'Approve the swap step in the Nexus Wallet window.',
  swNoteWalletOther: 'Confirm the swap step in your wallet.',

  //Help: intro
  helpTitle: 'How it works',
  helpLede: 'You trade directly with another person. Nobody holds your coins in between: not this site, not the other person, not a company. Each side locks its coins in a way only the swap itself can open, and either both get paid or both get their coins back.',
  //Help: the four steps; each is a bold Title followed by its Text; {deadline}, {most}, {safety} are durations like "20 min"
  helpStepsTitle: 'A swap in four steps',
  helpStep1Title: 'You lock your coins.',
  helpStep1Text: 'They sit on their own chain, in a lock with a secret only your page knows and a deadline of {deadline}. Until the deadline nobody can move them except with that secret, and after it only back to you.',
  helpStep2Title: 'The other side locks theirs.',
  helpStep2Text: 'Same kind of lock on the other chain, made for your address, with a shorter deadline ({most} at most). If they never lock, you simply get yours back.',
  helpStep3Title: 'You collect theirs.',
  helpStep3Text: 'Your page opens their lock with the secret. Doing that makes the secret public, and this is the only way it ever gets out.',
  helpStep4Title: 'They collect yours', //bold start of the sentence, helpStep4Text goes on with it
  helpStep4Text: 'with the same secret, which their page reads from the chain. Their deadline ends at least {safety} before yours, so they always have time for it.',
  helpRoles: 'When you post an offer instead of taking one, the roles swap: the person who takes your offer locks first, and you lock second.',
  //Help: what can happen
  helpCasesTitle: 'What can happen',
  helpSwapped: 'Swapped',
  helpSwappedText: 'Both sides got paid. This is how almost every swap ends, usually in a few minutes.',
  helpRefunded: 'Refunded',
  helpRefundedText: 'Someone did not lock, or did not lock in time. Every coin that was locked goes back to whoever locked it, shortly after its deadline. Your page does that for you.',
  helpStopped: 'Stopped',
  helpStoppedText: 'You stopped the swap before anything of yours was locked. Nothing moved.',
  //Help: what keeps it safe
  helpSafeTitle: 'What keeps it safe',
  helpSafe1: 'The locks are code on the chains themselves. The swap contract on the other chains has no owner, no fee and no way to be changed after it is deployed.',
  helpSafe2: 'Nobody can take locked coins: not this site, not the offer service. The secret opens a lock only for the address it was made for, and the deadline returns it only to whoever locked it.',
  helpSafe3: 'Your page checks the other side\'s lock (amount, coin, address, time left) before it does anything, and it never reveals the secret into a lock that is wrong or too close to its deadline.',
  helpSafe4: 'Coins on {chains} can be collected for you by helper services once the secret is public, so a buyer who closes the page still gets paid. If every helper is down, the swap card lets you collect them yourself with any wallet.', //{chains}: chain names joined with ", "
  helpSafe5: 'Your password, PIN and private keys never leave your device. The offer service only passes signed offers between people.',
  //Help: what is up to you
  helpYouTitle: 'What is up to you',
  helpYou1: 'Coins you receive on the Nexus chain have to be collected by you, with this page or your Nexus wallet. Come back while the swap runs: the page shows how long you have, and the longest a swap waits for you is {most}.', //{most} a duration like "20 min"
  helpYou2: 'Leave the page open, or come back, until a swap says Swapped or Refunded. Closing it does not lose anything that is already locked, but a refund on the Nexus chain waits until you are back.',
  helpYou3: 'Prices are set by people, not by this site. The market price shown next to a price is a guide only.',
  helpYou4: 'Each chain charges its own small network fee for a lock and a collect. The site itself charges nothing.',
  helpYouTestnet: 'This is the test network: the coins here have no value.',
  helpYou5: 'This is new software and its code has not been reviewed by an outside auditor yet. Start with small amounts.',
  //Help: Nexus tokens and contracts
  helpTokensTitle: 'Nexus tokens',
  helpTokensText: 'Trades between NXS and tokens on the Nexus chain do not need any of this. The order lives on the Nexus chain, and taking it pays both sides in one transaction, so there is nothing to wait for.',
  helpCheckTitle: 'Check it yourself',
  helpContractOn: 'Swap contract on {chain}:', //followed by the contract address
} satisfies Record<string, string | Plural>;
