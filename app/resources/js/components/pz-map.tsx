import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Maximize2, Minimize2, Layers } from 'lucide-react';
import type { Ref } from 'react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import VectorMapLegend from '@/components/vector-map-legend';
import { useAppearance } from '@/hooks/use-appearance';
import { useTranslation } from '@/hooks/use-translation';
import { ActivityHeatLayer } from '@/lib/activity-heat-layer';
import {
    createWorldSquareCrs,
    loadWorldMapVector,
    WorldMapVectorLayer,
} from '@/lib/worldmap-vector-layer';
import type { DziInfo, MapConfig, PlayerMarker } from '@/types/server';

type MarkerAction = 'kick' | 'ban' | 'access' | 'inventory';

type Translator = (key: string, replacements?: Record<string, string>) => string;

export type ZoneOverlay = {
    id: string;
    name: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
};

export type DrawnZone = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

export type EventMarker = {
    id: number;
    x: number;
    y: number;
    type: string;
    player: string;
    target: string | null;
    label: string;
};

export type VehicleMarker = {
    id: number;
    x: number;
    y: number;
    model: string;
    fuel_percent: number | null;
    engine_running: boolean;
    key_holders?: string[];
};

export type ActivityPoint = {
    x: number;
    y: number;
    type?: string;
};

/** Overlays the user can switch off, in the order they appear in the panel. */
export type MapLayerId =
    | 'players'
    | 'zones'
    | 'events'
    | 'vehicles'
    | 'activity'
    | 'labels'
    | 'grid';

/** One entry in the map's right-click menu, given the clicked square. */
export type MapContextAction = {
    id: string;
    label: string;
    disabled?: boolean;
    danger?: boolean;
    onSelect: (coords: { x: number; y: number }) => void;
};

export type PzMapHandle = {
    getMap: () => L.Map | null;
    /** Centre the view on a world square. */
    flyTo: (x: number, y: number, zoom?: number) => void;
    /** Centre on a player and open their popup. */
    focusMarker: (username: string) => void;
    setFullscreen: (on: boolean) => void;
};

type PzMapProps = {
    markers?: PlayerMarker[];
    mapConfig: MapConfig;
    hasTiles: boolean;
    className?: string;
    interactive?: boolean;
    /** Show vanilla-style color legend (vector basemaps). */
    showLegend?: boolean;
    /** Show baked Map= pack chips (vector basemaps). */
    showPacks?: boolean;
    /** Live cursor world-square readout. */
    showCoordinates?: boolean;
    /** Fit-world / fit-players toolbar (vector mode default). */
    showFitControls?: boolean;
    /** Expand-to-page button. */
    showFullscreen?: boolean;
    /** Overlay on/off panel. Defaults to on when there is more than one overlay. */
    showLayerPanel?: boolean;
    /**
     * Mirror the view into the URL hash as #x/y/zoom, so a position can be
     * linked to. Only one map per page should own the hash.
     */
    syncHash?: boolean;
    onMarkerClick?: (marker: PlayerMarker) => void;
    onMarkerAction?: (marker: PlayerMarker, action: MarkerAction) => void;
    zones?: ZoneOverlay[];
    drawingMode?: boolean;
    onZoneDrawn?: (zone: DrawnZone) => void;
    selectedZoneId?: string | null;
    onZoneClick?: (zone: ZoneOverlay) => void;
    eventMarkers?: EventMarker[];
    onEventMarkerClick?: (marker: EventMarker) => void;
    vehicles?: VehicleMarker[];
    activity?: ActivityPoint[];
    contextActions?: MapContextAction[];
    onMapReady?: (map: L.Map) => void;
    ref?: Ref<PzMapHandle>;
};

const statusColors: Record<PlayerMarker['status'], string> = {
    online: '#22c55e',
    offline: '#9ca3af',
    dead: '#ef4444',
};

const labelColors: Record<PlayerMarker['status'], string> = {
    online: '#4ade80',
    offline: '#d1d5db',
    dead: '#f87171',
};

const eventTypeColors: Record<string, string> = {
    pvp_hit: '#ef4444',
    death: '#9ca3af',
    connect: '#22c55e',
    disconnect: '#f59e0b',
};

const VEHICLE_COLOR = '#38bdf8';

/** Fixed so the right-click menu can be kept on screen without measuring it. */
const CONTEXT_MENU_WIDTH = 180;

/**
 * Player names and safehouse titles come from the game, not from us, so every
 * one of them reaches the DOM through here. Leaflet parses popup, tooltip and
 * divIcon content as HTML.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** How faded an offline marker is, so a month-old position cannot read as news. */
function stalenessOpacity(marker: PlayerMarker): number {
    if (marker.is_online || !marker.last_seen) {
        return 1;
    }

    const days = (Date.now() - new Date(marker.last_seen).getTime()) / 86_400_000;
    if (days >= 7) {
        return 0.4;
    }
    if (days >= 1) {
        return 0.7;
    }

    return 1;
}

function lastSeenText(marker: PlayerMarker, t: Translator): string | null {
    if (marker.is_online) {
        return null;
    }
    if (!marker.last_seen) {
        return t('map.popup.last_seen_unknown');
    }

    const elapsed = Date.now() - new Date(marker.last_seen).getTime();
    const hours = Math.floor(elapsed / 3_600_000);

    if (hours < 1) {
        return t('map.popup.last_seen_recent');
    }
    if (hours < 24) {
        return t('map.popup.last_seen_hours', { count: String(hours) });
    }

    return t('map.popup.last_seen_days', { count: String(Math.floor(hours / 24)) });
}

