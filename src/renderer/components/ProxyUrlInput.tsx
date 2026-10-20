import { Input } from '@lobehub/ui/base-ui';
import { proxyUrlError } from '../engine-models';
import { styles } from '../style';

/** The custom proxy address, checked as it is typed with the same rule the server applies on save and on launch. */
export function ProxyUrlInput({ value, onChange }: { value: string; onChange: (proxy: string) => void }) {
  const error = proxyUrlError(value);
  return <div className={styles.tight}>
    <Input aria-label="代理地址" aria-invalid={error ? true : undefined} aria-describedby={error ? 'proxy-url-error' : undefined} value={value} placeholder="http://127.0.0.1:7890" onChange={event => onChange(event.target.value)} />
    {error && <p id="proxy-url-error" role="alert" className={styles.error}>{error}</p>}
  </div>;
}
