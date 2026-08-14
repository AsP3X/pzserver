import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, Pin } from 'lucide-react'

import { Container, Section } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { newsPostQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

export function NewsPostPage() {
  const { t, intlLocale } = useTranslation()
  const { slug } = useParams({ strict: false }) as { slug: string }
  const post = useQuery(newsPostQuery(slug))

  return (
    <Section>
      <Container className="max-w-3xl">
        <Link
          to="/news"
          className="inline-flex items-center gap-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase hover:text-bone"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          {t('news.back')}
        </Link>

        {post.isPending ? (
          <div className="mt-6 flex flex-col gap-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-64" />
          </div>
        ) : post.isError || !post.data ? (
          <Panel bracketed className="mt-6 px-5 py-12 text-center text-sm text-dust">
            {t('news.missing')}
          </Panel>
        ) : (
          <article className="mt-6">
            <div className="flex flex-wrap items-center gap-2">
              {post.data.pinned ? (
                <span className="inline-flex items-center gap-1 border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                  <Pin aria-hidden="true" className="size-3" />
                  {t('news.pinned')}
                </span>
              ) : null}
              {post.data.published_at ? (
                <time
                  dateTime={post.data.published_at}
                  className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase"
                >
                  {formatDateTime(post.data.published_at, intlLocale)}
                </time>
              ) : null}
              {post.data.author ? (
                <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                  {t('news.by', { name: post.data.author })}
                </span>
              ) : null}
            </div>
            <h1 className="display mt-3 text-3xl text-bone sm:text-4xl">{post.data.title}</h1>
            {post.data.excerpt ? (
              <p className="mt-3 text-base leading-relaxed text-smoke">{post.data.excerpt}</p>
            ) : null}
            <div className="mt-8 whitespace-pre-wrap text-sm leading-7 text-bone">
              {post.data.body}
            </div>
            <p className="mt-10 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {t('news.updated', {
                date: formatDateTime(post.data.updated_at, intlLocale),
              })}
            </p>
          </article>
        )}
      </Container>
    </Section>
  )
}
