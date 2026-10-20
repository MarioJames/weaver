import { compactTime, fullTime, useProjectTimeZone } from '../timezone';

/** The one way a timestamp appears in the UI: compact text in the project time zone, the full time and zone on hover. */
export function TimeText({ value, now, className }: { value: string | null | undefined; now?: number; className?: string }) {
  const zone = useProjectTimeZone();
  const valid = !!value && Number.isFinite(Date.parse(value));
  return <time className={className} dateTime={valid ? value : undefined} title={valid ? fullTime(value, zone) : undefined}>{compactTime(value, now, zone)}</time>;
}
