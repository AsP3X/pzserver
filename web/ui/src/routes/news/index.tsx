import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pin } from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { newsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

export function NewsPage() {
  const { t, intlLocale } = useTranslation()
  const list = useQuery(newsQuery)
  const posts = list.data ?? []

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('news.eyebrow')}
          title={t('news.title')}
          description={t('news.subtitle')}
        />

        {list.isPending ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-28" />
            ))}
          </div>
        ) : posts.length === 0 ? (
          <Panel bracketed className="px-5 py-12 text-center text-sm text-dust">
            {t('news.empty')}
          </Panel>
        ) : (
          <ul className="flex flex-col gap-3">
            {posts.map((post) => (
              <li key={post.id}>
                <Link
                  to="/news/$slug"
                  params={{ slug: post.slug }}
                  className="block border border-fence bg-ash p-5 transition-colors hover:border-fence-bright"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {post.pinned ? (
                      <span className="inline-flex items-center gap-1 border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                        <Pin aria-hidden="true" className="size-3" />
                        {t('news.pinned')}
                      </span>
                    ) : null}
                    {post.published_at ? (
                      <time
                        dateTime={post.published_at}
                        className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase"
                      >
                        {formatDateTime(post.published_at, intlLocale)}
                      </time>
                    ) : null}
                    {post.author ? (
                      <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                        {t('news.by', { name: post.author })}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="display mt-2 text-2xl text-bone">{post.title}</h2>
                  {post.excerpt ? (
                    <p className="mt-2 max-w-3xl text-sm leading-relaxed text-smoke">
                      {post.excerpt}
                    </p>
                  ) : null}
                  <span className="mt-3 inline-block font-mono text-[0.6875rem] tracking-widest text-hazard uppercase">
                    {t('news.read')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </Section>
  )
}
