//a link to one offer, for a maker to share: ?net=testnet&offer=0x... Opening it puts the page on that network (kept
//as the choice, like the network switch) in the simple ticket with that offer picked. Read once at start; the address
//bar is cleaned so a reload does not pick it again.
import type { NetId, Prefs } from './prefs';

const hexId = /^0x[0-9a-fA-F]{64}$/;
let pending: string | null = null;

export function offerLink(net: NetId, id: string): string {
  return `${window.location.origin}${window.location.pathname}?net=${net}&offer=${id}`;
}

//the stored choices with what a link asks for; remembers the offer for the ticket
export function withLink(p: Prefs): Prefs {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(window.location.search);
  } catch {
    return p;
  }
  const id = q.get('offer');
  if (!id || !hexId.test(id)) {
    return p;
  }
  pending = id.toLowerCase();
  const net = q.get('net');
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  } catch {
    //some embedded views refuse it: the link stays in the bar, harmless
  }
  return { ...p, net: net === 'testnet' || net === 'mainnet' ? net : p.net, mode: 'simple', venue: 'stable' };
}

//the offer a link asked for, once
export function takeLinkedOffer(): string | null {
  const id = pending;
  pending = null;
  return id;
}
