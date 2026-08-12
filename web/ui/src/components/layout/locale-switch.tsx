import { cn } from '@/lib/cn'
import { LOCALES, LOCALE_LABELS } from '@/i18n/locales'
import { useTranslation } from '@/i18n/use-translation'

/** Two-state language toggle. A dropdown would be overkill for two locales. */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useTranslation()

  return (
    <div
      role="group"
      aria-label={t('nav.language')}
      className="flex items-center border border-fence"
    >
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLocale(option)}
          aria-pressed={locale === option}
          className={cn(
            'px-2.5 py-1 font-mono text-[0.6875rem] tracking-widest uppercase transition-colors',
            locale === option
              ? 'bg-fence text-bone'
              : 'text-dust hover:text-bone',
          )}
        >
          {LOCALE_LABELS[option]}
        </button>
      ))}
    </div>
  )
}
