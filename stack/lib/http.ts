// stack/lib/http.ts — one HTTP request, with curl's habits: the one place that fetches.
//
//   - The timeout covers the whole exchange, body included, like curl's
//     --max-time: AbortSignal.timeout stays on the request while the body is read.
//   - Nothing throws. A refused connection, a DNS failure or a timeout is
//     status 0, the `000` the bash scripts test for, with the reason in `error`.
//   - Redirects are not followed unless asked: the Servarr login is judged by
//     where it redirects to.
//   - No cookie jar. A caller that needs a session (qBittorrent) keeps the
//     cookie itself, and sends credentials in the body, never in the URL.
//
// Scripts get an Http from makeHttp(); tests pass a fake fetch to it.

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  /** A string is sent as is; URLSearchParams as a form. */
  body?: string | URLSearchParams;
  timeoutMs: number;
  redirect?: 'manual' | 'follow';
}

export interface HttpResponse {
  /** 0 when there was no complete answer. */
  status: number;
  text: string;
  headers: Headers;
  /** Why status is 0. */
  error?: string;
}

export type Http = (url: string, req: HttpRequest) => Promise<HttpResponse>;
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export function makeHttp(fetchFn: FetchFn = fetch): Http {
  return async (url, req) => {
    try {
      const res = await fetchFn(url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        redirect: req.redirect ?? 'manual',
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      const text = await res.text();
      return { status: res.status, text, headers: res.headers };
    } catch (e) {
      return { status: 0, text: '', headers: new Headers(), error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** The body as JSON, or undefined when it is not JSON. */
export function jsonOf(res: Pick<HttpResponse, 'text'>): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    return undefined;
  }
}

export const is2xx = (status: number) => status >= 200 && status < 300;

/** A status as curl's %{http_code} prints it, for log lines: 0 is `000`. */
export const httpCode = (status: number) => String(status).padStart(3, '0');
