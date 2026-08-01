import { Hammer, LogIn, LogOut, Skull, Swords } from 'lucide-react';
import type { GameEventEntry } from '@/types';

const eventConfig: Record<string, { icon: typeof Skull; label: string; color: string }> = {
    death: { icon: Skull, label: 'Died', color: 'text-red-500' },
    pvp_hit: { icon: Swords, label: 'PvP Hit', color: 'text-yellow-500' },
    pvp_kill: { icon: Swords, label: 'PvP Kill', color: 'text-orange-500' },
    craft: { icon: Hammer, label: 'Crafted', color: 'text-blue-500' },
    connect: { icon: LogIn, label: 'Joined', color: 'text-green-500' },
    disconnect: { icon: LogOut, label: 'Left', color: 'text-muted-foreground' },
};

function formatEventDescription(event: GameEventEntry): string {
    const details = event.details;
    switch (event.event_type) {
        case 'death':
            return `${event.player} died`;
        case 'pvp_hit':
            return `${event.player} hit ${event.target ?? 'someone'}${details?.weapon ? ` with ${details.weapon}` : ''}`;
        case 'pvp_kill':
            return `${event.player} killed ${event.target ?? 'someone'}${details?.weapon ? ` with ${details.weapon}` : ''}`;
        case 'craft':
            return `${event.player} crafted ${details?.quantity ?? 1}x ${(details?.item as string)?.replace('Base.', '') ?? 'item'}`;
        case 'connect':
            return `${event.player} joined the server`;
        case 'disconnect':
            return `${event.player} left the server`;
        default:
            return `${event.player}: ${event.event_type}`;
    }
}

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export function ActivityFeed({ events }: { events: GameEventEntry[] }) {
    if (events.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                No game events recorded yet. Events will appear once Log Extender is active.
            </p>
        );
    }

    return (
        <div className="space-y-2">
            {events.map((event) => {
                const config = eventConfig[event.event_type] ?? eventConfig.death;
                const Icon = config.icon;

                return (
                    <div
                        key={event.id}
                        className="flex items-start gap-2.5 text-sm"
                    >
                        <Icon className={`mt-0.5 size-4 shrink-0 ${config.color}`} />
                        <div className="min-w-0 flex-1">
                            <p className="leading-tight">{formatEventDescription(event)}</p>
                            <p className="text-xs text-muted-foreground">
                                {event.created_at ? timeAgo(event.created_at) : ''}
                            </p>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
