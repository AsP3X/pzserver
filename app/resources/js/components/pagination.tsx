import { Link } from '@inertiajs/react';
import { Button } from '@/components/ui/button';

type PaginationLink = {
    url: string | null;
    label: string;
    active: boolean;
};

type PaginationProps = {
    currentPage: number;
    lastPage: number;
    links?: PaginationLink[];
    onPageChange?: (page: number) => void;
    baseUrl?: string;
    preserveState?: boolean;
};

export function Pagination({ currentPage, lastPage, links, onPageChange, baseUrl, preserveState = true }: PaginationProps) {
    if (lastPage <= 1) return null;

    if (links) {
        return (
            <div className="mt-4 flex items-center justify-center gap-1">
                {links.map((link, i) => (
                    <div key={i}>
                        {link.url ? (
                            <Link
                                href={link.url}
                                className={`rounded-md px-3 py-1.5 text-sm ${
                                    link.active
                                        ? 'bg-primary text-primary-foreground'
                                        : 'hover:bg-accent'
                                }`}
                                dangerouslySetInnerHTML={{ __html: link.label }}
                                preserveState={preserveState}
                            />
                        ) : (
                            <span
                                className="text-muted-foreground px-3 py-1.5 text-sm"
                                dangerouslySetInnerHTML={{ __html: link.label }}
                            />
                        )}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="mt-4 flex items-center justify-center gap-1">
            {Array.from({ length: lastPage }, (_, i) => i + 1).map((page) => (
                <Button
                    key={page}
                    variant={page === currentPage ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => onPageChange?.(page)}
                >
                    {page}
                </Button>
            ))}
        </div>
    );
}
