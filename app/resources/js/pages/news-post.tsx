import { Head, Link } from '@inertiajs/react';
import { ArrowLeft, Pin } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import PublicLayout from '@/layouts/public-layout';
import { formatRelativeTime } from '@/lib/dates';

type Post = {
    id: number;
    slug: string;
    title: string;
    excerpt: string | null;
    body: string;
    pinned: boolean;
    published_at: string | null;
    author: string | null;
};

type Props = {
    server_name: string;
    post: Post;
};

export default function NewsPostPage({ post }: Props) {
    const { t } = useTranslation();

    return (
        <PublicLayout>
            <Head title={post.title} />

            <div className="mx-auto w-full max-w-3xl px-4 py-10">
                <Link
                    href="/news"
                    className="text-muted-foreground mb-6 inline-flex items-center gap-1.5 text-sm hover:text-foreground"
                >
                    <ArrowLeft className="size-4" />
                    {t('news.back')}
                </Link>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-bold tracking-tight">{post.title}</h1>
                            {post.pinned && <Pin className="text-muted-foreground mt-1.5 size-4 shrink-0" />}
                        </div>

                        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            {post.published_at && <span>{formatRelativeTime(post.published_at, t)}</span>}
                            {post.author && <span>{t('news.by', { author: post.author })}</span>}
                        </div>

                        {/* Plain text, deliberately: rendering author-supplied HTML here would be an XSS hole. */}
                        <div className="mt-6 whitespace-pre-wrap text-sm leading-relaxed">{post.body}</div>
                    </CardContent>
                </Card>
            </div>
        </PublicLayout>
    );
}
