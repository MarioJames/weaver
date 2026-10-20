import { useId } from 'react';
import { Field } from '@base-ui/react/field';
import { AutoComplete, InputNumber, Select, Switch, type AutoCompleteProps, type InputNumberProps, type SelectProps, type SwitchProps } from '@lobehub/ui/base-ui';
import { styles } from '../style';

type Named = { 'aria-label': string };

// These installed Lobe controls support id, but do not forward aria-label to
// their interactive element. Native labels use that supported id contract.
// A supplied id links the visible Form.Field label; standalone controls get a
// generated id and a visually hidden label.
export function NamedInputNumber({ 'aria-label': label, id: suppliedId, ...props }: InputNumberProps & Named) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <>{!suppliedId && <label className={styles.srOnly} htmlFor={id}>{label}</label>}<InputNumber {...props} id={id} /></>;
}

export function NamedSwitch({ 'aria-label': label, id: suppliedId, ...props }: SwitchProps & Named) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <>{!suppliedId && <label className={styles.srOnly} htmlFor={id}>{label}</label>}<Switch {...props} id={id} /></>;
}

export function NamedSelect({ 'aria-label': label, id: suppliedId, ...props }: SelectProps & Named) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  if (props.mode === 'tags') {
    // Tags uses a non-labelable div trigger plus an input with no input-props
    // slot. Base UI's field context names the trigger; the native wrapping
    // label names the editable input without querying or mutating library DOM.
    return <Field.Root><Field.Label nativeLabel={false} render={<span />} className={styles.srOnly}>{label}</Field.Label><label><span className={styles.srOnly}>{label}</span><Select {...props} id={id} /></label></Field.Root>;
  }
  return <>{!suppliedId && <label className={styles.srOnly} htmlFor={id}>{label}</label>}<Select {...props} id={id} /></>;
}

/** A text field with a suggestion list. The id reaches the native input, so the native label names it. */
export function NamedAutoComplete({ 'aria-label': label, id: suppliedId, ...props }: AutoCompleteProps & Named) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <>{!suppliedId && <label className={styles.srOnly} htmlFor={id}>{label}</label>}<AutoComplete {...props} id={id} /></>;
}
