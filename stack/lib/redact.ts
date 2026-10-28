// stack/lib/redact.ts — masking secrets in what leaves the box's processes.
//
// stack-status runs every string of the documents it publishes through redact()
// and then refuses one that leaks() still finds a secret in (CLAUDE.md trap 19).
// stack-api runs its answers through the same redact(), because an app's error
// message can carry a URL with a key in it. Literal secrets (from .env, the
// apps' own key files, Plex's token) are masked first, then token, key and
// password shapes by pattern.

export const REDACTED = '‹redacted›';

// The shapes that carry a secret, masked after the literal ones, in this order.
// Each keeps its `k` group and replaces what follows; a URL's user:password@
// keeps its @.
const SHAPES: readonly [RegExp, string][] = [
  [/(?<k>x-plex-token[=:]\s*)[^&\s"'<>]+/gi, `$<k>${REDACTED}`],
  [/(?<k>plexonlinetoken=")[^"]*/gi, `$<k>${REDACTED}`],
  [
    /(?<k>(api[_-]?key|access[_-]?token|token|passw(or)?d|pwd|secret)["']?\s*[:=]\s*["']?)[^&\s"',;<>]+/gi,
    `$<k>${REDACTED}`,
  ],
  [/(?<k>authorization:\s*)\S+(\s+[^\s,;]+)?/gi, `$<k>${REDACTED}`],
  [/(?<k>temporary password is provided for this session:\s*)\S+/gi, `$<k>${REDACTED}`],
  [/(?<k>:\/\/)[^/\s:@]+:[^/\s@]+@/g, `$<k>${REDACTED}@`],
  [/(?<k>\bSID=)[^;\s]+/g, `$<k>${REDACTED}`],
  [/(?<k>\bcookie:\s*).+/gi, `$<k>${REDACTED}`],
];

/** The masking of one string: literal secrets first, then the shapes. */
export function mask(s: string, secrets: readonly string[]): string {
  let r = s;
  for (const x of secrets) if (r.includes(x)) r = r.split(x).join(REDACTED);
  for (const [re, keep] of SHAPES) r = r.replace(re, keep);
  return r;
}

/** Every string in a document masked; keys and other values kept. */
export function redact(doc: unknown, secrets: readonly string[]): unknown {
  if (typeof doc === 'string') return mask(doc, secrets);
  if (Array.isArray(doc)) return doc.map((x) => redact(x, secrets));
  if (doc !== null && typeof doc === 'object')
    return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, redact(v, secrets)]));
  return doc;
}

/** How many secrets are still in a text (0 = safe to publish): grep -F -o's count. */
export function leaks(text: string, secrets: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < text.length;) {
    let best = -1;
    let len = 0;
    for (const x of secrets) {
      const j = text.indexOf(x, i);
      if (j !== -1 && (best === -1 || j < best || (j === best && x.length > len))) {
        best = j;
        len = x.length;
      }
    }
    if (best === -1) break;
    n++;
    i = best + len;
  }
  return n;
}
