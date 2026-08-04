import { Head, Link } from '@inertiajs/react';
import { Newspaper, Pin } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import PublicLayout from '@/layouts/public-layout';
import { formatRelativeTime } from '@/lib/dates';

type Post = {
    id: number;
    slug: string;
    title: string;
    excerpt: string | null;
    pinned: boolean;
    published_at: string | null;
    author: string | null;
};

type Props = {
    server_name: string;
    posts: Post[];
};

export default function News({ server_name, posts }: Props) {
    const { t } = useTranslation();

    return (
        <PublicLayout>
            <Head title={t('news.title')} />

            <div className="mx-auto w-full max-w-4xl px-4 py-10">
                <div className="mb-8 text-center">
                    <Newspaper className="text-muted-foreground mx-auto mb-3 size-10" />
                    <h1 className="text-3xl font-bold tracking-tight">{t('news.title')}</h1>
                    <p className="text-muted-foreground mt-1 text-sm">
                        {t('news.description', { server: server_name })}
                    </p>
                </div>

                {posts.length === 0 ? (
                    <Card>
                        <CardContent className="py-12 text-center">
                            <p className="font-medium">{t('news.empty')}</p>
                            <p className="text-muted-foreground text-sm">{t('news.empty_desc')}</p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-4">
                        {posts.map((post) => (
                            <Card key={post.id} className="transition-colors hover:border-primary/40">
                                <CardContent className="pt-6">
                                    <Link href={`/news/${post.slug}`} className="group block">
                                        <div className="flex items-start justify-between gap-3">
                                            <h2 className="text-lg font-semibold underline-offset-4 group-hover:underline">
                                                {post.title}
                                            </h2>
                                            {post.pinned && (
                                                <Pin className="text-muted-foreground mt-1 size-4 shrink-0" />
                                            )}
                                        </div>
                                        {post.excerpt && (
                                            <p className="text-muted-foreground mt-1.5 text-sm">{post.excerpt}</p>
                                        )}
                                        <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                            {post.published_at && (
                                                <span>{formatRelativeTime(post.published_at, t)}</span>
                                            )}
                                            {post.author && <span>{t('news.by', { author: post.author })}</span>}
                                        </div>
                                    </Link>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </PublicLayout>
    );
}
