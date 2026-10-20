import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineModelList, EngineModelListInput } from '../../../shared/engines';
import { notifyError } from '../../api/notify';

export const NO_LIST_TEXT = '该引擎不提供模型列表，请手动填写';

/** Asks the control plane for the engine CLI's model list. */
export async function requestEngineModels(input: EngineModelListInput): Promise<EngineModelList> {
  return window.weaver.listEngineModels(input);
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
 * `sync` is called whenever the field's engine may have changed: it fetches once per distinct engine,
 * drops the previous engine's list when the engine changes, and fetches nothing without an engine.
 * `load(true)` is the explicit refresh. Only the newest request of a session may write its result (the generation counter).
 */
export class ModelListSession {
  private generation = 0;
  private engine = '';

  constructor(private readonly sink: ModelListSink, private readonly request: Request = requestEngineModels) {}

  sync(engine: string): void {
    if (engine === this.engine) return;
    this.engine = engine;
    this.generation += 1;
    this.sink.list(undefined);
    this.sink.loading(false);
    if (engine) void this.load();
  }

  async load(refresh = false): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const mine = ++this.generation;
    this.sink.loading(true);
    try {
      const result = await this.request({ engine, ...(refresh ? { refresh: true } : {}) });
      if (this.generation !== mine) return;
      this.sink.list(result);
      if (result.status === 'failed') this.sink.failed(result.message ?? '未获取到模型列表', '模型列表获取失败');
    } catch (error) {
      if (this.generation === mine) this.sink.failed(error, '模型列表获取失败');
    } finally { if (this.generation === mine) this.sink.loading(false); }
  }
}

/**
 * Loads one engine's model list as soon as the field mounts, and again whenever its engine changes; `load(true)` forces a refresh.
 * A failure is reported as a notification; the manual field stays usable whatever happens.
 */
export function useEngineModels(engine: string) {
  const [list, setList] = useState<EngineModelList>();
  const [loading, setLoading] = useState(false);
  const session = useRef<ModelListSession>(undefined);
  session.current ??= new ModelListSession({ list: setList, loading: setLoading, failed: notifyError });
  useEffect(() => { session.current?.sync(engine); }, [engine]);
  const load = useCallback((refresh = false) => session.current!.load(refresh), []);
  return { list, loading, load };
}
