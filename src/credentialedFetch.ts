/**
 * A request whose headers may name secrets, sent so that each secret reaches
 * only the hosts its audience allows — the first one and every one a redirect
 * leads to.
 *
 * `fetch` follows redirects on its own and re-sends the headers it was given,
 * which were resolved for the address first called. It withholds
 * `Authorization` from another origin, and nothing else: a secret in any other
 * header would travel to wherever the first host pointed. So redirects are
 * followed here instead, and the headers are resolved again for each hop.
 *
 * A header that may not go to the next hop is left out and the request goes on
 * without it, rather than being refused. A host that takes a token and answers
 * with a redirect to storage — a signed URL, which must not be sent the token —
 * is the ordinary case of a credentialed download. Once left out, a header
 * stays out for the rest of the chain, as it does in `fetch`.
 */
import { SecretVault, resolveCredential } from "./secrets";

/** How many redirects one request follows before it is given up. */
const MAX_REDIRECTS = 10;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** What `fetch` itself withholds from a redirect to another origin. */
const ORIGIN_BOUND = new Set(["authorization", "cookie", "proxy-authorization"]);

/** What describes a body, and goes when a redirect drops the body. */
const BODY_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
]);

export type CredentialedRequest = {
  method?: string;
  /** As configured: a value may name secrets, or be a literal. */
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
};

/**
 * The response at the end of the redirects, or a sentence saying why there is
 * none: a secret that may not be sent to the address called, a redirect to
 * something that is not an `http(s)` address, or too many of them.
 */
export async function fetchWithCredentials(
  vault: SecretVault | null | undefined,
  url: string,
  request: CredentialedRequest = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ response: Response } | { problem: string }> {
  let current = url;
  let method = (request.method ?? "GET").toUpperCase();
  let body = request.body;
  let held = { ...(request.headers ?? {}) };

  for (let redirects = 0; ; redirects++) {
    // Only the address called can have a problem: what may not go to a later
    // hop was left out before getting here.
    const { value: headers, problem } = resolveCredential(vault, held, current);
    if (problem) {
      return { problem };
    }
    const response = await fetchImpl(current, {
      method,
      headers,
      body,
      signal: request.signal,
      redirect: "manual",
    });
    const location = REDIRECT_STATUS.has(response.status)
      ? response.headers.get("location")
      : null;
    if (!location) {
      return { response };
    }
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      return { problem: `${url} redirected more than ${MAX_REDIRECTS} times` };
    }

    const from = new URL(current);
    let to: URL;
    try {
      to = new URL(location, from);
    } catch {
      return { problem: `${current} redirected to ${JSON.stringify(location)}, which is not a URL` };
    }
    if (to.protocol !== "http:" && to.protocol !== "https:") {
      return { problem: `${current} redirected to a ${to.protocol}// address` };
    }

    // As `fetch` does: a 303 is fetched, and so is what a POST was sent to by
    // a 301 or 302; a 307 or 308 repeats the request as it was.
    const becomesGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (becomesGet) {
      method = "GET";
      body = undefined;
    }

    const crossOrigin = to.origin !== from.origin;
    held = Object.fromEntries(
      Object.entries(held).filter(([name, value]) => {
        const header = name.toLowerCase();
        if (becomesGet && BODY_HEADERS.has(header)) {
          return false;
        }
        if (crossOrigin && ORIGIN_BOUND.has(header)) {
          return false;
        }
        return !resolveCredential(vault, value, to.href).problem;
      }),
    );
    current = to.href;
  }
}
