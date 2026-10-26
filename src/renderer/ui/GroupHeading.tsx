import * as stylex from '@stylexjs/stylex';
import { groupHeadingStyles } from './group-heading-style';

export interface GroupHeadingProps {
  label: string;
  count?: number;
  /** Full text on hover, such as a complete working directory. */
  title?: string;
}

/** A quiet group heading: name, count, and the full path on hover. */
export function GroupHeading({ label, count, title }: GroupHeadingProps) {
  return <div title={title ?? label} {...stylex.props(groupHeadingStyles.root)}>
    <span {...stylex.props(groupHeadingStyles.label)}>{label}</span>
    {count !== undefined && <span {...stylex.props(groupHeadingStyles.count)}>{count}</span>}
  </div>;
}
