import { toast } from 'sonner';

/**
 * The CSRF token to send, preferring the one that stays current.
 *
 * Laravel rewrites the XSRF-TOKEN cookie on every response, so it is right
 * even in a tab that has been open since before the last sign-in. The
 * <meta name="csrf-token"> tag is only written when Blade renders the shell,
 * which an Inertia SPA does exactly once per full page load — leave a tab open
 * across a re-login and the tag holds a token the server stopped accepting
 * hours ago, which is why navigation kept working while every button did not.
 *
 * Inertia's own requests resolve the token in this order; this matches them.
 */
function csrfHeader(): Record<string, string> {
    const prefix = 'XSRF-TOKEN=';
    const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));

    if (cookie) {
        return { 'X-XSRF-TOKEN': decodeURIComponent(cookie.slice(prefix.length)) };
    }

    return {
        'X-CSRF-TOKEN':
            document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '',
    };
}

/**
 * A 419 means the token could not be accepted at all, so the session behind it
 * is gone. Retrying sends the same dead token, so offer the one thing that
 * does work instead of a toast the user can only dismiss. Reloading is left to
 * them rather than done for them: a 419 on the config page would otherwise
 * throw away every unsaved edit on it.
 */
function reportExpiredSession(): void {
    toast.error('Your session expired. Reload the page to sign in again.', {
        id: 'session-expired',
        duration: 15000,
        action: {
            label: 'Reload',
            onClick: () => window.location.reload(),
        },
    });
}

type FetchActionOptions = {
    method?: string;
    data?: Record<string, unknown>;
    successMessage?: string;
    /** Suppress success/error toasts (useful for typeahead / debounced lookups). */
    silent?: boolean;
    /** AbortSignal for cancelling stale requests. */
    signal?: AbortSignal;
};

/**
 * Wrapper around fetch for admin actions with automatic toast feedback.
 * Parses JSON response and shows success/error toasts.
 * Returns the parsed JSON data on success, or null on failure.
 *
 * Pass `silent: true` to opt out of toasts and `signal` for cancellation.
 * Aborted requests resolve to `null` without surfacing an error.
 */
export async function fetchAction(
    url: string,
    options: FetchActionOptions = {},
): Promise<Record<string, unknown> | null> {
    const { method = 'POST', data, successMessage, silent = false, signal } = options;

    // Laravel method spoofing: send PUT/PATCH/DELETE as POST with _method in body
    const spoofed = ['PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    const actualMethod = spoofed ? 'POST' : method;

    const body = data
        ? JSON.stringify(spoofed ? { ...data, _method: method } : data)
        : spoofed
            ? JSON.stringify({ _method: method })
            : undefined;

    const headers: Record<string, string> = {
        ...csrfHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
    };
    if (spoofed) {
        headers['X-HTTP-Method-Override'] = method.toUpperCase();
    }
    if (body) {
        headers['Content-Type'] = 'application/json';
    }

    try {
        const res = await fetch(url, {
            method: actualMethod,
            headers,
            body,
            credentials: 'same-origin',
            signal,
        });

        const json = await res.json().catch(() => ({}));

        if (res.ok) {
            if (!silent) {
                toast.success(
                    successMessage || json.message || 'Action completed',
                );
            }
            return json;
        }

        /** Session-level, not request-level — say so even for a silent call. */
        if (res.status === 419) {
            reportExpiredSession();

            return null;
        }

        if (!silent) {
            toast.error(json.error || json.message || `Request failed (${res.status})`);
        }
        return null;
    } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
            return null;
        }
        if (!silent) {
            toast.error('Network error — could not reach the server');
        }
        return null;
    }
}
