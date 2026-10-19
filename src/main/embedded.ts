/**
 * What a standalone executable carries inside itself instead of files next to it:
 * the built renderer, and the argument that makes the executable run the mock worker.
 * A source checkout or npm install never sets this.
 */
export interface EmbeddedApp {
  renderer: ReadonlyMap<string, Uint8Array>;
  mockWorkerArg: string;
}

let embedded: EmbeddedApp | undefined;
export function setEmbeddedApp(app: EmbeddedApp): void { embedded = app; }
export function embeddedApp(): EmbeddedApp | undefined { return embedded; }
