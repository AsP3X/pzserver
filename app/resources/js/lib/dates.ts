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
