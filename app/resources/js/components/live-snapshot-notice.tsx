import { RefreshCw, TriangleAlert } from 'lucide-react';

/**
 * Freshness banner for a page that polls a Lua bridge export.
 *
 * The mod only exports for players who are in the game, so being offline is
 * the difference between a figure that is ticking along and one that stopped
 * whenever the player last logged out. Say which of the two this is.
 */
export function LiveSnapshotNotice({
    isLive,
    liveLabel,
    staleTitle,
    staleDescription,
}: {
    isLive: boolean;
    liveLabel: string;
    staleTitle: string;
    staleDescription: string;
}) {
    if (isLive) {
        return (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <RefreshCw className="size-3 animate-spin" />
                {liveLabel}
            </p>
        );
    }

    return (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-4 py-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-500" />
            <div>
                <p className="font-medium">{staleTitle}</p>
                <p className="text-muted-foreground">{staleDescription}</p>
            </div>
        </div>
    );
}
