import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import { ActionIcon, Text, Tooltip } from '@lobehub/ui';
import type { EngineModelList } from '../../../shared/engines';
import { matchModel, missingModelWarning, modelListView, modelSelectOptions, useEngineModels } from './engine-models';
import { NamedAutoComplete } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';

const pickerStyles = stylex.create({
  /** The list floats over the card below the field: solid, so the card text never shows through it. */
  popup: { backgroundColor: cssVar.colorBgElevated, boxShadow: cssVar.boxShadowSecondary },
  warn: { fontSize: 12, color: cssVar.colorWarningText },
});

/** Under the field: the saved model is not among the models the engine reports now. Warns only; the value stays editable and savable. */
export function ModelListWarning({ engine, value, list }: { engine: string; value: string; list: EngineModelList | undefined }) {
  const text = missingModelWarning(engine, value, list);
  return text ? <Text className={stylex.props(pickerStyles.warn).className} role="status">{text}</Text> : null;
}

/**
 * A model name is typed or picked in one field. Its suggestions are what the engine itself reports (fetched when the field appears and whenever its engine changes),
 * the refresh button sits inside the field, and an engine with no list leaves a plain text field.
 */
export function ModelPicker({ engine, channel, kind, value, onChange, id, placeholder = '例如：gpt-6.1-sol 或 provider/model', label = '模型' }: {
  engine: string; channel?: string; kind?: string; value: string; onChange: (model: string) => void; id?: string; placeholder?: string; label?: string;
}) {
  const models = useEngineModels(engine, channel);
  const [open, setOpen] = useState(false);
  const options = modelSelectOptions(models.list);
  const view = modelListView(models.list, models.loading);
  const text = view.kind === 'idle' ? (engine ? `正在获取 ${engine} 的可用模型…` : '选择渠道后自动获取可用模型，也可以直接填写。')
    : view.kind === 'loading' ? '正在获取模型列表…'
      : view.kind === 'ready' ? `${view.count} 个模型 · 来源：${view.source}。也可以直接填写。`
        : view.text;
  const empty = view.kind === 'loading' ? '正在获取模型列表…' : view.kind === 'ready' ? '没有匹配的模型，可直接填写' : undefined;
  return <div {...stylex.props(styles.tight)}>
    <NamedAutoComplete id={id} aria-label={label} value={value} placeholder={placeholder} options={options} emptyText={empty} classNames={{ popup: stylex.props(pickerStyles.popup).className }}
      /* An engine with no list has nothing to suggest: an empty strip would only cover the explanation printed under the field. */
      open={open && (options.length > 0 || Boolean(empty))}
      filter={(item, query) => matchModel(options, query, item as { value: string; label?: unknown })}
      onChange={onChange}
      onOpenChange={setOpen}
      suffix={view.kind !== 'manual' && <Tooltip title="重新获取模型列表">
        <ActionIcon size="small" icon={RefreshCw} aria-label={`刷新 ${engine} 模型列表`} loading={models.loading} disabled={!engine || models.loading} onClick={() => void models.load(true)} />
      </Tooltip>} />
    <Text type="secondary" className={stylex.props(styles.meta).className} role="status">{text}</Text>
    <ModelListWarning engine={kind ?? engine} value={value} list={models.list} />
  </div>;
}
