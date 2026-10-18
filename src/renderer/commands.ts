export async function command<T>(name: string, args: Record<string, unknown>, mutate = false): Promise<T> {
 if (!window.weaver?.command) throw new Error('当前桌面桥不支持统一接口，请重新构建并启动 Weaver。');
 const response = await window.weaver.command({ apiVersion: 'weaver.v1', command: name, args, ...(mutate ? { commandId: crypto.randomUUID() } : {}) });
 if (!response.ok) throw new Error(`${response.error?.code ?? 'COMMAND_FAILED'}: ${response.error?.message ?? '操作失败'}`);
 return response.data as T;
}
