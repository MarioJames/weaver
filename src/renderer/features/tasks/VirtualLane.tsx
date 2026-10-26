import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Virtualizer } from 'virtua';
import { taskStyles } from './task-style';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
/** A server render has no viewport to measure; it mounts this many rows so static markup stays readable. */
export const SSR_ROWS = 40;
/** Cards are tall; render a few screens-worth beyond the edges so a quick wheel flick does not show blank. */
const BUFFER_PX = 600;

/**
 * The shell's content area is the page scroller (`#root main` in style.css). The board's own
 * lane grid also reads as "auto" for overflow-y because it scrolls sideways, so a generic
 * nearest-scroller walk would pick it; the content area is named instead.
 */
function scrollParent(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>('main') ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * A long run of rows that mounts only what is near the viewport. It keeps riding the page's own
 * scroll (no inner scrollbar, same look), so it tells the virtualizer how far down the page it starts.
 * Row heights are measured, not assumed; the selected row and the one under keyboard focus (with its
 * neighbours) stay mounted so Tab and the open record survive scrolling away.
 */
export function VirtualLane<T>({ rows, rowKey, rowKind, pinned = [], children }: { rows: readonly T[]; rowKey: (row: T) => string; rowKind: (row: T) => string; pinned?: readonly number[]; children: (row: T, index: number) => ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);
  const [margin, setMargin] = useState(0);
  const [focused, setFocused] = useState(-1);
  useIsomorphicLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const parent = scrollParent(element);
    scroller.current = parent;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
      setMargin(current => current === next ? current : next);
    };
    measure();
    setReady(true);
    parent.addEventListener('scroll', measure, { passive: true });
    if (typeof ResizeObserver === 'undefined') return () => parent.removeEventListener('scroll', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(element);
    if (parent.firstElementChild) observer.observe(parent.firstElementChild);
    return () => { observer.disconnect(); parent.removeEventListener('scroll', measure); };
  }, []);
  const keep = [...new Set([...pinned, focused - 1, focused, focused + 1])].filter(index => index >= 0 && index < rows.length);
  const server = typeof window === 'undefined';
  return <div ref={anchor} {...stylex.props(taskStyles.lane)}>
    {(ready || server) && <Virtualizer data={rows} scrollRef={scroller} startMargin={margin} keepMounted={keep} ssrCount={server ? SSR_ROWS : undefined} bufferSize={BUFFER_PX}>
      {(row, index) => <div key={rowKey(row)} {...stylex.props(taskStyles.laneRow)} data-row={rowKind(row)} onFocus={() => setFocused(index)}>{children(row, index)}</div>}
    </Virtualizer>}
  </div>;
}
