import { Head, usePoll } from '@inertiajs/react';
import type { Map as LeafletMap } from 'leaflet';
import { Crosshair, MapPin, RefreshCw, ShieldCheck, TriangleAlert, UserX } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';
import PzMap from '@/components/pz-map';
import type { ZoneOverlay } from '@/components/pz-map';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import type { BreadcrumbItem } from '@/types';
import type { MapConfig, PlayerMarker } from '@/types/server';

type SafeZone = {
    id: string;
    name: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

type OwnMarker = PlayerMarker & {
    /** 'live' when the game server is reporting it, 'save' when read from the save file. */
    source: 'live' | 'save';
};

type Props = {
    username: string | null;
    hasPzAccount: boolean;
    marker: OwnMarker | null;
    mapConfig: MapConfig;
    hasTiles: boolean;
    safeZones: SafeZone[];
};

const ZONE_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899'];

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <Card>
            <CardContent className="py-12">
                <div className="flex flex-col items-center gap-3 text-center">
                    {icon}
                    <div>
                        <p className="font-medium">{title}</p>
                        <p className="text-muted-foreground text-sm">{description}</p>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

export default function PortalMap({ username, hasPzAccount, marker, mapConfig, hasTiles, safeZones }: Props) {
    const { t } = useTranslation();
    const mapRef = useRef<LeafletMap | null>(null);

    usePoll(5000, { only: ['marker'] });

    const zones = useMemo<ZoneOverlay[]>(
        () => safeZones.map((zone, index) => ({ ...zone, color: ZONE_COLORS[index % ZONE_COLORS.length] })),
        [safeZones],
    );

    /** The map keeps its own view once mounted, so recentring is an explicit act. */
    const centreOnMe = useCallback(() => {
        if (mapRef.current && marker) {
            mapRef.current.setView([-marker.y, marker.x], 5);
        }
    }, [marker]);

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('portal.map.breadcrumb'), href: '/portal/map' },
    ];

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('portal.map.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">{t('portal.map.title')}</h1>
                        <p className="text-muted-foreground text-sm">
                            {username
                                ? t('portal.map.description', { username })
                                : t('portal.map.description_generic')}
                        </p>
                    </div>
                    {marker && (
                        <Button variant="outline" size="sm" onClick={centreOnMe}>
                            <Crosshair className="mr-1.5 size-4" />
                            {t('portal.map.centre_on_me')}
                        </Button>
                    )}
                </div>

                {!hasPzAccount ? (
                    <EmptyState
                        icon={<UserX className="text-muted-foreground size-8" />}
                        title={t('portal.inventory.no_account')}
                        description={t('portal.inventory.no_account_desc')}
                    />
                ) : !marker ? (
                    <EmptyState
                        icon={<MapPin className="text-muted-foreground size-8" />}
                        title={t('portal.map.no_position')}
                        description={t('portal.map.no_position_desc')}
                    />
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={marker.status === 'dead' ? 'destructive' : 'secondary'}>
                                {marker.status === 'dead'
                                    ? t('common.dead')
                                    : marker.is_online
                                      ? t('common.online')
                                      : t('common.offline')}
                            </Badge>
                            <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                <MapPin className="size-3.5" />
                                {t('portal.map.coordinates', {
                                    x: marker.x.toFixed(0),
                                    y: marker.y.toFixed(0),
                                })}
                            </span>
                            {marker.source === 'live' ? (
                                <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                    <RefreshCw className="size-3 animate-spin" />
                                    {t('portal.map.live')}
                                </span>
                            ) : (
                                <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                    <TriangleAlert className="size-3.5" />
                                    {t('portal.map.from_save')}
                                </span>
                            )}
                            {zones.length > 0 && (
                                <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                    <ShieldCheck className="size-3.5" />
                                    {t('portal.map.safe_zones', { count: String(zones.length) })}
                                </span>
                            )}
                        </div>

                        <Card className="flex-1 overflow-hidden">
                            <CardContent className="h-[60vh] min-h-[400px] p-0 lg:h-[70vh]">
                                <PzMap
                                    markers={[marker]}
                                    mapConfig={{
                                        ...mapConfig,
                                        center: { x: marker.x, y: marker.y },
                                        defaultZoom: 5,
                                    }}
                                    hasTiles={hasTiles}
                                    zones={zones}
                                    onMapReady={(map) => {
                                        mapRef.current = map;
                                    }}
                                    className="size-full"
                                />
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </AppLayout>
    );
}
