import L from 'leaflet';

/**
 * Compact worldmap vector payload (baked from worldmap.xml).
 * Cell-indexed for viewport culling — only draw cells that intersect the view.
 */
export type WorldMapVectorData = {
    v: number;
    source?: string;
    cellSize: number;
    bounds: [number, number, number, number];
    bg: [number, number, number];
    styles: Record<string, { fill: string; minZ: number; order: number }>;
    cells: Record<string, Array<[string, number[]]>>;
    labels: Array<{ t: string; x: number; y: number; k: string; s: number }>;
};

type LayerStyle = { fill: string; minZ: number; order: number };

const DEFAULT_BG = 'rgb(219, 215, 192)';

/**
 * Leaflet layer that paints the vanilla schematic world map on a single canvas.
 * Uses world-square CRS (lat = -y, lng = x) with CRS.Simple-style scaling.
 */
export class WorldMapVectorLayer extends L.Layer {
    private data: WorldMapVectorData;

    private mapRef: L.Map | null = null;

    private canvas: HTMLCanvasElement | null = null;

    private ctx: CanvasRenderingContext2D | null = null;

    private cellSize: number;

    private sortedStyles: Array<[string, LayerStyle]>;

    private cellIndex: Map<string, Array<[string, number[]]>>;

    private redrawScheduled = false;

    private darkMode = false;

    constructor(data: WorldMapVectorData, options?: L.LayerOptions) {
        super(options);
        this.data = data;
        this.cellSize = data.cellSize || 300;
        this.sortedStyles = Object.entries(data.styles).sort((a, b) => a[1].order - b[1].order);
        this.cellIndex = new Map(Object.entries(data.cells));
    }

    /** Dark UI: deeper paper + slightly lifted fills for contrast. */
    setDarkMode(dark: boolean): void {
        if (this.darkMode === dark) {
            return;
        }
        this.darkMode = dark;
        this.scheduleRedraw();
    }

