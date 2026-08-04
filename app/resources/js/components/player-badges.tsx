import { Award, Crown, GraduationCap, Hammer, Skull, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/hooks/use-translation';

export type PlayerBadge = {
    id: string;
    tier: 'bronze' | 'silver' | 'gold' | null;
    value: number | null;
};

const badgeIcons: Record<string, typeof Award> = {
    slayer: Skull,
    survivor: Timer,
    master: Crown,
    generalist: Hammer,
    professional: GraduationCap,
};

/** Tier colours, muted enough to sit next to the profile stats without shouting. */
const tierStyles: Record<string, string> = {
    bronze: 'border-amber-700/40 text-amber-700 dark:text-amber-500',
    silver: 'border-slate-400/50 text-slate-500 dark:text-slate-300',
    gold: 'border-yellow-500/50 text-yellow-600 dark:text-yellow-400',
};

export function PlayerBadges({ badges }: { badges: PlayerBadge[] }) {
    const { t } = useTranslation();

    if (badges.length === 0) {
        return null;
    }

    return (
        <div className="flex flex-wrap gap-2">
            {badges.map((badge) => {
                const Icon = badgeIcons[badge.id] ?? Award;
                const label = badge.tier
                    ? t(`badges.${badge.id}.${badge.tier}`)
                    : t(`badges.${badge.id}.label`);

                return (
                    <Badge
                        key={badge.id}
                        variant="outline"
                        className={`gap-1.5 ${badge.tier ? tierStyles[badge.tier] : ''}`}
                        title={t(`badges.${badge.id}.description`)}
                    >
                        <Icon className="size-3.5" />
                        {label}
                    </Badge>
                );
            })}
        </div>
    );
}
