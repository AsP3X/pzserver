import { Head, router, usePoll } from '@inertiajs/react';
import { AlertTriangle, ChevronDown, Circle, CloudLightning, Loader2, Sun } from 'lucide-react';
import { useMemo, useState } from 'react';
import PlayerActionDialogs from '@/components/player-action-dialogs';
import PzMap from '@/components/pz-map';
import { useTranslation } from '@/hooks/use-translation';
import type { ZoneOverlay } from '@/components/pz-map';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import AppLayout from '@/layouts/app-layout';
import { fetchAction } from '@/lib/fetch-action';
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

type Safehouse = {
    title: string;
    owner: string | null;
    members: string[];
    x: number;
    y: number;
    x2: number;
    y2: number;
};

type Faction = {
    name: string;
    tag: string | null;
    owner: string | null;
    members: string[];
};

type VectorSource = {
    name: string;
    origin: string;
    xml: string;
    has_annotations: boolean;
    missing?: boolean;
};

type VectorAsset = {
    exists: boolean;
    bytes: number | null;
    modified_at: string | null;
    url: string;
};

type VectorBakeResult = {
    ok: boolean;
    message: string;
    bytes?: number;
    source?: string;
    maps?: Array<{ name: string; origin: string }>;
    stats?: Record<string, number>;
    finished_at?: string;
} | null;

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
    safehouses: Safehouse[];
    factions: Faction[];
    vectorSources?: VectorSource[];
    vectorAsset?: VectorAsset | null;
    vectorBakeResult?: VectorBakeResult;
};

const statusDotColor: Record<PlayerMarker['status'], string> = {
    online: 'fill-green-500 text-green-500',
    offline: 'fill-muted text-muted',
    dead: 'fill-red-500 text-red-500',
};

const ZONE_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];

