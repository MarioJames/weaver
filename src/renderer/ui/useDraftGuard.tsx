import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from '@lobehub/ui';

export interface DraftGuard {
  guard(next: () => void): void;
  dialog: ReactNode;
}

/**
 * Protects a draft: a destructive navigation asks first, and a dirty page warns
 * on close. When nothing is dirty the guard runs immediately.
 */
export function useDraftGuard(dirty: boolean): DraftGuard {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const pending = useRef<(() => void) | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!dirty) setOpen(false);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const guard = useCallback((next: () => void) => {
    if (!dirtyRef.current) {
      next();
      return;
    }
    pending.current = next;
    setOpen(true);
  }, []);

  const cancel = () => {
    pending.current = undefined;
    setOpen(false);
  };

  const discard = () => {
    const next = pending.current;
    pending.current = undefined;
    setOpen(false);
    next?.();
  };

  const dialog = <Modal
    open={open}
    title="放弃未保存的修改？"
    width={440}
    onCancel={cancel}
    footer={<>
      <Button htmlType="button" onClick={cancel}>取消</Button>
      <Button htmlType="button" danger type="primary" onClick={discard}>放弃修改</Button>
    </>}
  >
    离开后这次修改不会保存。
  </Modal>;

  return { guard, dialog };
}
