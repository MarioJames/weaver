/// <reference types="vite/client" />
import type { WeaverAPI } from '../shared/types';

declare global {
  interface Window {
    weaver: WeaverAPI;
  }
}

export {};
