import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineModelList, EngineModelListInput } from '../main/engines/models';
import { validateProxy } from '../shared/proxy';
import { notifyError } from './notify';

export type { EngineModelList } from '../main/engines/models';
export const NO_LIST_TEXT = '该引擎不提供模型列表，请手动填写';
const OLD_CONTROL_PLANE_TEXT = '当前控制面不支持模型列表，请手动填写';

type ListModels = (input: EngineModelListInput) => Promise<EngineModelList>;

/**
 * `listEngineModels` is an optional control-plane capability: a control plane without it answers
 * with the manual-entry fallback instead of failing, the same way `getStall` degrades.
 */
export async function requestEngineModels(input: EngineModelListInput): Promise<EngineModelList> {
  const list = (window.weaver as unknown as { listEngineModels?: ListModels } | undefined)?.listEngineModels;
  if (!list) return { engine: input.engine, status: 'unsupported', source: '', models: [], message: OLD_CONTROL_PLANE_TEXT, fetchedAt: new Date().toISOString() };
  return list(input);
}

/** A proxy the form has not finished typing cannot be sent; the list then goes out without it. */
export function usableProxy(proxy: string | undefined): string | undefined {
  try { validateProxy(proxy); return proxy; } catch { return undefined; }
}

export type ModelListView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; count: number; source: string }
  | { kind: 'manual'; text: string }
  | { kind: 'failed'; text: string };

/** What the line under a model field says about the list. Only a failed command is an error; no list command is a plain fact. */
export function modelListView(list: EngineModelList | undefined, loading: boolean): ModelListView {
  if (loading) return { kind: 'loading' };
  if (!list) return { kind: 'idle' };
  if (list.status === 'ok') return { kind: 'ready', count: list.models.length, source: list.source };
  if (list.status === 'failed') return { kind: 'failed', text: list.message ?? '未获取到模型列表，请手动填写' };
  return { kind: 'manual', text: list.message ?? NO_LIST_TEXT };
}

/** The picker options for a list; a value already typed that is not in the list stays out so the select shows nothing selected. */
export function modelSelectOptions(list: EngineModelList | undefined): Array<{ value: string; label: string }> {
  return (list?.models ?? []).map(model => ({ value: model.id, label: model.label && model.label !== model.id ? `${model.id} · ${model.label}` : model.id }));
}

/**
 * The suggestions for the text typed so far. A field that already holds a complete model name (or nothing) offers the whole list so another one can be picked;
 * a partial text narrows it to the names containing that text.
 */
export function matchModel(options: ReadonlyArray<{ value: string; label?: unknown }>, query: string, item: { value: string; label?: unknown }): boolean {
  const text = query.trim().toLowerCase();
  if (!text || options.some(option => option.value.toLowerCase() === text)) return true;
  return item.value.toLowerCase().includes(text) || (typeof item.label === 'string' && item.label.toLowerCase().includes(text));
}

type Request = (input: EngineModelListInput) => Promise<EngineModelList>;

/** What a session reports back to its owner; the hook maps these onto React state. */
export interface ModelListSink {
  list(list: EngineModelList | undefined): void;
  loading(loading: boolean): void;
  failed(message: unknown, title: string): void;
}

/**
 * One model field's loading state, free of React so the rules can be tested directly.
 * `sync` is called whenever the field's engine or proxy may have changed: it fetches once per distinct engine + proxy,
 * drops the previous engine's list when the engine changes, and fetches nothing without an engine.
 * `load(true)` is the explicit refresh. Only the newest request of a session may write its result (the generation counter).
 */
export class ModelListSession {
  private generation = 0;
  private engine = '';
  private proxy: string | undefined;
  private key = '';

  constructor(private readonly sink: ModelListSink, private readonly request: Request = requestEngineModels) {}

  sync(engine: string, proxy?: string): void {
    const engineChanged = engine !== this.engine;
    // A proxy address still being typed is not sent; the list stays as it is until the address is complete.
    if (!engineChanged && proxy && usableProxy(proxy) === undefined) return;
    this.engine = engine;
    this.proxy = proxy;
    const key = engine ? `${engine}\n${usableProxy(proxy) ?? ''}` : '';
    if (key === this.key && !engineChanged) return;
    this.key = key;
    if (engineChanged) { this.generation += 1; this.sink.list(undefined); this.sink.loading(false); }
    if (engine) void this.load();
  }

  async load(refresh = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const mine = ++this.generation;
    this.sink.loading(true);
    try {
      const proxyValue = usableProxy(this.proxy);
      const result = await this.request({ engine, ...(proxyValue ? { proxy: proxyValue } : {}), ...(refresh ? { refresh: true } : {}) });
      if (this.generation !== mine) return;
      this.sink.list(result);
      if (result.status === 'failed') this.sink.failed(result.message ?? '未获取到模型列表', '模型列表获取失败');
    } catch (error) {
      if (this.generation === mine) this.sink.failed(error, '模型列表获取失败');
    } finally { if (this.generation === mine) this.sink.loading(false); }
  }
}

/**
 * Loads one engine's model list as soon as the field mounts, and again whenever its engine or proxy changes; `load(true)` forces a refresh.
 * A failure is reported as a notification; the manual field stays usable whatever happens.
 */
export function useEngineModels(engine: string, proxy?: string) {
  const [list, setList] = useState<EngineModelList>();
  const [loading, setLoading] = useState(false);
  const session = useRef<ModelListSession>(undefined);
  session.current ??= new ModelListSession({ list: setList, loading: setLoading, failed: notifyError });
  useEffect(() => { session.current?.sync(engine, proxy); }, [engine, proxy]);
  const load = useCallback((refresh = false) => session.current!.load(refresh), []);
  return { list, loading, load };
}

/** The first reason a custom proxy address is refused, in the words the form shows under the field; empty when it is acceptable. */
export function proxyUrlError(value: string): string {
  const text = value.trim();
  if (!text) return '请填写代理地址，例如 http://127.0.0.1:7890';
  if (text !== value) return '代理地址首尾不能有空白';
  try { validateProxy(value); return ''; } catch { /* the specific reason is worked out below */ }
  if (/\s/.test(value)) return '代理地址不能包含空白字符';
  let url: URL;
  try { url = new URL(value); } catch { return '代理地址必须是完整的 URL，例如 http://127.0.0.1:7890'; }
  if (!['http:', 'https:'].includes(url.protocol)) return '代理仅支持 http:// 或 https:// 协议';
  if (url.username || url.password) return '代理地址不能带用户名或密码';
  if (url.search || url.hash || url.pathname !== '/') return '代理地址不能带路径或查询参数';
  return '代理地址无效';
}
