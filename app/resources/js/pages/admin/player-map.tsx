import { Head, router, usePoll } from '@inertiajs/react';
import { AlertTriangle, Circle, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import PlayerActionDialogs from '@/components/player-action-dialogs';
import PzMap from '@/components/pz-map';
import { useTranslation } from '@/hooks/use-translation';
import type { ZoneOverlay } from '@/components/pz-map';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import AppLayout from '@/layouts/app-layout';
import type { BreadcrumbItem } from '@/types';
import type { MapConfig, PlayerMarker } from '@/types/server';

type TileProgress = {
    generating: boolean;
    completed: number;
    total: number;
    percent: number;
    stage?: string;
    step?: number;
    steps?: number;
    message?: string;
    tiles_on_disk?: number;
};

type SafeZone = {
    id: string;
    name: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

type Props = {
    markers: PlayerMarker[];
    onlineCount: number;
    serverStatus: 'offline' | 'starting' | 'online';
    mapConfig: MapConfig;
    hasTiles: boolean;
    tileSource?: 'local' | 'proxy' | 'none' | string;
    localTilesReady?: boolean;
    canResume?: boolean;
    tileProgress: TileProgress | null;
    tilesGenerating?: boolean;
    safeZones: SafeZone[];
};

const statusDotColor: Record<PlayerMarker['status'], string> = {
    online: 'fill-green-500 text-green-500',
    offline: 'fill-muted text-muted',
    dead: 'fill-red-500 text-red-500',
};

const ZONE_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];

export default function PlayerMap({
    markers,
    onlineCount,
    serverStatus,
    mapConfig,
    hasTiles,
    tileSource = 'proxy',
    localTilesReady = false,
    canResume = false,
    tileProgress,
    tilesGenerating = false,
    safeZones,
}: Props) {
    const { t } = useTranslation();
    const [genLoading, setGenLoading] = useState(false);
    const [stopLoading, setStopLoading] = useState(false);
    const [genMessage, setGenMessage] = useState<string | null>(null);

    const isGenerating = Boolean(tilesGenerating || tileProgress?.generating);

    usePoll(isGenerating ? 3000 : 5000, {
        only: [
            'markers',
            'onlineCount',
            'serverStatus',
            'hasTiles',
            'tileProgress',
            'safeZones',
            'tileSource',
            'localTilesReady',
            'tilesGenerating',
            'canResume',
        ],
    });

    async function generateTiles(opts: { force?: boolean; resume?: boolean } = {}) {
        setGenLoading(true);
        setGenMessage(null);
        try {
            const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
            const res = await fetch('/admin/players/map/generate-tiles', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                body: JSON.stringify({ force: !!opts.force, resume: !!opts.resume }),
            });
            const json = await res.json().catch(() => ({}));
            setGenMessage(json.message || (res.ok ? 'Started' : 'Failed to start'));
            router.reload({
                only: ['tilesGenerating', 'tileProgress', 'hasTiles', 'tileSource', 'localTilesReady', 'canResume'],
            });
        } catch {
            setGenMessage('Network error starting tile generation');
        }
        setGenLoading(false);
    }

    async function stopTiles() {
        setStopLoading(true);
        setGenMessage(null);
        try {
            const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
            const res = await fetch('/admin/players/map/stop-tiles', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                body: JSON.stringify({}),
            });
            const json = await res.json().catch(() => ({}));
            setGenMessage(json.message || (res.ok ? 'Stop requested' : 'Failed to stop'));
            router.reload({
                only: ['tilesGenerating', 'tileProgress', 'hasTiles', 'tileSource', 'localTilesReady', 'canResume'],
            });
        } catch {
            setGenMessage('Network error stopping tile generation');
        }
        setStopLoading(false);
    }

    const zoneOverlays: ZoneOverlay[] = useMemo(
        () => safeZones.map((zone, i) => ({ ...zone, color: ZONE_COLORS[i % ZONE_COLORS.length] })),
        [safeZones],
    );

    const [kickTarget, setKickTarget] = useState<string | null>(null);
    const [banTarget, setBanTarget] = useState<string | null>(null);
    const [accessTarget, setAccessTarget] = useState<string | null>(null);

    const counts = useMemo(() => {
        const online = Math.max(onlineCount, markers.filter((m) => m.status === 'online').length);
        const offline = markers.filter((m) => m.status === 'offline').length;
        const dead = markers.filter((m) => m.status === 'dead').length;
        return { online, offline, dead, total: markers.length };
    }, [markers, onlineCount]);

    function handleMarkerAction(marker: PlayerMarker, action: string) {
        switch (action) {
            case 'kick':
                setKickTarget(marker.username);
                break;
            case 'ban':
                setBanTarget(marker.username);
                break;
            case 'access':
                setAccessTarget(marker.username);
                break;
            case 'inventory':
                router.visit(`/admin/players/${marker.username}/inventory`);
                break;
        }
    }

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('nav.players'), href: '/admin/players' },
        { title: t('admin.player_map.breadcrumb'), href: '/admin/players/map' },
    ];

    const progressPercent = tileProgress?.percent ?? 0;
    const progressMessage =
        tileProgress?.message ||
        (isGenerating ? t('admin.player_map.generating_tiles') : t('admin.player_map.tiles_panel_idle'));

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.player_map.title')} />
            <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">{t('admin.player_map.title')}</h1>
                        <p className="text-muted-foreground">
                            {t('admin.player_map.players_tracked', { count: String(counts.total) })}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-sm">
                            <Circle className="mr-1.5 size-2 fill-green-500 text-green-500" />
                            {t('admin.player_map.online_count', { count: String(counts.online) })}
                        </Badge>
                        <Badge variant="outline" className="text-sm">
                            <Circle className="mr-1.5 size-2 fill-muted text-muted" />
                            {t('admin.player_map.offline_count', { count: String(counts.offline) })}
                        </Badge>
                        {counts.dead > 0 && (
                            <Badge variant="outline" className="text-sm">
                                <Circle className="mr-1.5 size-2 fill-red-500 text-red-500" />
                                {t('admin.player_map.dead_count', { count: String(counts.dead) })}
                            </Badge>
                        )}
                        <Badge variant={localTilesReady ? 'default' : 'secondary'} className="text-sm">
                            tiles: {tileSource}
                        </Badge>
                    </div>
                </div>

                {/* Always-visible map tile controls (not buried in header overflow) */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">{t('admin.player_map.tiles_panel_title')}</CardTitle>
                        <p className="text-muted-foreground text-sm">{t('admin.player_map.tiles_panel_help')}</p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {isGenerating ? (
                                <button
                                    type="button"
                                    disabled={stopLoading}
                                    onClick={() => stopTiles()}
                                    className="inline-flex items-center rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                                >
                                    {stopLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                                    {t('admin.player_map.stop_generation')}
                                </button>
                            ) : (
                                <>
                                    {canResume && (
                                        <button
                                            type="button"
                                            disabled={genLoading}
                                            onClick={() => generateTiles({ resume: true })}
                                            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                                        >
                                            {genLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                                            {t('admin.player_map.resume_generation')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        disabled={genLoading}
                                        onClick={() => generateTiles({})}
                                        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                                    >
                                        {genLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                                        {localTilesReady
                                            ? t('admin.player_map.regenerate_tiles')
                                            : t('admin.player_map.generate_tiles')}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={genLoading}
                                        onClick={() => {
                                            if (!window.confirm(t('admin.player_map.confirm_force_regenerate'))) {
                                                return;
                                            }
                                            generateTiles({ force: true });
                                        }}
                                        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                                    >
                                        {t('admin.player_map.force_regenerate')}
                                    </button>
                                </>
                            )}
                        </div>

                        <div className="rounded-md border border-border bg-muted/30 px-3 py-3">
                            <div className="flex items-center gap-2 text-sm font-medium">
                                {isGenerating && <Loader2 className="size-4 animate-spin text-primary" />}
                                <span>{progressMessage}</span>
                                {tileProgress?.step && tileProgress?.steps ? (
                                    <span className="text-muted-foreground text-xs font-normal">
                                        ({tileProgress.step}/{tileProgress.steps})
                                    </span>
                                ) : null}
                            </div>
                            {isGenerating && (
                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                                    {progressPercent > 0 ? (
                                        <div
                                            className="h-full rounded-full bg-primary transition-all duration-500"
                                            style={{ width: `${Math.max(progressPercent, 2)}%` }}
                                        />
                                    ) : (
                                        <div className="h-full w-full animate-pulse rounded-full bg-primary/30" />
                                    )}
                                </div>
                            )}
                            {tileProgress && tileProgress.total > 0 && (
                                <p className="text-muted-foreground mt-1.5 text-xs">
                                    {tileProgress.completed.toLocaleString()} / {tileProgress.total.toLocaleString()} (
                                    {tileProgress.percent}%)
                                    {tileProgress.tiles_on_disk
                                        ? ` · ${tileProgress.tiles_on_disk.toLocaleString()} files`
                                        : ''}
                                </p>
                            )}
                            {tileProgress?.stage === 'failed' && (
                                <p className="mt-1.5 text-xs text-red-400">{t('admin.player_map.tiles_failed_hint')}</p>
                            )}
                            {!isGenerating && !tileProgress && (
                                <p className="text-muted-foreground mt-1 text-xs">{t('admin.player_map.tiles_panel_idle')}</p>
                            )}
                        </div>

                        {genMessage && (
                            <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">{genMessage}</div>
                        )}
                    </CardContent>
                </Card>

                {serverStatus === 'offline' && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                        <AlertTriangle className="size-4 shrink-0" />
                        {t('admin.player_map.server_offline')}
                    </div>
                )}
                {serverStatus === 'starting' && (
                    <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                        {t('admin.player_map.server_starting')}
                    </div>
                )}

                <Card className="isolate flex-1">
                    <CardContent className="relative h-[350px] p-0 sm:h-[500px] lg:h-[600px]">
                        {!hasTiles && !isGenerating && (
                            <div className="bg-muted/80 text-muted-foreground absolute top-2 left-1/2 z-[1000] -translate-x-1/2 rounded-md px-3 py-1.5 text-xs backdrop-blur-sm">
                                {t('admin.player_map.no_tiles')} <code className="font-mono">{t('admin.player_map.no_tiles_command')}</code>{' '}
                                {t('admin.player_map.no_tiles_suffix')}
                            </div>
                        )}
                        <PzMap
                            markers={markers}
                            mapConfig={mapConfig}
                            hasTiles={hasTiles}
                            onMarkerAction={handleMarkerAction}
                            zones={zoneOverlays}
                            className="h-full w-full rounded-xl"
                        />
                    </CardContent>
                </Card>

                {markers.length > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.player_map.player_positions')}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {markers.map((marker) => (
                                    <div
                                        key={marker.username}
                                        className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2"
                                    >
                                        <div className="flex items-center gap-2">
                                            <Circle className={`size-2 ${statusDotColor[marker.status]}`} />
                                            <span className="text-sm font-medium">{marker.name}</span>
                                        </div>
                                        <span className="font-mono text-xs text-muted-foreground">
                                            {marker.x.toFixed(0)}, {marker.y.toFixed(0)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>

            <PlayerActionDialogs
                kickTarget={kickTarget}
                banTarget={banTarget}
                accessTarget={accessTarget}
                onCloseKick={() => setKickTarget(null)}
                onCloseBan={() => setBanTarget(null)}
                onCloseAccess={() => setAccessTarget(null)}
                reloadOnly={['markers']}
            />
        </AppLayout>
    );
}
