import { motion } from 'motion/react';

/**
 * How the game groups perks. Anything the server reports that is not listed
 * here — a modded perk, or one added by a new build — falls into "Other"
 * rather than disappearing.
 */
export const SKILL_CATEGORIES: Record<string, string[]> = {
    Combat: ['Axe', 'Blunt', 'SmallBlunt', 'LongBlade', 'SmallBlade', 'Spear', 'Maintenance'],
    Firearm: ['Aiming', 'Reloading'],
    Crafting: ['Carpentry', 'Cooking', 'Farming', 'Fishing', 'Foraging', 'Trapping', 'Tailoring', 'Metalworking', 'Mechanics', 'Electrical'],
    Survivalist: ['Doctor', 'Lightfoot', 'Nimble', 'Sneak', 'Sprinting', 'Fitness', 'Strength'],
};

export type SkillCategory = {
    category: string;
    skills: { name: string; level: number }[];
};

/**
 * Split a name -> level map into the game's categories, in category order,
 * dropping categories the character has trained nothing in.
 */
export function categoriseSkills(skills: Record<string, number>): SkillCategory[] {
    const categorised: SkillCategory[] = [];
    const assigned = new Set<string>();

    for (const [category, names] of Object.entries(SKILL_CATEGORIES)) {
        const trained = names
            .filter((name) => name in skills)
            .map((name) => {
                assigned.add(name);
                return { name, level: skills[name] };
            });

        if (trained.length > 0) {
            categorised.push({ category, skills: trained });
        }
    }

    const other = Object.entries(skills)
        .filter(([name]) => !assigned.has(name))
        .map(([name, level]) => ({ name, level }));

    if (other.length > 0) {
        categorised.push({ category: 'Other', skills: other });
    }

    return categorised;
}

export function SkillBar({ name, level }: { name: string; level: number }) {
    const maxLevel = 10;
    const pct = Math.min((level / maxLevel) * 100, 100);

    return (
        <div className="flex items-center gap-3">
            <span className="w-24 truncate text-xs text-muted-foreground">{name}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <motion.div
                    className="h-full rounded-full bg-primary"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                />
            </div>
            <span className="w-6 text-right text-xs font-medium tabular-nums">{level}</span>
        </div>
    );
}
