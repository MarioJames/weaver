import { useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, Checkbox, Input, Modal, Text } from '@lobehub/ui';
import { Form, useForm } from '@lobehub/ui/form';
import { NamedSelect } from '../../ui/NamedControls';
import { styles } from '../../ui/styles';
import { resourceStyles } from '../../ui/resource-style';

/** The import dialog only shapes one-time input; its receipt is reported through a toast. */
export function ChannelImportModal({ open, busy, revision, engineOptions, sourceDir, importEngine, replaceExisting, onSource, onEngine, onReplace, onCancel, onImport }: { open: boolean; busy: string; revision: number | undefined; engineOptions: { value: string; label: string }[]; sourceDir: string; importEngine: string; replaceExisting: boolean; onSource: (value: string) => void; onEngine: (value: string) => void; onReplace: (value: boolean) => void; onCancel: () => void; onImport: () => void }) {
  return <Modal className={stylex.props(resourceStyles.modal).className} classNames={{ body: stylex.props(resourceStyles.modalBody).className, footer: stylex.props(resourceStyles.modalFooter).className }} draggable={false} open={open} title="导入原生账号与 API 配置" okText="导入" cancelText="取消" confirmLoading={busy === 'import'} okButtonProps={{ disabled: !!busy || revision === undefined || (!!sourceDir.trim() && importEngine === 'all') }} maskClosable={!busy} keyboard={!busy} onCancel={onCancel} onOk={onImport}>
    <ImportForm engine={importEngine} engines={engineOptions} sourceDir={sourceDir} replaceExisting={replaceExisting} onReplace={onReplace} onEngine={onEngine} onSource={onSource} busy={!!busy} />
  </Modal>;
}

function ImportForm({ engine, engines, sourceDir, replaceExisting, onReplace, onEngine, onSource, busy }: { engine: string; engines: { value: string; label: string }[]; sourceDir: string; replaceExisting: boolean; onReplace: (value: boolean) => void; onEngine: (value: string) => void; onSource: (value: string) => void; busy: boolean }) {
  const form = useForm(); const id = useId();
  return <Form form={form} layout="vertical" className={stylex.props(styles.stack).className} data-channels-scroll="">
    <Form.Field label="导入引擎"><NamedSelect id={`${id}-engine`} aria-label="执行引擎" value={engine} disabled={busy} options={[{ value: 'all', label: '所有已有引擎配置' }, ...engines]} onChange={value => onEngine(String(value))} /></Form.Field>
    <Form.Field label="来源配置目录" extra="选择 Weaver 所在机器的原生 CLI 配置根；指定目录时请先选择对应引擎。留空使用默认位置，只复制必要配置与认证，不修改来源。"><Input id={`${id}-source`} value={sourceDir} disabled={busy} onChange={event => onSource(event.target.value)} placeholder="可选，例如 /home/user/.codex" /></Form.Field>
    <Checkbox checked={replaceExisting} disabled={busy} onChange={checked => onReplace(checked === true)}>更新已导入的配置与认证</Checkbox>
    <Text type="secondary" className={stylex.props(styles.meta, styles.wrap).className}>默认保留已有托管凭据，同一来源不会创建重复渠道。勾选后替换新启动使用的配置与认证；已有进程继续使用旧凭据根，名称、启停及角色选择保留。平台 keychain 或不支持的认证格式需在托管根重新登录。</Text>
  </Form>;
}
