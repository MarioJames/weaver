/** Strict field and text checks shared by the policy store and the route preview. */
export function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(key=>!keys.includes(key))) throw new Error('Unknown policy field'); }
export function text(value: unknown, label: string): string { if(typeof value!=='string'||!value.trim()||value.length>2000) throw new Error(`Invalid ${label}`); return value; }
