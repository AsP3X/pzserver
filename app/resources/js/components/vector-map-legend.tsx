import { useState } from 'react';
import { useTranslation } from '@/hooks/use-translation';
import { cn } from '@/lib/utils';

/** Vanilla world-map fill colors (ISMapDefinitions.lua / WorldMapVectorBuilder). */
export const VECTOR_LEGEND_ITEMS = [
    { id: 'water', color: '#3b8d95' },
    { id: 'forest', color: '#aeb89a' },
    { id: 'wood', color: '#bdc5a3' },
    { id: 'road', color: '#867d71' },
    { id: 'trail', color: '#b97a57' },
    { id: 'railway', color: '#c8bfe7' },
    { id: 'residential', color: '#d29e69' },
    { id: 'community', color: '#8b75eb' },
    { id: 'hospitality', color: '#7fcee1' },
    { id: 'industrial', color: '#383635' },
    { id: 'medical', color: '#e58097' },
    { id: 'entertainment', color: '#f5e13c' },
    { id: 'retail', color: '#b8cd54' },
] as const;

type VectorMapLegendProps = {
    className?: string;
    /** Compact collapsed-by-default chip on small maps */
    defaultOpen?: boolean;
};

export default function VectorMapLegend({ className, defaultOpen = true }: VectorMapLegendProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div
            className={cn(
                'pointer-events-auto rounded-md border border-border/80 bg-background/90 text-xs shadow-md backdrop-blur-sm',
                className,
            )}
        >
            <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 font-medium hover:bg-muted/50"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
            >
                <span>{t('map.legend.title')}</span>
                <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <ul className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto border-t border-border/60 px-2.5 py-2 sm:grid-cols-1">
                    {VECTOR_LEGEND_ITEMS.map((item) => (
                        <li key={item.id} className="flex items-center gap-2">
                            <span
                                className="inline-block size-3 shrink-0 rounded-sm border border-black/15"
                                style={{ backgroundColor: item.color }}
                                aria-hidden
                            />
                            <span className="text-muted-foreground">{t(`map.legend.${item.id}`)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
