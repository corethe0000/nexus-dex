//names and decimals of Nexus tokens ('0' = NXS): the site's own list as it gives them, any other token read once
//from the node. Anyone can create a Nexus token and name it, so one the site does not list carries the start of
//its address in its ticker (a token called "NXS" never shows as plain NXS) and listed: false
import type { NexusNode } from '@nexus-dex/core/src/nexus/node';

export interface NexusToken {
  ticker: string;
  decimals: number;
  listed: boolean;
}

const nxs: NexusToken = { ticker: 'NXS', decimals: 6, listed: true };

export class TokenNames {
  private known = new Map<string, NexusToken>([['0', nxs]]);
  private asking = new Map<string, Promise<void>>();

  constructor(
    private node: NexusNode,
    listed: { token: string; ticker: string; decimals: number }[] = [],
  ) {
    for (const t of listed) {
      if (t.token !== '0') {
        this.known.set(t.token, { ticker: t.ticker, decimals: t.decimals, listed: true });
      }
    }
  }

  //null until read; call again after `ready`
  get(token: string): NexusToken | null {
    return this.known.get(token) ?? null;
  }

  ready(token: string): Promise<void> {
    if (this.known.has(token)) {
      return Promise.resolve();
    }
    let p = this.asking.get(token);
    if (!p) {
      p = this.node
        .call<any>('register/get/any', { address: token })
        .then((t) => {
          const name = String(t.ticker ?? t.name ?? 'token').slice(0, 16);
          this.known.set(token, { ticker: `${name} (${token.slice(0, 6)})`, decimals: Number(t.decimals ?? 0), listed: false });
        })
        .catch(() => {
          this.asking.delete(token);
        });
      this.asking.set(token, p);
    }
    return p;
  }
}
