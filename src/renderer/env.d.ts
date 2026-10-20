/// <reference types="vite/client" />
import type { RendererAPI } from './api/client';

declare global {
  interface Window {
    weaver: RendererAPI;
  }
}

export {};
