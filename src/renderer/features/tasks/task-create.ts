/** The composer's two submit paths. Both create and select the record; only 创建并开始 also asks the parent Agent to start. */
export async function createTask<Input>(input: Input, start: boolean, api: {
  create: (input: Input) => Promise<{ id: string }>;
  start: (id: string) => Promise<unknown>;
  select: (id: string) => void;
  /** The record exists; only its launch failed, so recovery retries the start and never creates a second task. */
  startFailed: (id: string, error: unknown) => void;
}): Promise<string> {
  const created = await api.create(input);
  api.select(created.id);
  if (!start) return created.id;
  try { await api.start(created.id); } catch (error) { api.startFailed(created.id, error); }
  return created.id;
}
