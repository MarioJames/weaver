/** A role can inherit the host proxy, connect directly, or use its own proxy. */
export function validateProxy(value?: string): void {
  if (value === undefined || value === 'inherit' || value === 'direct') return;
  if (typeof value !== 'string' || value.length > 2000 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('代理必须为 inherit、direct 或 HTTP(S) URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('代理地址必须是完整的 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('代理仅支持不含凭据、路径或查询参数的 HTTP(S) URL');
}

export function proxyEnvironment(source: Record<string, string | undefined>, proxy?: string): Record<string, string | undefined> {
  validateProxy(proxy);
  const env = { ...source };
  if (!proxy || proxy === 'inherit') return env;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[key];
  if (proxy !== 'direct') {
    env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxy;
    env.NODE_USE_ENV_PROXY = '1';
  }
  return env;
}
