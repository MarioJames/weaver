import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { createStaticStyles } from 'antd-style';
import { ActionIcon, Text, Tooltip } from '@lobehub/ui/base-ui';
import { matchModel, modelListView, modelSelectOptions, useEngineModels } from '../engine-models';
import { NamedAutoComplete } from './NamedControls';
import { styles } from '../style';

const pickerStyles = createStaticStyles(({ css, cssVar }) => ({
  /** The list floats over the card below the field: solid, so the card text never shows through it. */
  popup: css`background: ${cssVar.colorBgElevated}; box-shadow: ${cssVar.boxShadowSecondary};`,
}));

/**
 * A model name is typed or picked in one field. Its suggestions are what the engine itself reports (loaded the first time the field opens),
 * the refresh button sits inside the field, and an engine with no list leaves a plain text field.
 */
export function ModelPicker({ engine, proxy, value, onChange, id, placeholder = '例如：gpt-6.1-sol 或 provider/model', label = '模型' }: {
  engine: string; proxy?: string; value: string; onChange: (model: string) => void; id?: string; placeholder?: string; label?: string;
}) {
  const models = useEngineModels(engine, proxy);
  const [open, setOpen] = useState(false);
  const options = modelSelectOptions(models.list);
  const view = modelListView(models.list, models.loading);
  const text = view.kind === 'idle' ? `点开输入框可获取 ${engine || '该引擎'} 的可用模型，也可以直接填写。`
    : view.kind === 'loading' ? '正在获取模型列表…'
      : view.kind === 'ready' ? `${view.count} 个模型 · 来源：${view.source}。也可以直接填写。`
        : view.text;
  const empty = view.kind === 'loading' ? '正在获取模型列表…' : view.kind === 'ready' ? '没有匹配的模型，可直接填写' : undefined;
  return <div className={styles.tight}>
    <NamedAutoComplete id={id} aria-label={label} value={value} placeholder={placeholder} options={options} emptyText={empty} classNames={{ popup: pickerStyles.popup }}
      /* An engine with no list has nothing to suggest: an empty strip would only cover the explanation printed under the field. */
      open={open && (options.length > 0 || Boolean(empty))}
      filter={(item, query) => matchModel(options, query, item as { value: string; label?: unknown })}
      onChange={onChange}
      onOpenChange={next => { setOpen(next); if (next && engine && !models.list && !models.loading) void models.load(); }}
      suffix={view.kind !== 'manual' && <Tooltip title="重新获取模型列表">
        <ActionIcon size="small" icon={RefreshCw} aria-label={`刷新 ${engine} 模型列表`} loading={models.loading} disabled={!engine || models.loading} onClick={() => void models.load(true)} />
      </Tooltip>} />
    <Text type="secondary" className={styles.meta} role="status">{text}</Text>
  </div>;
}
