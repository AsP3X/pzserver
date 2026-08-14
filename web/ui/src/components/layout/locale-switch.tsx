import { cn } from '@/lib/cn'
import { labelFor, LOCALES } from '@/i18n/locales'
import { useTranslation } from '@/i18n/use-translation'
import { languagesQuery } from '@/lib/queries'
import { useQuery } from '@tanstack/react-query'

/** Language toggle. Extra locales from the admin editor appear here too. */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useTranslation()
  const languages = useQuery(languagesQuery)
  const codes =
    languages.data && languages.data.length > 0
      ? languages.data.filter((item) => item.is_active).map((item) => item.code)
      : [...LOCALES]

  return (
    <div
      role="group"
      aria-label={t('nav.language')}
      className="flex flex-wrap items-center border border-fence"
    >
      {codes.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLocale(option)}
          aria-pressed={locale === option}
          title={languages.data?.find((item) => item.code === option)?.native_name ?? option}
          className={cn(
            'px-2.5 py-1 font-mono text-[0.6875rem] tracking-widest uppercase transition-colors',
            locale === option ? 'bg-fence text-bone' : 'text-dust hover:text-bone',
          )}
        >
          {labelFor(option)}
        </button>
      ))}
    </div>
  )
}
