import React from 'react';
import type { Artifact } from '../../shared/types';
export function ArtifactsPanel({ artifacts }: { artifacts: Artifact[] }) {
 return <div className="artifacts" role="tabpanel" id="artifacts-panel" aria-labelledby="artifacts-tab">{!artifacts.length&&<p className="muted empty">暂无产物。失败或取消的任务可能保留部分输出。</p>}{artifacts.map(artifact=><article key={artifact.id}><h3>{artifact.name}</h3><small>{artifact.mediaType} · {artifact.content.length.toLocaleString()} 字符 · 安全文本预览</small><pre>{artifact.content}</pre></article>)}</div>;
}
