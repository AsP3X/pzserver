import L from 'leaflet';

export type HeatPoint = { x: number; y: number; weight?: number };

/** Colour ramp stops, cold (rare) to hot (frequent). */
const RAMP: Array<[number, string]> = [
    [0.0, 'rgba(56, 189, 248, 0)'],
    [0.25, 'rgba(56, 189, 248, 0.75)'],
    [0.5, 'rgba(74, 222, 128, 0.8)'],
    [0.7, 'rgba(250, 204, 21, 0.85)'],
    [1.0, 'rgba(239, 68, 68, 0.9)'],
];

/** Screen radius of one event's contribution, in CSS pixels. */
const POINT_RADIUS = 22;

/** Rendered beyond the viewport so a pan reveals heat, not a hard edge. */
const OVERDRAW = 160;

let rampCache: Uint8ClampedArray | null = null;

/**
 * Lookup table mapping accumulated density (0-255) to RGBA.
 * Built once — it is the same ramp for every layer instance.
 */
function ramp(): Uint8ClampedArray {
    if (rampCache) {
        return rampCache;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return new Uint8ClampedArray(256 * 4);
    }

    const gradient = ctx.createLinearGradient(0, 0, 256, 0);
    for (const [stop, color] of RAMP) {
        gradient.addColorStop(stop, color);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 1);

    rampCache = ctx.getImageData(0, 0, 256, 1).data;

    return rampCache;
}

/**
 * Density overlay for located game events.
 *
 * Draws each point as a soft radial blob into an alpha mask, then recolours
 * the mask through a ramp, so overlapping events read as one hot region
 * rather than a pile of identical dots.
 *
 * Repaints only when the view settles. Between repaints the canvas is
 * positioned in layer coordinates, so it pans and stays glued to the world;
 * the overdraw margin covers what a pan exposes before the repaint lands.
 */
export class ActivityHeatLayer extends L.Layer {
    private points: HeatPoint[];

    private mapRef: L.Map | null = null;

    private canvas: HTMLCanvasElement | null = null;

    private ctx: CanvasRenderingContext2D | null = null;

    private scheduled = false;

    constructor(points: HeatPoint[], options?: L.LayerOptions) {
        super(options);
        this.points = points;
    }

    setPoints(points: HeatPoint[]): void {
        this.points = points;
        this.schedule();
    }

    onAdd(map: L.Map): this {
        this.mapRef = map;
        const canvas = L.DomUtil.create('canvas', 'pz-activity-heat') as HTMLCanvasElement;
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        map.getPanes().overlayPane.appendChild(canvas);
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { willReadFrequently: true });

        map.on('moveend', this.schedule, this);
        map.on('zoomend', this.schedule, this);
        map.on('resize', this.schedule, this);
        map.on('viewreset', this.schedule, this);

        this.render();

        return this;
    }

    onRemove(map: L.Map): this {
        map.off('moveend', this.schedule, this);
        map.off('zoomend', this.schedule, this);
        map.off('resize', this.schedule, this);
        map.off('viewreset', this.schedule, this);

        if (this.canvas?.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
        this.mapRef = null;

        return this;
    }

    private schedule = (): void => {
        if (this.scheduled) {
            return;
        }
        this.scheduled = true;
        requestAnimationFrame(() => {
            this.scheduled = false;
            this.render();
        });
    };

    private render(): void {
        const map = this.mapRef;
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!map || !canvas || !ctx) {
            return;
        }

        const size = map.getSize();
        const width = size.x + OVERDRAW * 2;
        const height = size.y + OVERDRAW * 2;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }

        const topLeft = map.containerPointToLayerPoint([-OVERDRAW, -OVERDRAW]);
        L.DomUtil.setPosition(canvas, topLeft);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        if (this.points.length === 0) {
            return;
        }

        const zoom = map.getZoom();
        const pixelOrigin = map.getPixelOrigin();
        const origin = map.project(L.latLng(0, 0), zoom);
        const unit = map.project(L.latLng(-1, 1), zoom);
        const ox = origin.x - pixelOrigin.x - topLeft.x;
        const oy = origin.y - pixelOrigin.y - topLeft.y;
        const sx = unit.x - origin.x;
        const sy = unit.y - origin.y;

        let painted = 0;
        for (const point of this.points) {
            const px = ox + point.x * sx;
            const py = oy + point.y * sy;
            if (px < -POINT_RADIUS || py < -POINT_RADIUS || px > width + POINT_RADIUS || py > height + POINT_RADIUS) {
                continue;
            }

            const blob = ctx.createRadialGradient(px, py, 0, px, py, POINT_RADIUS);
            const strength = Math.min(1, Math.max(0.15, point.weight ?? 0.45));
            blob.addColorStop(0, `rgba(0, 0, 0, ${strength})`);
            blob.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = blob;
            ctx.fillRect(px - POINT_RADIUS, py - POINT_RADIUS, POINT_RADIUS * 2, POINT_RADIUS * 2);
            painted++;
        }

        if (painted === 0) {
            return;
        }

        this.colorize(ctx, canvas.width, canvas.height);
    }

    /** Swap the accumulated alpha mask for ramp colours, in place. */
    private colorize(ctx: CanvasRenderingContext2D, width: number, height: number): void {
        const image = ctx.getImageData(0, 0, width, height);
        const pixels = image.data;
        const palette = ramp();

        for (let i = 0; i < pixels.length; i += 4) {
            const density = pixels[i + 3];
            if (density === 0) {
                continue;
            }
            const offset = density * 4;
            pixels[i] = palette[offset];
            pixels[i + 1] = palette[offset + 1];
            pixels[i + 2] = palette[offset + 2];
            pixels[i + 3] = palette[offset + 3];
        }

        ctx.putImageData(image, 0, 0);
    }
}
