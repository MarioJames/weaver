export async function command<T>(name: string, args: Record<string, unknown>, mutate = false, commandId?: string): Promise<T> {
 if (!window.weaver?.command) throw new Error('控制面不可用。请通过 weaver web 打开这个页面。');
 const response = await window.weaver.command({ apiVersion: 'weaver.v1', command: name, args, ...(mutate ? { commandId: commandId ?? crypto.randomUUID() } : {}) });
 if (!response.ok) throw Object.assign(new Error(`${response.error?.code ?? 'COMMAND_FAILED'}: ${response.error?.message ?? '操作失败'}`), { code: response.error?.code ?? 'COMMAND_FAILED', retryable: response.error?.retryable ?? false });
 return response.data as T;
}
