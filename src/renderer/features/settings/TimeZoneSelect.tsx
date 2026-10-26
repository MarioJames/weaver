import { useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { browserTimeZone, listTimeZones, zoneOptionLabel } from '../../format/timezone';
import { NamedSelect } from '../../ui/NamedControls';
import { settingsStyles } from './settings-style';

/** The "follow the browser" entry carries no zone name; a real IANA name can never equal it. */
export const FOLLOW_BROWSER = '__browser__';

/** Options of the project time zone picker: follow-the-browser first, then every IANA zone with its current UTC offset. */
export function timeZoneOptions(selected: string | undefined, at: number = Date.now(), browser: string = browserTimeZone()): { value: string; label: string }[] {
  return [
    { value: FOLLOW_BROWSER, label: `跟随浏览器（当前：${browser}）` },
    ...listTimeZones([selected]).map(zone => ({ value: zone, label: zoneOptionLabel(zone, at) })),
  ];
}

/** Searchable zone picker; `value` undefined means "follow the browser" and `onChange(undefined)` clears the setting. */
export function TimeZoneSelect({ id, value, disabled, onChange }: { id?: string; value?: string; disabled?: boolean; onChange: (zone: string | undefined) => void }) {
  const options = useMemo(() => timeZoneOptions(value), [value]);
  return <NamedSelect id={id} aria-label="项目时区" showSearch disabled={disabled} className={stylex.props(settingsStyles.timezoneSelect).className} popupMatchSelectWidth
    value={value ?? FOLLOW_BROWSER} options={options} listHeight={320}
    onChange={next => { if (typeof next === 'string') onChange(next === FOLLOW_BROWSER ? undefined : next); }} />;
}