    onAdd(map: L.Map): this {
        this.mapRef = map;
        const pane = map.getPane('tilePane') ?? map.getPanes().overlayPane;
        const canvas = L.DomUtil.create('canvas', 'pz-vector-basemap') as HTMLCanvasElement;
        canvas.style.position = 'absolute';
        canvas.style.left = '0';
        canvas.style.top = '0';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '200';
        pane.insertBefore(canvas, pane.firstChild);
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });

        map.on('moveend', this.scheduleRedraw, this);
        map.on('zoomend', this.scheduleRedraw, this);
        map.on('resize', this.scheduleRedraw, this);
        map.on('viewreset', this.scheduleRedraw, this);
        // Live pan/zoom for smoother UX (throttled via rAF)
        map.on('move', this.scheduleRedraw, this);
        map.on('zoom', this.scheduleRedraw, this);

        this.redraw();

        return this;
    }

    onRemove(map: L.Map): this {
        map.off('moveend', this.scheduleRedraw, this);
        map.off('zoomend', this.scheduleRedraw, this);
        map.off('resize', this.scheduleRedraw, this);
        map.off('viewreset', this.scheduleRedraw, this);
        map.off('move', this.scheduleRedraw, this);
        map.off('zoom', this.scheduleRedraw, this);

        if (this.canvas?.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
        this.mapRef = null;

        return this;
    }

    private scheduleRedraw = (): void => {
        if (this.redrawScheduled) {
            return;
        }
        this.redrawScheduled = true;
        requestAnimationFrame(() => {
            this.redrawScheduled = false;
            this.redraw();
        });
    };

    private redraw(): void {
        const map = this.mapRef;
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!map || !canvas || !ctx) {
            return;
        }

        const size = map.getSize();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(size.x * dpr));
        const h = Math.max(1, Math.round(size.y * dpr));

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = `${size.x}px`;
            canvas.style.height = `${size.y}px`;
        }

        const zoom = map.getZoom();

        // Align canvas with map pane origin
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(canvas, topLeft);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const paper = this.paperColor();
        ctx.fillStyle = paper;
        ctx.fillRect(0, 0, size.x, size.y);

        const bounds = map.getBounds();
        // Pad view so pan doesn't flash empty edges mid-gesture
        const pad = this.cellSize * 0.5;
        const minX = bounds.getWest() - pad;
        const maxX = bounds.getEast() + pad;
        const minY = -bounds.getNorth() - pad; // lat = -y
        const maxY = -bounds.getSouth() + pad;

        const cellMinX = Math.floor(minX / this.cellSize);
        const cellMaxX = Math.floor(maxX / this.cellSize);
        const cellMinY = Math.floor(minY / this.cellSize);
        const cellMaxY = Math.floor(maxY / this.cellSize);

        // Bucket features by layer for correct paint order
        const buckets = new Map<string, number[][]>();
        for (const [layerId] of this.sortedStyles) {
            buckets.set(layerId, []);
        }

        for (let cy = cellMinY; cy <= cellMaxY; cy++) {
            for (let cx = cellMinX; cx <= cellMaxX; cx++) {
                const features = this.cellIndex.get(`${cx},${cy}`);
                if (!features) {
                    continue;
                }
                for (const [layerId, ring] of features) {
                    const style = this.data.styles[layerId];
                    if (!style || zoom < style.minZ) {
                        continue;
                    }
                    // Quick bbox reject
                    if (!ringIntersects(ring, minX, minY, maxX, maxY)) {
                        continue;
                    }
                    const list = buckets.get(layerId);
                    if (list) {
                        list.push(ring);
                    }
                }
            }
        }

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        for (const [layerId, style] of this.sortedStyles) {
            if (zoom < style.minZ) {
                continue;
            }
            const rings = buckets.get(layerId);
            if (!rings || rings.length === 0) {
                continue;
            }

            ctx.beginPath();
            for (const ring of rings) {
                this.pathRing(ctx, map, ring, topLeft);
            }

            const fill = this.tintFill(style.fill);
            const isRoad = layerId.startsWith('road-') || layerId === 'railway';
            if (isRoad) {
                // Roads in worldmap.xml are often thin polygons; fill + light stroke
                ctx.fillStyle = fill;
                ctx.fill();
                ctx.strokeStyle = fill;
                ctx.lineWidth = layerId === 'road-trail' ? 0.6 : layerId === 'railway' ? 0.8 : 0.5;
                ctx.stroke();
            } else {
                ctx.fillStyle = fill;
                // Forest cell massing: soft opacity so towns still read on top
                if (layerId === 'forest') {
                    ctx.globalAlpha = this.darkMode ? 0.55 : 0.65;
                }
                ctx.fill();
                ctx.globalAlpha = 1;
                // Subtle building outline at higher zoom for readability
                if (layerId.startsWith('building') && zoom >= 1) {
                    ctx.strokeStyle = this.darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.18)';
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
            }
        }

        this.drawLabels(ctx, map, topLeft, zoom, minX, minY, maxX, maxY);

        // Cell grid at high zoom (usability — matches admin mental model of PZ cells)
        if (zoom >= 1.5) {
            this.drawCellGrid(ctx, map, topLeft, cellMinX, cellMaxX, cellMinY, cellMaxY, zoom);
        }
    }

    private pathRing(
        ctx: CanvasRenderingContext2D,
        map: L.Map,
        ring: number[],
        topLeft: L.Point,
    ): void {
        const n = ring.length;
        if (n < 6) {
            return;
        }
        for (let i = 0; i < n; i += 2) {
            const pt = map.latLngToLayerPoint(L.latLng(-ring[i + 1], ring[i]));
            const x = pt.x - topLeft.x;
            const y = pt.y - topLeft.y;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.closePath();
    }

    private drawLabels(
        ctx: CanvasRenderingContext2D,
        map: L.Map,
        topLeft: L.Point,
        zoom: number,
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
    ): void {
        const labels = this.data.labels;
        if (!labels?.length) {
            return;
        }

        for (const label of labels) {
            if (label.x < minX || label.x > maxX || label.y < minY || label.y > maxY) {
                continue;
            }

            const minZ = labelMinZoom(label.k);
            if (zoom < minZ) {
                continue;
            }

            const pt = map.latLngToLayerPoint(L.latLng(-label.y, label.x));
            const x = pt.x - topLeft.x;
            const y = pt.y - topLeft.y;

            const fontSize = Math.max(10, Math.min(28, 11 * Math.pow(2, zoom / 2) * (label.s || 1)));
            const isTown = label.k === 'town';
            const isWater = label.k === 'water';

            ctx.font = `${isTown ? '700' : '600'} ${fontSize}px "Segoe UI", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (isWater) {
                ctx.fillStyle = 'rgba(30, 80, 90, 0.85)';
                ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            } else if (isTown) {
                ctx.fillStyle = 'rgba(40, 35, 30, 0.9)';
                ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            } else {
                ctx.fillStyle = 'rgba(50, 45, 40, 0.85)';
                ctx.strokeStyle = 'rgba(255,255,255,0.4)';
            }

            ctx.lineWidth = Math.max(2, fontSize * 0.12);
            ctx.strokeText(label.t, x, y);
            ctx.fillText(label.t, x, y);
        }
    }

    private drawCellGrid(
        ctx: CanvasRenderingContext2D,
        map: L.Map,
        topLeft: L.Point,
        cellMinX: number,
        cellMaxX: number,
        cellMinY: number,
        cellMaxY: number,
        zoom: number,
    ): void {
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (let cx = cellMinX; cx <= cellMaxX + 1; cx++) {
            const x = cx * this.cellSize;
            const a = map.latLngToLayerPoint(L.latLng(-(cellMinY * this.cellSize), x));
            const b = map.latLngToLayerPoint(L.latLng(-((cellMaxY + 1) * this.cellSize), x));
            ctx.moveTo(a.x - topLeft.x, a.y - topLeft.y);
            ctx.lineTo(b.x - topLeft.x, b.y - topLeft.y);
        }
        for (let cy = cellMinY; cy <= cellMaxY + 1; cy++) {
            const y = cy * this.cellSize;
            const a = map.latLngToLayerPoint(L.latLng(-y, cellMinX * this.cellSize));
            const b = map.latLngToLayerPoint(L.latLng(-y, (cellMaxX + 1) * this.cellSize));
            ctx.moveTo(a.x - topLeft.x, a.y - topLeft.y);
            ctx.lineTo(b.x - topLeft.x, b.y - topLeft.y);
        }
        ctx.stroke();

        if (zoom >= 2.5) {
            ctx.fillStyle = 'rgba(80,70,60,0.45)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (let cy = cellMinY; cy <= cellMaxY; cy++) {
                for (let cx = cellMinX; cx <= cellMaxX; cx++) {
                    const pt = map.latLngToLayerPoint(
                        L.latLng(-(cy * this.cellSize + 8), cx * this.cellSize + 8),
                    );
                    ctx.fillText(`${cx},${cy}`, pt.x - topLeft.x, pt.y - topLeft.y);
                }
            }
        }
    }

    private paperColor(): string {
        if (this.darkMode) {
            return 'rgb(42, 44, 40)';
        }
        const bg = this.data.bg;
        if (bg) {
            return `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
        }

        return DEFAULT_BG;
    }

    /** Lift fills slightly on dark paper so roads/buildings stay readable. */
    private tintFill(hex: string): string {
        if (!this.darkMode || !hex.startsWith('#') || hex.length < 7) {
            return hex;
        }
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const lift = (c: number) => Math.min(255, Math.round(c * 0.75 + 55));

        return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
    }
}

