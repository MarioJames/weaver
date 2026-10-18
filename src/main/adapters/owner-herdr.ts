import type { OwnerRef } from '../../shared/types';
/** Owners remain in the user's visible Herdr session. Never creates sessions or worker panes. */
export interface OwnerTransport { readonly available: boolean; send(owner: OwnerRef, message: string): Promise<void> }
export class HerdrOwnerAdapter implements OwnerTransport {
 readonly available = false;
 async send(_owner: OwnerRef, _message: string): Promise<void> {
  throw new Error('Automatic Herdr owner messaging is not implemented. Use the existing visible owner session and manual task import.');
 }
}
