import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pin } from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { newsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

export function NewsBand() {
  const { t, intlLocale } = useTranslation()
  const list = useQuery(newsQuery)
  const posts = (list.data ?? []).slice(0, 3)

  return (
    <Section id="news" className="border-b border-fence">
      <Container>
        <SectionHeading
          eyebrow={t('news.eyebrow')}
          title={t('news.latest')}
          description={t('news.subtitle')}
        />

        {list.isPending ? (
          <div className="grid gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-36" />
            ))}
          </div>
        ) : posts.length === 0 ? (
          <Panel bracketed className="px-5 py-10 text-center text-sm text-dust">
            {t('news.empty')}
          </Panel>
        ) : (
          <ul className="grid gap-3 md:grid-cols-3">
            {posts.map((post) => (
              <li key={post.id}>
                <Link
                  to="/news/$slug"
                  params={{ slug: post.slug }}
                  className="flex h-full flex-col border border-fence bg-ash p-4 transition-colors hover:border-fence-bright"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {post.pinned ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                        <Pin aria-hidden="true" className="size-3" />
                        {t('news.pinned')}
                      </span>
                    ) : null}
                    {post.published_at ? (
                      <time
                        dateTime={post.published_at}
                        className="font-mono text-[0.625rem] tracking-widest text-dust uppercase"
                      >
                        {formatDateTime(post.published_at, intlLocale)}
                      </time>
                    ) : null}
                  </div>
                  <h3 className="display mt-2 text-xl text-bone">{post.title}</h3>
                  {post.excerpt ? (
                    <p className="mt-2 line-clamp-3 text-sm text-smoke">{post.excerpt}</p>
                  ) : null}
                  <span className="mt-auto pt-4 font-mono text-[0.6875rem] tracking-widest text-hazard uppercase">
                    {t('news.read')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6">
          <Link
            to="/news"
            className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase hover:text-bone"
          >
            {t('news.view_all')}
          </Link>
        </div>
      </Container>
    </Section>
  )
}
