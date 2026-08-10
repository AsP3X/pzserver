import { Backpack, LayoutGrid, Package } from 'lucide-react';
import { useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/hooks/use-translation';
import { ALL_ITEMS, MAIN_CONTAINER } from '@/lib/inventory';
import { cn } from '@/lib/utils';

export type ContainerTab = {
    /** Container id, or ALL_ITEMS for the everything-at-once tab. */
    id: string;
    label: string;
    /** Nesting level, so a bag inside a bag reads as one. */
    depth: number;
    worn: boolean;
    /** Rows this tab would show under the current search. */
    count: number;
};

type Props = {
    tabs: ContainerTab[];
    activeId: string;
    onSelect: (id: string) => void;
    /**
     * True while a search is running. Counts then mean "matches in here", which
     * is what turns the strip into an answer to "which bag is my hammer in".
     */
    filtering: boolean;
};

function TabIcon({ tab }: { tab: ContainerTab }) {
    if (tab.id === ALL_ITEMS) {
        return <LayoutGrid className="size-4 shrink-0" />;
    }

    if (tab.id === MAIN_CONTAINER || tab.worn) {
        return <Backpack className="size-4 shrink-0" />;
    }

    return <Package className="size-4 shrink-0" />;
}

/**
 * Horizontal container picker for the inventory table.
 *
 * Replaces paging through every bag's contents in one long list: each container
 * gets a tab, and the table below shows only what is inside the one selected.
 *
 * Hand-rolled rather than pulled from a UI library because the strip has to
 * scroll — a player can carry a dozen bags — and because the roving-tabindex
 * pattern here is the whole of what a tablist needs.
 */
export function ContainerTabs({ tabs, activeId, onSelect, filtering }: Props) {
    const { t } = useTranslation();
    const strip = useRef<HTMLDivElement>(null);

    /** Arrow keys move between tabs; Home/End jump to the ends. */
    function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(event.key)) {
            return;
        }

        event.preventDefault();
        const current = tabs.findIndex((tab) => tab.id === activeId);

        let next = current;
        if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;

        onSelect(tabs[next].id);
        strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }

    return (
        <div
            ref={strip}
            role="tablist"
            aria-label={t('inventory.containers')}
            aria-orientation="horizontal"
            onKeyDown={handleKeyDown}
            className="border-border flex gap-1 overflow-x-auto border-b pb-px"
        >
            {tabs.map((tab) => {
                const active = tab.id === activeId;
                /** Dim a bag that holds nothing matching the current search. */
                const muted = filtering && tab.count === 0;

                return (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        id={`container-tab-${tab.id || 'all'}`}
                        aria-selected={active}
                        aria-controls="container-tabpanel"
                        tabIndex={active ? 0 : -1}
                        onClick={() => onSelect(tab.id)}
                        className={cn(
                            'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors',
                            'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                            active
                                ? 'border-primary text-foreground font-medium'
                                : 'text-muted-foreground hover:text-foreground border-transparent',
                            muted && !active && 'opacity-40',
                        )}
                        style={{ paddingLeft: tab.depth > 0 ? tab.depth * 12 + 12 : undefined }}
                    >
                        <TabIcon tab={tab} />
                        <span>
                            {tab.id === MAIN_CONTAINER ? t('inventory.main_container') : tab.label}
                        </span>
                        <Badge variant={active ? 'default' : 'secondary'} className="text-xs tabular-nums">
                            {tab.count}
                        </Badge>
                    </button>
                );
            })}
        </div>
    );
}
