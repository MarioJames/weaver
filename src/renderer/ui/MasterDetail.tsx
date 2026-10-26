import { useEffect, useRef, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { masterDetailStyles } from './master-detail-style';

export interface MasterDetailProps {
  list: ReactNode;
  listWidth?: number;
  main: ReactNode;
  inspector?: ReactNode;
  inspectorOpen?: boolean;
  onInspectorClose?: () => void;
  inspectorLabel?: string;
  mobileView?: 'list' | 'main' | 'inspector';
  listLabel: string;
  mainLabel: string;
}

/**
 * The page skeleton: list · main · inspector. Wide screens show all three,
 * laptop widths slide the inspector over the main pane, and narrow screens
 * show exactly the pane `mobileView` names. Every pane owns its scrolling.
 */
export function MasterDetail({
  list,
  listWidth = 320,
  main,
  inspector,
  inspectorOpen,
  onInspectorClose,
  inspectorLabel,
  mobileView = 'list',
  listLabel,
  mainLabel,
}: MasterDetailProps) {
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = useRef(onInspectorClose);
  close.current = onInspectorClose;
  const open = inspector !== undefined && inspectorOpen !== false;
  const overlayOpen = inspector !== undefined && inspectorOpen === true;
  const mobileInspector = overlayOpen && mobileView === 'inspector';
  const mobileMain = mobileView === 'main' || (mobileView === 'inspector' && !mobileInspector);

  useEffect(() => {
    if (!inspectorOpen) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      const target = previousFocus.current;
      previousFocus.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [inspectorOpen]);

  return <div {...stylex.props(masterDetailStyles.root)}>
    <div role="region" aria-label={listLabel} {...stylex.props(masterDetailStyles.list(mobileView === 'list'), masterDetailStyles.listWidth(listWidth))}>{list}</div>
    <div role="region" aria-label={mainLabel} {...stylex.props(masterDetailStyles.main(mobileMain))}>{main}</div>
    {inspector !== undefined && <div
      ref={panel}
      role="region"
      aria-label={inspectorLabel ?? '检查器'}
      tabIndex={-1}
      {...stylex.props(masterDetailStyles.inspector(open, overlayOpen, mobileInspector))}
    >
      <div {...stylex.props(masterDetailStyles.inspectorBody)}>{inspector}</div>
    </div>}
  </div>;
}
