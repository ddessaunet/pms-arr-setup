// DOM helpers shared by the dashboard's client scripts (status-client.ts,
// logs-client.ts).

export const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
export const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
