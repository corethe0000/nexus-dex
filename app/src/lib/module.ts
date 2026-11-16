//the DEX as a module inside the Nexus desktop wallet: the wallet's preload puts NEXUS on window. There the Nexus side
//goes through the wallet's own core (no Nexus node to host) and links open in the system browser.
import { NexusNode, NodeError } from '@nexus-dex/core/src/nexus/node';

declare global {
  interface Window {
    NEXUS?: {
      utilities?: {
        apiCall: (endpoint: string, params?: Record<string, unknown>) => Promise<any>;
        openInBrowser: (url: string) => void;
      };
    };
    dexConfig?: unknown; //config.js of the module build (a module folder opens from file://, where fetch cannot read)
  }
}

//config.json sets "nexusNode": "wallet" for the module: the wallet's core
export const walletCore = 'wallet';

export const inWallet = () => typeof window !== 'undefined' && !!window.NEXUS?.utilities?.apiCall;

//same calls as NexusNode, sent by the wallet to its core (it adds the session on a multi-user core)
export class WalletCoreNode extends NexusNode {
  constructor() {
    super(walletCore);
  }

  override async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await window.NEXUS!.utilities!.apiCall(method, params)) as T;
    } catch (e) {
      const err = e as { code?: number; message?: string } | undefined;
      //the core's own errors come back as {code, message}; anything else (core down, aborted) stays as it is
      if (err && typeof err.code === 'number') {
        throw new NodeError(method, err.code, err.message ?? '');
      }
      throw e instanceof Error ? e : new Error(err?.message ?? String(e));
    }
  }
}

export function nodeFor(url: string): NexusNode {
  if (url === walletCore) {
    if (!inWallet()) {
      throw new Error('This build talks to the Nexus desktop wallet: open it as a wallet module.');
    }
    return new WalletCoreNode();
  }
  return new NexusNode(url);
}

//a webview has no tabs: links that would open a new tab go to the system browser
export function routeLinksOutside() {
  if (!inWallet()) {
    return;
  }
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (a && (a.target === '_blank' || /^https?:/.test(a.getAttribute('href') ?? ''))) {
        e.preventDefault();
        window.NEXUS!.utilities!.openInBrowser(a.href);
      }
    },
    true,
  );
}
