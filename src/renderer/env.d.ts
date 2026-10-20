/// <reference types="vite/client" />
import type { RendererAPI } from './client';

declare global {
  interface Window {
    weaver: RendererAPI;
  }
}

export {};
