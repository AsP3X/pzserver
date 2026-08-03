/**
 * Global date formatting utilities.
 * All user-facing dates use DD/MM/YYYY format.
 */

function pad(n: number): string {
    return n.toString().padStart(2, '0');
}

/** DD/MM/YYYY HH:MM:SS */
export function formatDateTime(dateStr: string): string {
    const d = new Date(dateStr);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** DD/MM/YYYY */
export function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** DD Mon YYYY (e.g. 17 Mar 2026) */
export function formatShortDate(dateStr: string): string {
    const d = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** HH:MM:SS */
export function formatTime(date: Date = new Date()): string {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Translated "3 m ago" style label. Pass `t` from useTranslation().
 */
export function formatRelativeTime(
    dateStr: string,
    t: (key: string, replacements?: Record<string, string>) => string,
): string {
    const diffMin = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);

    if (diffMin < 1) {
        return t('common.just_now');
    }
    if (diffMin < 60) {
        return t('common.minutes_ago', { count: String(diffMin) });
    }

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) {
        return t('common.hours_ago', { count: String(diffHr) });
    }

    return t('common.days_ago', { count: String(Math.floor(diffHr / 24)) });
}
