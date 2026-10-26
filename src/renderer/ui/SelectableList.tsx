import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { VList, type VListHandle } from 'virtua';
import { selectableListStyles } from './selectable-list-style';

export interface SelectableSection<T> {
  key: string;
  heading?: ReactNode;
  items: T[];
  collapsed?: boolean;
  onToggle?: () => void;
}

export interface SelectableListProps<T> {
  label: string;
  sections: SelectableSection<T>[];
  getKey(item: T): string;
  renderItem(item: T, state: { selected: boolean }): ReactNode;
  selectedKey?: string;
  onSelect(key: string): void;
  empty?: ReactNode;
  virtual?: boolean;
}

type Row<T> =
  | { kind: 'heading'; key: string; section: SelectableSection<T> }
  | { kind: 'item'; key: string; item: T; index: number };

/** How many rows a server render mounts so the static markup stays inspectable. */
export const SELECTABLE_SSR_ROWS = 40;

/**
 * The listbox used by every master pane: one visible active row, ↑/↓/Home/End
 * to move, Enter/Space to select. Sections can fold; virtual lists mount only
 * the rows near the viewport through virtua.
 */
export function SelectableList<T>({
  label,
  sections,
  getKey,
  renderItem,
  selectedKey,
  onSelect,
  empty,
  virtual,
}: SelectableListProps<T>) {
  const id = useId().replaceAll(':', '');
  const items: T[] = [];
  const rows: Row<T>[] = [];
  for (const section of sections) {
    if (section.heading !== undefined || section.onToggle) {
      rows.push({ kind: 'heading', key: `section:${section.key}`, section });
    }
    if (section.collapsed) continue;
    for (const item of section.items) {
      rows.push({ kind: 'item', key: getKey(item), item, index: items.length });
      items.push(item);
    }
  }
  const signature = items.map(getKey).join('\u0000');
  const [activeKey, setActiveKey] = useState<string | undefined>(() => selectedKey ?? (items[0] ? getKey(items[0]) : undefined));
  const activeIndex = Math.max(0, items.findIndex(item => getKey(item) === activeKey));
  const active = items[activeIndex];
  const virtualRef = useRef<VListHandle>(null);
  const keyboard = useRef(false);

  useEffect(() => {
    if (selectedKey && items.some(item => getKey(item) === selectedKey)) setActiveKey(selectedKey);
  }, [selectedKey, signature]);

  useEffect(() => {
    if (!items.length) {
      if (activeKey !== undefined) setActiveKey(undefined);
      return;
    }
    if (!activeKey || !items.some(item => getKey(item) === activeKey)) setActiveKey(getKey(items[0]!));
  }, [activeKey, signature]);

  useEffect(() => {
    if (virtual || !keyboard.current || !active) return;
    keyboard.current = false;
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, active, id, virtual]);

  const optionId = (index: number) => `${id}-option-${index}`;

  const move = (index: number) => {
    if (!items.length) return;
    const bounded = Math.max(0, Math.min(items.length - 1, index));
    const item = items[bounded]!;
    keyboard.current = true;
    setActiveKey(getKey(item));
    if (!virtual) return;
    const row = rows.findIndex(entry => entry.kind === 'item' && entry.index === bounded);
    if (row >= 0) requestAnimationFrame(() => virtualRef.current?.scrollToIndex(row, { align: 'nearest' }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(activeIndex + 1); break;
      case 'ArrowUp': event.preventDefault(); move(activeIndex - 1); break;
      case 'Home': event.preventDefault(); move(0); break;
      case 'End': event.preventDefault(); move(items.length - 1); break;
      case 'Enter':
      case ' ': {
        if (!active) return;
        event.preventDefault();
        onSelect(getKey(active));
        break;
      }
      default: break;
    }
  };

  const heading = (section: SelectableSection<T>) => {
    const content = section.heading ?? null;
    if (!section.onToggle) return <div {...stylex.props(selectableListStyles.heading)}>{content}</div>;
    return <div {...stylex.props(selectableListStyles.heading)}>
      <button
        type="button"
        aria-expanded={!section.collapsed}
        onClick={section.onToggle}
        {...stylex.props(selectableListStyles.headingToggle)}
      >
        {section.collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <span {...stylex.props(selectableListStyles.headingText)}>{content}</span>
      </button>
    </div>;
  };

  const option = (item: T, index: number) => {
    const key = getKey(item);
    const selected = key === selectedKey;
    return <div
      key={key}
      id={optionId(index)}
      role="option"
      aria-selected={selected}
      onClick={() => { setActiveKey(key); onSelect(key); }}
      {...stylex.props(selectableListStyles.option)}
    >
      <div {...stylex.props(selectableListStyles.optionBody)}>{renderItem(item, { selected })}</div>
    </div>;
  };

  const listboxProps = {
    role: 'listbox' as const,
    'aria-label': label,
    'aria-activedescendant': active ? optionId(activeIndex) : undefined,
    tabIndex: 0,
    onKeyDown,
  };

  if (!items.length && sections.every(section => section.heading === undefined && !section.onToggle)) {
    return empty !== undefined ? <div {...stylex.props(selectableListStyles.empty)}>{empty}</div> : null;
  }

  if (virtual) {
    return <VList
      {...listboxProps}
      ref={virtualRef}
      data={rows}
      ssrCount={typeof window === 'undefined' ? SELECTABLE_SSR_ROWS : undefined}
      className={stylex.props(selectableListStyles.list, selectableListStyles.virtualList).className}
    >
      {row => row.kind === 'heading'
        ? <div role="presentation" key={row.key}>{heading(row.section)}</div>
        : option(row.item, row.index)}
    </VList>;
  }

  return <div {...listboxProps} {...stylex.props(selectableListStyles.list)}>
    {rows.map(row => row.kind === 'heading'
      ? <div role="presentation" key={row.key}>{heading(row.section)}</div>
      : option(row.item, row.index))}
  </div>;
}