function createMarkerIcon(
    status: PlayerMarker['status'],
    name: string,
    opacity: number,
): L.DivIcon {
    const color = statusColors[status];
    const labelColor = labelColors[status];

    /**
     * The icon box is the dot and nothing else. The name is painted outside it
     * and cannot be clicked, so a long name no longer covers the players to
     * its right — nor swallows the drag that draws a zone.
     */
    return L.divIcon({
        className: 'pz-marker',
        html: `<div style="position:relative;width:18px;height:18px;opacity:${opacity};">
            <div style="
                width: 18px;
                height: 18px;
                border-radius: 50%;
                background: ${color};
                border: 2px solid white;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5);
                box-sizing: border-box;
            "></div>
            <span style="
                position: absolute;
                left: 24px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
                color: ${labelColor};
                text-shadow: 0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6);
                pointer-events: none;
            ">${escapeHtml(name)}</span>
        </div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -10],
    });
}

function createPopupHtml(marker: PlayerMarker, t: Translator): string {
    const statusLabel = `<span style="color: ${statusColors[marker.status]}; text-transform: capitalize; font-size: 12px;">${escapeHtml(marker.status)}</span>`;
    const coords = `<small style="color: #9ca3af;">X: ${marker.x.toFixed(0)}, Y: ${marker.y.toFixed(0)}, Z: ${marker.z}</small>`;
    const seen = lastSeenText(marker, t);
    const seenLine = seen ? `<br/><small style="color: #9ca3af;">${escapeHtml(seen)}</small>` : '';

    const btnStyle = 'display:inline-block;padding:3px 8px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #374151;background:#1f2937;color:#e5e7eb;margin:2px;';
    const btnDanger = 'display:inline-block;padding:3px 8px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #7f1d1d;background:#991b1b;color:#fecaca;margin:2px;';

    const actions = marker.is_online
        ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:2px;">
            <button class="pz-action" data-action="inventory" style="${btnStyle}">${escapeHtml(t('map.action.inventory'))}</button>
            <button class="pz-action" data-action="access" style="${btnStyle}">${escapeHtml(t('map.action.access'))}</button>
            <button class="pz-action" data-action="kick" style="${btnStyle}">${escapeHtml(t('map.action.kick'))}</button>
            <button class="pz-action" data-action="ban" style="${btnDanger}">${escapeHtml(t('map.action.ban'))}</button>
          </div>`
        : `<div style="margin-top:6px;">
            <button class="pz-action" data-action="inventory" style="${btnStyle}">${escapeHtml(t('map.action.inventory'))}</button>
          </div>`;

    return `<div style="min-width:140px;">
        <strong style="font-size:13px;">${escapeHtml(marker.name)}</strong><br/>
        ${statusLabel}<br/>${coords}${seenLine}
        ${actions}
    </div>`;
}

function createVehiclePopupHtml(vehicle: VehicleMarker, t: Translator): string {
    const fuel = vehicle.fuel_percent === null
        ? ''
        : `<br/><small style="color:#9ca3af;">${escapeHtml(t('map.vehicle.fuel', { percent: String(vehicle.fuel_percent) }))}</small>`;
    const running = vehicle.engine_running
        ? `<br/><small style="color:#fbbf24;">${escapeHtml(t('map.vehicle.running'))}</small>`
        : '';
    const holders = vehicle.key_holders?.length
        ? `<br/><small style="color:#9ca3af;">${escapeHtml(t('map.vehicle.keys', { names: vehicle.key_holders.join(', ') }))}</small>`
        : '';

    return `<div style="min-width:140px;">
        <strong style="font-size:13px;">${escapeHtml(vehicle.model)}</strong>${fuel}${running}${holders}
        <br/><small style="color:#9ca3af;">X: ${vehicle.x}, Y: ${vehicle.y}</small>
    </div>`;
}

/** A localised name for an event type, falling back to the raw type. */
function eventTypeLabel(type: string, t: Translator): string {
    const key = `map.event.${type}`;
    const translated = t(key);

    return translated === key ? type.replace('_', ' ') : translated;
}

/**
 * Create a DZI tile layer.
 * pzmap2dzi outputs tiles as {z}/{x}_{y}.webp (underscore separator).
 */
function createDziTileLayer(templateUrl: string, options: L.TileLayerOptions): L.TileLayer {
    const Layer = L.TileLayer.extend({
        getTileUrl(coords: L.Coords) {
            return templateUrl
                .replace('{z}', String(coords.z))
                .replace('{x}', String(coords.x))
                .replace('{y}', String(coords.y));
        },
    }) as unknown as new (url: string, opts: L.TileLayerOptions) => L.TileLayer;

    return new Layer(templateUrl, options);
}

/**
 * Create a CRS that maps PZ game coordinates (squares) to DZI tile coordinates.
 *
 * Two modes:
 * - Top-view (sqr=1): Simple linear mapping, PZ coords → pixels 1:1
 * - Isometric (sqr=128): Rotated diamond projection (PZ's 2:1 isometric)
 *
 * The projection converts PZ coords to DZI pixel coords at full resolution.
 * The transformation scales by 1/2^maxNativeZoom so Leaflet tile indices
 * match the DZI pyramid at every zoom level.
 */
function createPzCRS(dzi: DziInfo): L.CRS {
    const scale = 1 / Math.pow(2, dzi.maxNativeZoom);

    if (dzi.isometric) {
        // Isometric: PZ (sx, sy) → diamond rotation → DZI pixels
        // px = (sx - sy) * sqr/2 + x0
        // py = (sx + sy) * sqr/4 + y0 + sqr/4
        const halfSqr = dzi.sqr / 2;
        const quarterSqr = dzi.sqr / 4;
        const yOffset = dzi.y0 + quarterSqr;

        const projection = {
            project(latlng: L.LatLng): L.Point {
                const sx = latlng.lng;
                const sy = -latlng.lat;
                return new L.Point(
                    (sx - sy) * halfSqr + dzi.x0,
                    (sx + sy) * quarterSqr + yOffset,
                );
            },
            unproject(point: L.Point): L.LatLng {
                const pxAdj = (point.x - dzi.x0) / halfSqr;
                const pyAdj = (point.y - yOffset) / quarterSqr;
                const sx = (pxAdj + pyAdj) / 2;
                const sy = (pyAdj - pxAdj) / 2;
                return L.latLng(-sy, sx);
            },
            bounds: L.bounds([0, 0], [dzi.width, dzi.height]),
        };

        return L.Util.extend({}, L.CRS, {
            projection,
            transformation: new L.Transformation(scale, 0, scale, 0),
            scale(zoom: number) { return Math.pow(2, zoom); },
            zoom(s: number) { return Math.log(s) / Math.LN2; },
            infinite: false,
        }) as unknown as L.CRS;
    }

    // Top-view: simple linear mapping
    const pixelScale = dzi.sqr * scale;
    return L.Util.extend({}, L.CRS.Simple, {
        transformation: new L.Transformation(
            pixelScale,
            dzi.x0 * scale,
            -pixelScale,
            -dzi.y0 * scale,
        ),
    });
}

/** Convert a Leaflet LatLng to PZ game coordinates. */
function latLngToPz(ll: L.LatLng): { x: number; y: number } {
    return { x: ll.lng, y: -ll.lat };
}

function isVectorBasemap(mapConfig: MapConfig, hasTiles: boolean): boolean {
    if (mapConfig.source === 'vector' && mapConfig.vectorUrl) {
        return true;
    }

    // Backward-compatible: hasTiles true with no tile URL can still mean vector if vectorUrl set
    return Boolean(hasTiles && mapConfig.vectorUrl && !mapConfig.tileUrl);
}

/** Read #x/y/zoom, if this page was opened on a specific spot. */
function readHashView(): { x: number; y: number; zoom: number } | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const parts = window.location.hash.replace(/^#/, '').split('/');
    if (parts.length < 3) {
        return null;
    }

    const [x, y, zoom] = parts.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) {
        return null;
    }

    return { x, y, zoom };
}

export default function PzMap({
    markers = [],
    mapConfig,
    hasTiles,
    className = '',
    interactive = true,
    showLegend,
    showPacks,
    showCoordinates,
    showFitControls,
    showFullscreen,
    showLayerPanel,
    syncHash = false,
    onMarkerClick,
    onMarkerAction,
    zones,
    drawingMode = false,
    onZoneDrawn,
    selectedZoneId,
    onZoneClick,
    eventMarkers,
    onEventMarkerClick,
    vehicles,
    activity,
    contextActions,
    onMapReady,
    ref,
}: PzMapProps) {
    const { t } = useTranslation();
    const { resolvedAppearance } = useAppearance();
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const vectorLayerRef = useRef<WorldMapVectorLayer | null>(null);
    const markersLayerRef = useRef<L.LayerGroup | null>(null);
    const zonesLayerRef = useRef<L.LayerGroup | null>(null);
    const eventsLayerRef = useRef<L.LayerGroup | null>(null);
    const vehiclesLayerRef = useRef<L.LayerGroup | null>(null);
    const heatLayerRef = useRef<ActivityHeatLayer | null>(null);
    const measureLayerRef = useRef<L.LayerGroup | null>(null);
    /** Player markers by username, so the page can fly to one by name. */
    const markerIndexRef = useRef<Map<string, L.Marker>>(new Map());
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const [measuring, setMeasuring] = useState(false);
    const [measurePoints, setMeasurePoints] = useState<Array<{ x: number; y: number }>>([]);
    const [fullscreen, setFullscreen] = useState(false);
    const [layerPanelOpen, setLayerPanelOpen] = useState(false);
    const [hiddenLayers, setHiddenLayers] = useState<Set<MapLayerId>>(() => new Set());
    const [contextMenu, setContextMenu] = useState<
        { left: number; top: number; x: number; y: number } | null
    >(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const measuringRef = useRef(false);
    measuringRef.current = measuring;
    const drawStateRef = useRef<{
        drawing: boolean;
        startLatLng: L.LatLng | null;
        previewRect: L.Rectangle | null;
    }>({ drawing: false, startLatLng: null, previewRect: null });

    const useVector = isVectorBasemap(mapConfig, hasTiles);
    const legendEnabled = showLegend ?? useVector;
    const packsEnabled = showPacks ?? useVector;
    const coordsEnabled = showCoordinates ?? useVector;
    const fitEnabled = showFitControls ?? (useVector || interactive);
    const fullscreenEnabled = showFullscreen ?? interactive;

    const isHidden = useCallback(
        (layer: MapLayerId) => hiddenLayers.has(layer),
        [hiddenLayers],
    );

    /** Readable from the async basemap load, which outlives this render. */
    const hiddenLayersRef = useRef(hiddenLayers);
    useEffect(() => {
        hiddenLayersRef.current = hiddenLayers;
    }, [hiddenLayers]);

    /** Only offer to hide overlays this map actually has. */
    const availableLayers = useMemo(() => {
        const list: MapLayerId[] = [];
        if (markers.length > 0) list.push('players');
        if (zones && zones.length > 0) list.push('zones');
        if (eventMarkers && eventMarkers.length > 0) list.push('events');
        if (vehicles && vehicles.length > 0) list.push('vehicles');
        if (activity && activity.length > 0) list.push('activity');
        if (useVector) list.push('labels', 'grid');

        return list;
    }, [markers.length, zones, eventMarkers, vehicles, activity, useVector]);

    const layerPanelEnabled =
        (showLayerPanel ?? (interactive && availableLayers.length > 1)) && availableLayers.length > 0;

    // Stable refs for callbacks so event handlers always see latest values
    const onZoneDrawnRef = useRef(onZoneDrawn);
    onZoneDrawnRef.current = onZoneDrawn;
    const drawingModeRef = useRef(drawingMode);
    drawingModeRef.current = drawingMode;

    // Initialize map
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const markerIndex = markerIndexRef.current;

        const vectorMode = isVectorBasemap(mapConfig, hasTiles);
        const dzi = mapConfig.dzi;
        const crs = vectorMode
            ? createWorldSquareCrs()
            : dzi
              ? createPzCRS(dzi)
              : createWorldSquareCrs();
        const maxNativeZoom = dzi?.maxNativeZoom ?? mapConfig.maxZoom;

        const map = L.map(containerRef.current, {
            crs,
            minZoom: mapConfig.minZoom,
            maxZoom: mapConfig.maxZoom,
            zoomSnap: vectorMode ? 0.25 : 1,
            zoomDelta: vectorMode ? 0.5 : 1,
            zoomControl: interactive,
            dragging: interactive,
            scrollWheelZoom: interactive,
            doubleClickZoom: interactive,
            touchZoom: interactive,
            boxZoom: false, // Disable boxZoom so shift-drag doesn't conflict with drawing
            keyboard: interactive,
            attributionControl: false,
        });

        // PZ coords: Leaflet uses [lat, lng] = [-y, x]
        const hashView = syncHash ? readHashView() : null;
        const center = hashView
            ? L.latLng(-hashView.y, hashView.x)
            : L.latLng(-mapConfig.center.y, mapConfig.center.x);
        map.setView(center, hashView?.zoom ?? mapConfig.defaultZoom);

        map.on('mousemove', (e: L.LeafletMouseEvent) => {
            const pz = latLngToPz(e.latlng);
            setCursor({ x: Math.round(pz.x), y: Math.round(pz.y) });
        });
        map.on('mouseout', () => setCursor(null));

        if (vectorMode && mapConfig.vectorUrl) {
            const vectorUrl = mapConfig.vectorUrl;
            const paper = '#dbd7c0';
            // Immediate paper background while JSON loads
            map.getContainer().style.background = paper;

            if (mapConfig.bounds) {
                const [minX, minY, maxX, maxY] = mapConfig.bounds;
                const maxBounds = L.latLngBounds(
                    L.latLng(-maxY - 500, minX - 500),
                    L.latLng(-minY + 500, maxX + 500),
                );
                map.setMaxBounds(maxBounds);
            }

            loadWorldMapVector(vectorUrl)
                .then((data) => {
                    if (mapRef.current !== map) {
                        return; // unmounted
                    }
                    const layer = new WorldMapVectorLayer(data);
                    layer.setDarkMode(document.documentElement.classList.contains('dark'));
                    /** The pack can land after the user has already hidden these. */
                    layer.setShowLabels(!hiddenLayersRef.current.has('labels'));
                    layer.setShowGrid(!hiddenLayersRef.current.has('grid'));
                    layer.addTo(map);
                    vectorLayerRef.current = layer;

                    if (!mapConfig.bounds && data.bounds) {
                        const [minX, minY, maxX, maxY] = data.bounds;
                        map.setMaxBounds(
                            L.latLngBounds(
                                L.latLng(-maxY - 500, minX - 500),
                                L.latLng(-minY + 500, maxX + 500),
                            ),
                        );
                    }
                })
                .catch(() => {
                    if (mapRef.current === map) {
                        addCoordinateGrid(map);
                    }
                });
        } else if (hasTiles && mapConfig.tileUrl && dzi) {
            createDziTileLayer(mapConfig.tileUrl, {
                tileSize: mapConfig.tileSize,
                minZoom: mapConfig.minZoom,
                maxZoom: mapConfig.maxZoom,
                maxNativeZoom,
                noWrap: true,
                crossOrigin: mapConfig.tileUrl.startsWith('http') ? 'anonymous' : undefined,
            }).addTo(map);
        } else {
            addCoordinateGrid(map);
        }

        const vehiclesLayer = L.layerGroup().addTo(map);
        vehiclesLayerRef.current = vehiclesLayer;

        const markersLayer = L.layerGroup().addTo(map);
        markersLayerRef.current = markersLayer;

        const zonesLayer = L.layerGroup().addTo(map);
        zonesLayerRef.current = zonesLayer;

        const eventsLayer = L.layerGroup().addTo(map);
        eventsLayerRef.current = eventsLayer;

        const measureLayer = L.layerGroup().addTo(map);
        measureLayerRef.current = measureLayer;

        mapRef.current = map;

        onMapReady?.(map);

        map.on('click', (e: L.LeafletMouseEvent) => {
            setContextMenu(null);
            if (!measuringRef.current) {
                return;
            }
            const pz = latLngToPz(e.latlng);
            setMeasurePoints((prev) => {
                if (prev.length >= 2) {
                    return [{ x: Math.round(pz.x), y: Math.round(pz.y) }];
                }

                return [...prev, { x: Math.round(pz.x), y: Math.round(pz.y) }];
            });
        });

        map.on('contextmenu', (e: L.LeafletMouseEvent) => {
            if (!interactive) {
                return;
            }
            const pz = latLngToPz(e.latlng);
            const size = map.getSize();
            setContextMenu({
                /** Clamped here, where the viewport size is already known. */
                left: Math.min(e.containerPoint.x, Math.max(0, size.x - CONTEXT_MENU_WIDTH)),
                top: Math.min(e.containerPoint.y, Math.max(0, size.y - 40)),
                x: Math.round(pz.x),
                y: Math.round(pz.y),
            });
        });

        map.on('movestart', () => setContextMenu(null));

        // Drawing event handlers
        map.on('mousedown', (e: L.LeafletMouseEvent) => {
            if (!drawingModeRef.current) return;
            const state = drawStateRef.current;
            state.drawing = true;
            state.startLatLng = e.latlng;
            map.dragging.disable();

            // Create preview rectangle
            state.previewRect = L.rectangle(
                L.latLngBounds(e.latlng, e.latlng),
                { color: '#22c55e', weight: 2, fillOpacity: 0.15, dashArray: '6 4' },
            ).addTo(map);
        });

        map.on('mousemove', (e: L.LeafletMouseEvent) => {
            const state = drawStateRef.current;
            if (!state.drawing || !state.startLatLng || !state.previewRect) return;
            state.previewRect.setBounds(L.latLngBounds(state.startLatLng, e.latlng));
        });

        map.on('mouseup', (e: L.LeafletMouseEvent) => {
            const state = drawStateRef.current;
            if (!state.drawing || !state.startLatLng) return;

            const start = latLngToPz(state.startLatLng);
            const end = latLngToPz(e.latlng);

            // Clean up preview
            if (state.previewRect) {
                map.removeLayer(state.previewRect);
                state.previewRect = null;
            }
            state.drawing = false;
            state.startLatLng = null;

            if (interactive) {
                map.dragging.enable();
            }

            // Minimum 10-unit size check prevents accidental micro-zones
            const x1 = Math.round(Math.min(start.x, end.x));
            const y1 = Math.round(Math.min(start.y, end.y));
            const x2 = Math.round(Math.max(start.x, end.x));
            const y2 = Math.round(Math.max(start.y, end.y));

            if (x2 - x1 < 10 || y2 - y1 < 10) return;

            onZoneDrawnRef.current?.({ x1, y1, x2, y2 });
        });

        return () => {
            map.remove();
            mapRef.current = null;
            vectorLayerRef.current = null;
            markersLayerRef.current = null;
            zonesLayerRef.current = null;
            eventsLayerRef.current = null;
            vehiclesLayerRef.current = null;
            heatLayerRef.current = null;
            measureLayerRef.current = null;
            markerIndex.clear();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const flyTo = useCallback(
        (x: number, y: number, zoom?: number) => {
            const map = mapRef.current;
            if (!map) {
                return;
            }
            map.setView(
                L.latLng(-y, x),
                Math.min(zoom ?? map.getZoom(), mapConfig.maxZoom),
                { animate: true },
            );
        },
        [mapConfig.maxZoom],
    );

    useImperativeHandle(
        ref,
        () => ({
            getMap: () => mapRef.current,
            flyTo,
            focusMarker: (username: string) => {
                const marker = markerIndexRef.current.get(username);
                const map = mapRef.current;
                if (!marker || !map) {
                    return;
                }
                const position = marker.getLatLng();
                map.setView(position, Math.min(mapConfig.maxZoom, Math.max(map.getZoom(), 1)), {
                    animate: true,
                });
                marker.openPopup();
            },
            setFullscreen,
        }),
        [flyTo, mapConfig.maxZoom],
    );

    // Mirror the view into the URL so a spot on the map can be linked to
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !syncHash) {
            return;
        }

        const write = () => {
            const centre = latLngToPz(map.getCenter());
            const hash = `#${Math.round(centre.x)}/${Math.round(centre.y)}/${map.getZoom()}`;
            window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
        };

        map.on('moveend', write);
        map.on('zoomend', write);

        return () => {
            map.off('moveend', write);
            map.off('zoomend', write);
        };
    }, [syncHash]);

    // Dark paper mode for vector basemap
    useEffect(() => {
        vectorLayerRef.current?.setDarkMode(resolvedAppearance === 'dark');
    }, [resolvedAppearance]);

    // Vector basemap sub-layers follow the layer panel
    useEffect(() => {
        vectorLayerRef.current?.setShowLabels(!hiddenLayers.has('labels'));
        vectorLayerRef.current?.setShowGrid(!hiddenLayers.has('grid'));
    }, [hiddenLayers]);

    /**
     * Dismiss the right-click menu on anything that is not it. The map's own
     * click and movestart cover the map; this covers the rest of the page.
     */
    useEffect(() => {
        if (!contextMenu) {
            return;
        }
        const dismiss = (e: MouseEvent) => {
            if (!(e.target instanceof Node) || !contextMenuRef.current?.contains(e.target)) {
                setContextMenu(null);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setContextMenu(null);
            }
        };
        window.addEventListener('mousedown', dismiss);
        window.addEventListener('keydown', onKey);

        return () => {
            window.removeEventListener('mousedown', dismiss);
            window.removeEventListener('keydown', onKey);
        };
    }, [contextMenu]);

    // Fullscreen changes the container size out from under Leaflet
    useEffect(() => {
        const map = mapRef.current;
        if (!map) {
            return;
        }
        const timer = window.setTimeout(() => map.invalidateSize(), 60);

        return () => window.clearTimeout(timer);
    }, [fullscreen]);

    useEffect(() => {
        if (!fullscreen) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setFullscreen(false);
            }
        };
        window.addEventListener('keydown', onKey);

        return () => window.removeEventListener('keydown', onKey);
    }, [fullscreen]);

    // Measure line overlay
    useEffect(() => {
        const layer = measureLayerRef.current;
        if (!layer) {
            return;
        }
        layer.clearLayers();
        if (measurePoints.length === 0) {
            return;
        }
        measurePoints.forEach((p) => {
            L.circleMarker([-p.y, p.x], {
                radius: 5,
                color: '#0ea5e9',
                fillColor: '#38bdf8',
                fillOpacity: 0.9,
                weight: 2,
            }).addTo(layer);
        });
        if (measurePoints.length === 2) {
            const [a, b] = measurePoints;
            L.polyline(
                [
                    [-a.y, a.x],
                    [-b.y, b.x],
                ],
                { color: '#0ea5e9', weight: 2, dashArray: '6 4' },
            ).addTo(layer);
        }
    }, [measurePoints]);

    // Update cursor for drawing mode
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        container.style.cursor = drawingMode ? 'crosshair' : '';
    }, [drawingMode]);

    // Cancel drawing on Escape
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            const state = drawStateRef.current;
            if (state.previewRect && mapRef.current) {
                mapRef.current.removeLayer(state.previewRect);
            }
            state.drawing = false;
            state.startLatLng = null;
            state.previewRect = null;
            if (interactive && mapRef.current) {
                mapRef.current.dragging.enable();
            }
        }
    }, [interactive]);

    useEffect(() => {
        if (drawingMode) {
            window.addEventListener('keydown', handleKeyDown);
            return () => window.removeEventListener('keydown', handleKeyDown);
        }
    }, [drawingMode, handleKeyDown]);

    // Update markers when data changes
    useEffect(() => {
        const layer = markersLayerRef.current;
        if (!layer) return;

        layer.clearLayers();
        markerIndexRef.current.clear();
        if (isHidden('players')) return;

        markers.forEach((marker) => {
            const label = marker.name && marker.name !== marker.username
                ? `${marker.name} (${marker.username})`
                : marker.username;
            const icon = createMarkerIcon(marker.status, label, stalenessOpacity(marker));
            const popup = L.popup().setContent(createPopupHtml(marker, t));
            const lMarker = L.marker([-marker.y, marker.x], { icon })
                .bindPopup(popup)
                .addTo(layer);

            markerIndexRef.current.set(marker.username, lMarker);

            lMarker.on('popupopen', () => {
                const container = popup.getElement();
                if (!container) return;
                container.querySelectorAll<HTMLButtonElement>('.pz-action').forEach((btn) => {
                    btn.addEventListener('click', (ev) => {
                        const action = (ev.currentTarget as HTMLButtonElement).dataset.action as MarkerAction;
                        if (action && onMarkerAction) {
                            onMarkerAction(marker, action);
                            lMarker.closePopup();
                        }
                    });
                });
            });

            if (onMarkerClick) {
                lMarker.on('click', () => onMarkerClick(marker));
            }
        });
    }, [markers, onMarkerClick, onMarkerAction, isHidden, t]);

    // Update zone overlays
    useEffect(() => {
        const layer = zonesLayerRef.current;
        if (!layer) return;

        layer.clearLayers();
        if (!zones || isHidden('zones')) return;

        zones.forEach((zone) => {
            const bounds = L.latLngBounds(
                L.latLng(-zone.y1, zone.x1),
                L.latLng(-zone.y2, zone.x2),
            );

            const isSelected = selectedZoneId === zone.id;
            const rect = L.rectangle(bounds, {
                color: zone.color,
                weight: isSelected ? 3 : 2,
                fillOpacity: isSelected ? 0.25 : 0.1,
                dashArray: isSelected ? undefined : '8 4',
            }).addTo(layer);

            rect.bindTooltip(escapeHtml(zone.name), {
                permanent: true,
                direction: 'center',
                className: 'pz-zone-tooltip',
            });

            if (onZoneClick) {
                rect.on('click', () => onZoneClick(zone));
            }
        });
    }, [zones, selectedZoneId, onZoneClick, isHidden]);

    // Update event markers
    useEffect(() => {
        const layer = eventsLayerRef.current;
        if (!layer) return;

        layer.clearLayers();
        if (!eventMarkers || isHidden('events')) return;

        eventMarkers.forEach((em) => {
            const color = eventTypeColors[em.type] ?? '#9ca3af';
            const circle = L.circleMarker([-em.y, em.x], {
                radius: 7,
                color,
                fillColor: color,
                fillOpacity: 0.7,
                weight: 2,
            }).addTo(layer);

            const targetInfo = em.target
                ? `<br/><small>${escapeHtml(t('map.popup.target', { name: em.target }))}</small>`
                : '';
            circle.bindPopup(
                `<div style="min-width:120px;">
                    <strong>${escapeHtml(em.player)}</strong><br/>
                    <span style="color:${color};text-transform:capitalize;">${escapeHtml(eventTypeLabel(em.type, t))}</span>
                    ${targetInfo}<br/>
                    <small style="color: #9ca3af;">X: ${em.x}, Y: ${em.y}</small>
                </div>`,
            );

            if (onEventMarkerClick) {
                circle.on('click', () => onEventMarkerClick(em));
            }
        });
    }, [eventMarkers, onEventMarkerClick, isHidden, t]);

    // Update vehicle markers
    useEffect(() => {
        const layer = vehiclesLayerRef.current;
        if (!layer) return;

        layer.clearLayers();
        if (!vehicles || isHidden('vehicles')) return;

        vehicles.forEach((vehicle) => {
            L.marker([-vehicle.y, vehicle.x], {
                icon: L.divIcon({
                    className: 'pz-vehicle-marker',
                    html: `<div style="
                        width: 12px;
                        height: 12px;
                        box-sizing: border-box;
                        background: ${vehicle.engine_running ? '#fbbf24' : VEHICLE_COLOR};
                        border: 2px solid rgba(255,255,255,0.85);
                        border-radius: 3px;
                        transform: rotate(45deg);
                        box-shadow: 0 1px 3px rgba(0,0,0,0.5);
                    "></div>`,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6],
                    popupAnchor: [0, -8],
                }),
            })
                .bindPopup(createVehiclePopupHtml(vehicle, t))
                .addTo(layer);
        });
    }, [vehicles, isHidden, t]);

    /**
     * Feed the activity heatmap, building it the first time there is anything
     * to draw. Most maps on the site never ask for one, and an idle heat layer
     * still costs a full-viewport canvas.
     */
    useEffect(() => {
        const map = mapRef.current;
        if (!map) {
            return;
        }

        const points = !activity || isHidden('activity')
            ? []
            : activity.map((point) => ({ x: point.x, y: point.y }));

        if (heatLayerRef.current) {
            heatLayerRef.current.setPoints(points);

            return;
        }

        if (points.length === 0) {
            return;
        }

        const layer = new ActivityHeatLayer(points);
        layer.addTo(map);
        heatLayerRef.current = layer;
    }, [activity, isHidden]);

    const fitWorld = useCallback(() => {
        const map = mapRef.current;
        const b = mapConfig.bounds;
        if (!map || !b) {
            return;
        }
        const [minX, minY, maxX, maxY] = b;
        map.fitBounds(
            L.latLngBounds(L.latLng(-maxY, minX), L.latLng(-minY, maxX)),
            { padding: [28, 28], animate: true },
        );
    }, [mapConfig.bounds]);

    const fitPlayers = useCallback(() => {
        const map = mapRef.current;
        if (!map || markers.length === 0) {
            return;
        }
        const bounds = L.latLngBounds(markers.map((m) => L.latLng(-m.y, m.x)));
        map.fitBounds(bounds, {
            padding: [48, 48],
            maxZoom: Math.min(mapConfig.maxZoom, useVector ? 1.5 : mapConfig.maxZoom - 1),
            animate: true,
        });
    }, [markers, mapConfig.maxZoom, useVector]);

    const fitHome = useCallback(() => {
        const map = mapRef.current;
        if (!map) {
            return;
        }
        map.setView(L.latLng(-mapConfig.center.y, mapConfig.center.x), mapConfig.defaultZoom, {
            animate: true,
        });
    }, [mapConfig.center.x, mapConfig.center.y, mapConfig.defaultZoom]);

    const toggleLayer = useCallback((layer: MapLayerId) => {
        setHiddenLayers((prev) => {
            const next = new Set(prev);
            if (next.has(layer)) {
                next.delete(layer);
            } else {
                next.add(layer);
            }

            return next;
        });
    }, []);

    const packs = mapConfig.maps?.filter((p) => p.name) ?? [];
    const measureDistance =
        measurePoints.length === 2
            ? Math.hypot(measurePoints[1].x - measurePoints[0].x, measurePoints[1].y - measurePoints[0].y)
            : null;

    const toolbarButton =
        'rounded border border-border/70 bg-background/90 px-2 py-1 text-[11px] font-medium shadow-sm backdrop-blur-sm hover:bg-muted';

    return (
        <div
            className={
                fullscreen
                    ? 'fixed inset-0 z-[2000] isolate bg-background'
                    : `relative isolate h-full w-full ${className}`
            }
        >
            <div
                ref={containerRef}
                className={`h-full w-full ${measuring ? 'cursor-crosshair' : ''}`}
            />

            {packsEnabled && packs.length > 0 && (
                <div className="pointer-events-none absolute top-2 left-2 z-[500] flex max-w-[min(100%,20rem)] flex-wrap gap-1">
                    {packs.map((pack) => (
                        <span
                            key={`${pack.name}-${pack.origin}`}
                            className="pointer-events-none rounded border border-border/70 bg-background/90 px-1.5 py-0.5 text-[10px] font-medium shadow-sm backdrop-blur-sm"
                            title={pack.origin || undefined}
                        >
                            {pack.name}
                        </span>
                    ))}
                </div>
            )}

            {(fitEnabled || fullscreenEnabled || layerPanelEnabled) && interactive && (
                <div className="absolute top-2 right-2 z-[500] flex flex-col items-end gap-1">
                    {fullscreenEnabled && (
                        <button
                            type="button"
                            onClick={() => setFullscreen((v) => !v)}
                            className={`${toolbarButton} flex items-center gap-1`}
                            title={fullscreen ? t('map.fullscreen_exit') : t('map.fullscreen_enter')}
                        >
                            {fullscreen ? (
                                <Minimize2 className="size-3.5" />
                            ) : (
                                <Maximize2 className="size-3.5" />
                            )}
                            {fullscreen ? t('map.fullscreen_exit') : t('map.fullscreen_enter')}
                        </button>
                    )}
                    {layerPanelEnabled && (
                        <div className="flex flex-col items-end gap-1">
                            <button
                                type="button"
                                onClick={() => setLayerPanelOpen((v) => !v)}
                                className={`${toolbarButton} flex items-center gap-1 ${
                                    layerPanelOpen ? 'bg-muted' : ''
                                }`}
                                title={t('map.layers.title')}
                            >
                                <Layers className="size-3.5" />
                                {t('map.layers.title')}
                            </button>
                            {layerPanelOpen && (
                                <div className="rounded border border-border/70 bg-background/95 p-2 shadow-sm backdrop-blur-sm">
                                    {availableLayers.map((layer) => (
                                        <label
                                            key={layer}
                                            className="flex cursor-pointer items-center gap-2 py-0.5 text-[11px]"
                                        >
                                            <input
                                                type="checkbox"
                                                className="size-3.5 rounded border-border"
                                                checked={!hiddenLayers.has(layer)}
                                                onChange={() => toggleLayer(layer)}
                                            />
                                            <span>{t(`map.layers.${layer}`)}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {fitEnabled && (
                        <>
                            <button
                                type="button"
                                onClick={fitHome}
                                className={toolbarButton}
                                title={t('map.fit_home')}
                            >
                                {t('map.fit_home')}
                            </button>
                            {mapConfig.bounds && (
                                <button
                                    type="button"
                                    onClick={fitWorld}
                                    className={toolbarButton}
                                    title={t('map.fit_world')}
                                >
                                    {t('map.fit_world')}
                                </button>
                            )}
                            {markers.length > 0 && (
                                <button
                                    type="button"
                                    onClick={fitPlayers}
                                    className={toolbarButton}
                                    title={t('map.fit_players')}
                                >
                                    {t('map.fit_players')}
                                </button>
                            )}
                            {useVector && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMeasuring((v) => !v);
                                        setMeasurePoints([]);
                                    }}
                                    className={`rounded border px-2 py-1 text-[11px] font-medium shadow-sm backdrop-blur-sm ${
                                        measuring
                                            ? 'border-sky-500/50 bg-sky-500/15 text-sky-600 dark:text-sky-300'
                                            : 'border-border/70 bg-background/90 hover:bg-muted'
                                    }`}
                                    title={t('map.measure')}
                                >
                                    {t('map.measure')}
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}

            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className="absolute z-[1200] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
                    style={{
                        left: contextMenu.left,
                        top: contextMenu.top,
                        width: CONTEXT_MENU_WIDTH,
                    }}
                >
                    <div className="border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {t('map.coords', { x: String(contextMenu.x), y: String(contextMenu.y) })}
                    </div>
                    <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={() => {
                            void navigator.clipboard?.writeText(`${contextMenu.x},${contextMenu.y}`);
                            setContextMenu(null);
                        }}
                    >
                        {t('map.context.copy_coords')}
                    </button>
                    {contextActions?.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            disabled={action.disabled}
                            className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40 ${
                                action.danger ? 'text-red-500' : ''
                            }`}
                            onClick={() => {
                                action.onSelect({ x: contextMenu.x, y: contextMenu.y });
                                setContextMenu(null);
                            }}
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            )}

            {measuring && (
                <div className="pointer-events-none absolute top-2 left-1/2 z-[500] -translate-x-1/2 rounded border border-sky-500/40 bg-background/95 px-2 py-1 text-[11px] shadow-sm backdrop-blur-sm">
                    {measureDistance !== null
                        ? t('map.measure_result', {
                              n: String(Math.round(measureDistance)),
                              m: String(Math.round(measureDistance)),
                          })
                        : t('map.measure_hint')}
                </div>
            )}

            {legendEnabled && (
                <div className="absolute bottom-2 left-2 z-[500] max-w-[14rem]">
                    <VectorMapLegend defaultOpen={false} />
                </div>
            )}

            {coordsEnabled && cursor && (
                <div className="pointer-events-none absolute right-2 bottom-2 z-[500] rounded border border-border/70 bg-background/90 px-2 py-1 font-mono text-[11px] shadow-sm backdrop-blur-sm">
                    {t('map.coords', { x: String(cursor.x), y: String(cursor.y) })}
                </div>
            )}
        </div>
    );
}

function addCoordinateGrid(map: L.Map) {
    const gridStyle: L.PolylineOptions = {
        color: '#374151',
        weight: 0.5,
        opacity: 0.5,
    };

    // Draw grid lines every 1000 PZ units
    for (let coord = 0; coord <= 20000; coord += 1000) {
        // Vertical lines (constant x)
        L.polyline(
            [
                [-0, coord],
                [-20000, coord],
            ],
            gridStyle,
        ).addTo(map);

        // Horizontal lines (constant y)
        L.polyline(
            [
                [-coord, 0],
                [-coord, 20000],
            ],
            gridStyle,
        ).addTo(map);
    }

    // Add coordinate labels at grid intersections for key points
    const labelPoints = [5000, 10000, 15000];
    labelPoints.forEach((x) => {
        labelPoints.forEach((y) => {
            L.marker([-y, x], {
                icon: L.divIcon({
                    className: 'pz-grid-label',
                    html: `<span style="
                        font-size: 10px;
                        color: #6b7280;
                        white-space: nowrap;
                        pointer-events: none;
                    ">${x},${y}</span>`,
                    iconSize: [50, 14],
                    iconAnchor: [25, 7],
                }),
                interactive: false,
            }).addTo(map);
        });
    });
}
