import * as stylex from '@stylexjs/stylex';
import { Icon, Tag } from '@lobehub/ui';
import { Loader2 } from 'lucide-react';
import { DISPLAY_LABELS, DISPLAY_TONES, type DisplayStatus } from '../format/status-colors';
import { statusTagColor } from '../format/tag-colors';
import { statusBadgeStyles } from './status-badge-style';

export interface StatusBadgeProps {
  status: DisplayStatus;
  variant?: 'dot' | 'tag';
}

const spinning = (status: DisplayStatus) => status === 'running' || status === 'cancelling';

/** The one task status renderer: a quiet dot in lists, a solid tag in inspector headers. */
export function StatusBadge({ status, variant = 'dot' }: StatusBadgeProps) {
  const tone = DISPLAY_TONES[status];
  const label = DISPLAY_LABELS[status];
  const spin = spinning(status);
  if (variant === 'tag') {
    return <Tag
      variant="solid"
      color={statusTagColor(tone)}
      icon={spin ? <Icon icon={Loader2} spin size="small" /> : undefined}
    >{label}</Tag>;
  }
  return <span {...stylex.props(statusBadgeStyles.dotBadge)}>
    <span data-tone={tone} aria-hidden="true" {...stylex.props(statusBadgeStyles.dot)}></span>
    {spin && <Icon icon={Loader2} spin size="small" />}
    <span {...stylex.props(statusBadgeStyles.label)}>{label}</span>
  </span>;
}