/** One colour for every player claim, distinct from the admin zone palette. */
const CLAIM_COLOR = '#a855f7';

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
    safehouses,
    factions,
    vectorSources = [],
    vectorAsset = null,
    vectorBakeResult = null,
}: Props) {
    const { t } = useTranslation();
    const [genLoading, setGenLoading] = useState(false);
    const [stopLoading, setStopLoading] = useState(false);
    const [genMessage, setGenMessage] = useState<string | null>(null);
    const [bakeLoading, setBakeLoading] = useState(false);
    const [bakeMessage, setBakeMessage] = useState<string | null>(null);
    const [scanWorkshop, setScanWorkshop] = useState(false);

    const isGenerating = Boolean(tilesGenerating || tileProgress?.generating);
    // Isometric tiles are advanced: expand when actively used or generating
    const [isoOpen, setIsoOpen] = useState(
        () => isGenerating || localTilesReady || tileSource === 'local' || tileSource === 'proxy' || canResume,
    );

    usePoll(isGenerating ? 3000 : 5000, {
        only: [
            'markers',
            'onlineCount',
            'serverStatus',
            'hasTiles',
            'tileProgress',
            'safeZones',
            'safehouses',
            'factions',
            'tileSource',
            'localTilesReady',
            'tilesGenerating',
            'canResume',
            'vectorSources',
            'vectorAsset',
            'vectorBakeResult',
        ],
    });

    async function bakeVector() {
        setBakeLoading(true);
        setBakeMessage(null);
        try {
            const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
            const res = await fetch('/admin/players/map/bake-vector', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                body: JSON.stringify({ scan_workshop: scanWorkshop }),
            });
            const json = await res.json().catch(() => ({}));
            setBakeMessage(
                typeof json.message === 'string'
                    ? json.message
                    : res.ok
                      ? t('admin.player_map.vector_bake_ok')
                      : t('admin.player_map.vector_bake_failed'),
            );
            router.reload({
                only: [
                    'hasTiles',
                    'tileSource',
                    'mapConfig',
                    'vectorSources',
                    'vectorAsset',
                    'vectorBakeResult',
                ],
            });
        } catch {
            setBakeMessage(t('admin.player_map.vector_bake_network_error'));
        }
        setBakeLoading(false);
    }

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

    /**
     * Safe zones and safehouse claims share the overlay layer. Claims are drawn
     * in one colour throughout so a wall of player bases cannot be mistaken for
     * a set of distinct admin zones.
     */
    const zoneOverlays: ZoneOverlay[] = useMemo(
        () => [
            ...safeZones.map((zone, i) => ({ ...zone, color: ZONE_COLORS[i % ZONE_COLORS.length] })),
            ...safehouses.map((house, i) => ({
                id: `safehouse-${i}`,
                name: house.owner ? `${house.title} (${house.owner})` : house.title,
                x1: house.x,
                y1: house.y,
                x2: house.x2,
                y2: house.y2,
                color: CLAIM_COLOR,
            })),
        ],
        [safeZones, safehouses],
    );

    const [stormHours, setStormHours] = useState(3);
    const [worldBusy, setWorldBusy] = useState(false);

    async function triggerWorldAction(action: 'storm' | 'clear_weather') {
        setWorldBusy(true);
        await fetchAction('/admin/world/actions', {
            data: action === 'storm' ? { action, duration_hours: stormHours } : { action },
        });
        setWorldBusy(false);
    }

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
                        <Badge
                            variant={tileSource === 'vector' || localTilesReady || tileSource === 'proxy' ? 'default' : 'secondary'}
                            className="text-sm"
                        >
                            {t('admin.player_map.basemap_badge', { source: tileSource })}
                        </Badge>
                    </div>
                </div>

                {/* Vector basemap: default efficient path (Map= + workshop worldmap.xml) */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">{t('admin.player_map.vector_panel_title')}</CardTitle>
                        <p className="text-muted-foreground text-sm">{t('admin.player_map.vector_panel_help')}</p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                            <span>
                                {vectorAsset?.exists
                                    ? t('admin.player_map.vector_asset_ready', {
                                          size: vectorAsset.bytes
                                              ? `${(vectorAsset.bytes / 1024 / 1024).toFixed(2)} MB`
                                              : '—',
                                      })
                                    : t('admin.player_map.vector_asset_missing')}
                            </span>
                            {vectorAsset?.modified_at && (
                                <span>
                                    {t('admin.player_map.vector_asset_updated', {
                                        time: new Date(vectorAsset.modified_at).toLocaleString(),
                                    })}
                                </span>
                            )}
                        </div>

                        {vectorSources.length > 0 ? (
                            <div className="overflow-x-auto rounded-md border border-border">
                                <table className="w-full text-left text-xs">
                                    <thead className="bg-muted/50 text-muted-foreground">
                                        <tr>
                                            <th className="px-3 py-2 font-medium">{t('admin.player_map.vector_col_map')}</th>
                                            <th className="px-3 py-2 font-medium">{t('admin.player_map.vector_col_origin')}</th>
                                            <th className="px-3 py-2 font-medium">{t('admin.player_map.vector_col_status')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {vectorSources.map((src) => (
                                            <tr key={`${src.name}-${src.origin}`} className="border-t border-border">
                                                <td className="px-3 py-1.5 font-medium">{src.name}</td>
                                                <td className="text-muted-foreground px-3 py-1.5 font-mono">{src.origin}</td>
                                                <td className="px-3 py-1.5">
                                                    {src.missing ? (
                                                        <span className="text-red-400">{t('admin.player_map.vector_source_missing')}</span>
                                                    ) : (
                                                        <span className="text-green-500">{t('admin.player_map.vector_source_ok')}</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <p className="text-muted-foreground text-xs">{t('admin.player_map.vector_sources_empty')}</p>
                        )}

                        <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                className="size-4 rounded border-border"
                                checked={scanWorkshop}
                                onChange={(e) => setScanWorkshop(e.target.checked)}
                                disabled={bakeLoading}
                            />
                            <span>{t('admin.player_map.vector_scan_workshop')}</span>
                        </label>

                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                disabled={bakeLoading}
                                onClick={() => bakeVector()}
                                className="inline-flex items-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                            >
                                {bakeLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
                                {t('admin.player_map.vector_bake')}
                            </button>
                        </div>

                        {(bakeMessage || vectorBakeResult?.message) && (
                            <div
                                className={`rounded-md border px-3 py-2 text-sm ${
                                    (bakeMessage ?? vectorBakeResult?.message)?.toLowerCase().includes('fail')
                                    || vectorBakeResult?.ok === false
                                        ? 'border-red-500/30 bg-red-500/10 text-red-400'
                                        : 'border-border bg-background'
                                }`}
                            >
                                {bakeMessage ?? vectorBakeResult?.message}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Advanced: optional photoreal isometric tiles (not needed for vector default) */}
                <Collapsible open={isoOpen || isGenerating} onOpenChange={setIsoOpen}>
                    <Card>
                        <CardHeader className="pb-3">
                            <CollapsibleTrigger asChild>
                                <button
                                    type="button"
                                    className="flex w-full items-start justify-between gap-3 text-left"
                                >
                                    <div className="space-y-1">
                                        <CardTitle className="text-base">
                                            {t('admin.player_map.tiles_panel_title')}
                                            <Badge variant="secondary" className="ml-2 align-middle text-[10px] font-normal">
                                                {t('admin.player_map.tiles_advanced_badge')}
                                            </Badge>
                                        </CardTitle>
                                        <p className="text-muted-foreground text-sm font-normal">
                                            {t('admin.player_map.tiles_panel_help_advanced')}
                                        </p>
                                    </div>
                                    <ChevronDown
                                        className={`text-muted-foreground mt-1 size-4 shrink-0 transition-transform ${isoOpen || isGenerating ? 'rotate-180' : ''}`}
                                    />
                                </button>
                            </CollapsibleTrigger>
                        </CardHeader>
                        <CollapsibleContent>
                            <CardContent className="space-y-3 pt-0">
                                <p className="text-muted-foreground text-xs">
                                    {t('admin.player_map.tiles_panel_env_hint')}
                                </p>
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
                        </CollapsibleContent>
                    </Card>
                </Collapsible>

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

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.player_map.world_control')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-wrap items-end gap-3">
                            <div className="space-y-1.5">
                                <label htmlFor="storm-hours" className="text-sm">
                                    {t('admin.player_map.storm_hours')}
                                </label>
                                <input
                                    id="storm-hours"
                                    type="number"
                                    min={1}
                                    max={24}
                                    value={stormHours}
                                    onChange={(e) =>
                                        setStormHours(Math.max(1, Math.min(24, parseInt(e.target.value) || 3)))
                                    }
                                    className="border-input bg-background h-9 w-24 rounded-md border px-3 text-sm"
                                />
                            </div>
                            <Button
                                variant="outline"
                                disabled={worldBusy}
                                onClick={() => triggerWorldAction('storm')}
                            >
                                <CloudLightning className="mr-1.5 size-4" />
                                {t('admin.player_map.trigger_storm')}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={worldBusy}
                                onClick={() => triggerWorldAction('clear_weather')}
                            >
                                <Sun className="mr-1.5 size-4" />
                                {t('admin.player_map.clear_weather')}
                            </Button>
                        </div>
                        <p className="text-muted-foreground mt-3 text-xs">
                            {t('admin.player_map.world_control_hint')}
                        </p>
                    </CardContent>
                </Card>

                {(safehouses.length > 0 || factions.length > 0) && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.player_map.claims')}</CardTitle>
                        </CardHeader>
                        <CardContent className="grid gap-6 lg:grid-cols-2">
                            <div>
                                <p className="mb-2 text-sm font-semibold">
                                    {t('admin.player_map.safehouses', { count: String(safehouses.length) })}
                                </p>
                                {safehouses.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">
                                        {t('admin.player_map.no_safehouses')}
                                    </p>
                                ) : (
                                    <div className="divide-y rounded-md border">
                                        {safehouses.map((house, i) => (
                                            <div key={`${house.title}-${i}`} className="px-3 py-2">
                                                <p className="text-sm font-medium">{house.title}</p>
                                                <p className="text-muted-foreground text-xs">
                                                    {house.owner ?? t('admin.player_map.no_owner')}
                                                    {house.members.length > 0 &&
                                                        ` · ${t('admin.player_map.members', {
                                                            count: String(house.members.length),
                                                        })}`}
                                                    {` · ${house.x}, ${house.y}`}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div>
                                <p className="mb-2 text-sm font-semibold">
                                    {t('admin.player_map.factions', { count: String(factions.length) })}
                                </p>
                                {factions.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">
                                        {t('admin.player_map.no_factions')}
                                    </p>
                                ) : (
                                    <div className="divide-y rounded-md border">
                                        {factions.map((faction) => (
                                            <div key={faction.name} className="px-3 py-2">
                                                <p className="text-sm font-medium">
                                                    {faction.name}
                                                    {faction.tag && (
                                                        <span className="text-muted-foreground"> [{faction.tag}]</span>
                                                    )}
                                                </p>
                                                <p className="text-muted-foreground text-xs">
                                                    {faction.owner ?? t('admin.player_map.no_owner')}
                                                    {` · ${t('admin.player_map.members', {
                                                        count: String(faction.members.length),
                                                    })}`}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                )}

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
