import type { EngineModelList, EngineModelListInput } from '../../shared/engines';

/** Resolves to a Chinese configuration error, or undefined when pi offers the exact `provider/model`. */
export type PiModelCheck = (model: string) => Promise<string | undefined>;

/** Only what the check needs from EngineModelLister, so tests lend a fake `pi --list-models`. */
export interface PiModelSource { list(input: EngineModelListInput): Promise<EngineModelList> }

/** A cached answer younger than this is trusted as is; an older one is refreshed once before a model is declared missing. */
const FRESH_MS = 5_000;

export function missingPiModelMessage(model: string, available: readonly string[]): string {
  const shown = available.slice(0, 20).join('、');
  const more = available.length > 20 ? ` 等 ${available.length} 个` : '';
  return `pi 当前没有模型 ${model}（可用：${shown}${more}），可能已在 cc-switch 中切换了供应商；请在子 Agent 配置中改选模型`;
}

/**
 * Before a pi run (task, connectivity hello, free-channel probe) the configured `provider/model` must be in `pi --list-models`.
 * cc-switch rewrites ~/.pi/agent/models.json when the provider is switched, so a saved id can silently stop existing and pi
 * then exits with a bare "Model not found". The list itself is cached by EngineModelLister (60 s); a miss on an older cached
 * list is re-read once so switching the provider back works immediately. A failing list is never taken as "model exists".
 * This is a configuration error: it is not a vendor limit and writes no block.
 */
export function createPiModelCheck(source: PiModelSource, now: () => number = Date.now): PiModelCheck {
  const read = (refresh: boolean) => source.list({ engine: 'pi', ...(refresh ? { refresh: true } : {}) });
  return async model => {
    let list = await read(false);
    if (list.status === 'ok' && !list.models.some(item => item.id === model) && now() - Date.parse(list.fetchedAt) > FRESH_MS) list = await read(true);
    if (list.status !== 'ok') return `无法确认 pi 是否提供模型 ${model}：${list.message ?? `${list.source} 失败`}，未启动 pi`;
    if (list.models.some(item => item.id === model)) return undefined;
    return missingPiModelMessage(model, list.models.map(item => item.id));
  };
}