function ringIntersects(
    ring: number[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
): boolean {
    let rMinX = Infinity;
    let rMinY = Infinity;
    let rMaxX = -Infinity;
    let rMaxY = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i];
        const y = ring[i + 1];
        if (x < rMinX) rMinX = x;
        if (y < rMinY) rMinY = y;
        if (x > rMaxX) rMaxX = x;
        if (y > rMaxY) rMaxY = y;
    }

    return !(rMaxX < minX || rMinX > maxX || rMaxY < minY || rMinY > maxY);
}

function labelMinZoom(kind: string): number {
    switch (kind) {
        case 'town':
            return -3.5;
        case 'water':
            return -2.5;
        case 'place':
            return -1;
        case 'building':
            return 0.5;
        case 'forest':
            return -1;
        default:
            return -2;
    }
}

/** CRS: 1 world square = 1 map unit; zoom 0 → 1 px/unit. */
export function createWorldSquareCrs(): L.CRS {
    return L.Util.extend({}, L.CRS.Simple, {
        scale(zoom: number) {
            return Math.pow(2, zoom);
        },
        zoom(scale: number) {
            return Math.log(scale) / Math.LN2;
        },
        distance(latlng1: L.LatLng, latlng2: L.LatLng) {
            const dx = latlng2.lng - latlng1.lng;
            const dy = latlng2.lat - latlng1.lat;

            return Math.sqrt(dx * dx + dy * dy);
        },
        infinite: false,
    }) as unknown as L.CRS;
}

const vectorCache = new Map<string, Promise<WorldMapVectorData>>();

export function loadWorldMapVector(url: string): Promise<WorldMapVectorData> {
    const existing = vectorCache.get(url);
    if (existing) {
        return existing;
    }

    const promise = fetch(url, { credentials: 'same-origin' })
        .then(async (res) => {
            if (!res.ok) {
                throw new Error(`Failed to load vector basemap (${res.status})`);
            }

            return (await res.json()) as WorldMapVectorData;
        })
        .catch((err) => {
            vectorCache.delete(url);
            throw err;
        });

    vectorCache.set(url, promise);

    return promise;
}
