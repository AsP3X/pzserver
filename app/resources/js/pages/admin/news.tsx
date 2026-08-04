import { Head, router } from '@inertiajs/react';
import { Megaphone, Pencil, Pin, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { fetchAction } from '@/lib/fetch-action';
import type { BreadcrumbItem } from '@/types';

type Post = {
    id: number;
    slug: string;
    title: string;
    excerpt: string | null;
    body: string;
    pinned: boolean;
    published_at: string | null;
    is_published: boolean;
    author: string | null;
    created_at: string | null;
};

type Broadcast = {
    id: number;
    message: string;
    cadence: 'interval' | 'daily';
    interval_minutes: number | null;
    time: string | null;
    timezone: string;
    enabled: boolean;
    last_sent_at: string | null;
};

type Props = {
    posts: Post[];
    broadcasts: Broadcast[];
};

type Draft = {
    title: string;
    excerpt: string;
    body: string;
    pinned: boolean;
    publish: boolean;
    broadcast: boolean;
};

const emptyDraft: Draft = {
    title: '',
    excerpt: '',
    body: '',
    pinned: false,
    publish: true,
    broadcast: false,
};

type BroadcastDraft = {
    message: string;
    cadence: 'interval' | 'daily';
    interval_minutes: number;
    time: string;
};

const emptyBroadcast: BroadcastDraft = {
    message: '',
    cadence: 'interval',
    interval_minutes: 60,
    time: '18:00',
};

export default function AdminNews({ posts, broadcasts }: Props) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<Post | null>(null);
    const [deleting, setDeleting] = useState<Post | null>(null);
    const [draft, setDraft] = useState<Draft>(emptyDraft);
    const [saving, setSaving] = useState(false);
    const [broadcastDraft, setBroadcastDraft] = useState<BroadcastDraft>(emptyBroadcast);
    const [addingBroadcast, setAddingBroadcast] = useState(false);

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('admin.news.breadcrumb'), href: '/admin/news' },
    ];

    function openCreate() {
        setEditing(null);
        setDraft(emptyDraft);
        setOpen(true);
    }

    function openEdit(post: Post) {
        setEditing(post);
        setDraft({
            title: post.title,
            excerpt: post.excerpt ?? '',
            body: post.body,
            pinned: post.pinned,
            publish: post.is_published,
            /** Editing never re-announces; that is what a new post is for. */
            broadcast: false,
        });
        setOpen(true);
    }

    async function save() {
        setSaving(true);

        const payload = {
            title: draft.title,
            excerpt: draft.excerpt || null,
            body: draft.body,
            pinned: draft.pinned,
            published_at: draft.publish ? (editing?.published_at ?? new Date().toISOString()) : null,
        };

        const result = editing
            ? await fetchAction(`/admin/news/${editing.id}`, { method: 'PATCH', data: payload })
            : await fetchAction('/admin/news', { data: { ...payload, broadcast: draft.broadcast } });

        setSaving(false);

        if (result) {
            setOpen(false);
            setEditing(null);
            setDraft(emptyDraft);
            router.reload({ only: ['posts'] });
        }
    }

    async function confirmDelete() {
        if (!deleting) return;
        await fetchAction(`/admin/news/${deleting.id}`, { method: 'DELETE' });
        setDeleting(null);
        router.reload({ only: ['posts'] });
    }

    async function addBroadcast() {
        setAddingBroadcast(true);

        const result = await fetchAction('/admin/broadcasts', {
            data: {
                message: broadcastDraft.message,
                cadence: broadcastDraft.cadence,
                interval_minutes:
                    broadcastDraft.cadence === 'interval' ? broadcastDraft.interval_minutes : null,
                time: broadcastDraft.cadence === 'daily' ? broadcastDraft.time : null,
            },
        });

        setAddingBroadcast(false);

        if (result) {
            setBroadcastDraft(emptyBroadcast);
            router.reload({ only: ['broadcasts'] });
        }
    }

    async function broadcastAction(broadcast: Broadcast, action: 'toggle' | 'send' | 'delete') {
        if (action === 'delete') {
            await fetchAction(`/admin/broadcasts/${broadcast.id}`, { method: 'DELETE' });
        } else {
            await fetchAction(`/admin/broadcasts/${broadcast.id}/${action}`);
        }

        router.reload({ only: ['broadcasts'] });
    }

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.news.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">{t('admin.news.title')}</h1>
                        <p className="text-muted-foreground text-sm">{t('admin.news.description')}</p>
                    </div>
                    <Button onClick={openCreate}>
                        <Plus className="mr-1.5 size-4" />
                        {t('admin.news.new_post')}
                    </Button>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.news.posts')}</CardTitle>
                        <CardDescription>{t('admin.news.posts_desc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                        {posts.length === 0 ? (
                            <p className="text-muted-foreground py-8 text-center">{t('admin.news.no_posts')}</p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('admin.news.post')}</TableHead>
                                        <TableHead>{t('common.status')}</TableHead>
                                        <TableHead>{t('admin.news.published')}</TableHead>
                                        <TableHead>{t('common.actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {posts.map((post) => (
                                        <TableRow key={post.id}>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    {post.pinned && (
                                                        <Pin className="text-muted-foreground size-3.5 shrink-0" />
                                                    )}
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium">{post.title}</p>
                                                        {post.author && (
                                                            <p className="text-muted-foreground text-xs">
                                                                {t('news.by', { author: post.author })}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant={post.is_published ? 'secondary' : 'outline'}>
                                                    {post.is_published
                                                        ? t('admin.news.status_published')
                                                        : post.published_at
                                                          ? t('admin.news.status_scheduled')
                                                          : t('admin.news.status_draft')}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <span className="text-muted-foreground text-xs">
                                                    {post.published_at
                                                        ? formatRelativeTime(post.published_at, t)
                                                        : '—'}
                                                </span>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="size-8 p-0"
                                                        onClick={() => openEdit(post)}
                                                    >
                                                        <Pencil className="size-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="size-8 p-0"
                                                        onClick={() => setDeleting(post)}
                                                    >
                                                        <Trash2 className="size-4 text-destructive" />
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Megaphone className="size-4" />
                            {t('admin.news.broadcasts')}
                        </CardTitle>
                        <CardDescription>{t('admin.news.broadcasts_desc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <div className="flex-1 space-y-2">
                                <Label htmlFor="broadcast-message">{t('admin.news.broadcast_message')}</Label>
                                <Input
                                    id="broadcast-message"
                                    value={broadcastDraft.message}
                                    maxLength={200}
                                    placeholder={t('admin.news.broadcast_placeholder')}
                                    onChange={(e) =>
                                        setBroadcastDraft({ ...broadcastDraft, message: e.target.value })
                                    }
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="broadcast-cadence">{t('admin.news.cadence')}</Label>
                                <select
                                    id="broadcast-cadence"
                                    value={broadcastDraft.cadence}
                                    onChange={(e) =>
                                        setBroadcastDraft({
                                            ...broadcastDraft,
                                            cadence: e.target.value as 'interval' | 'daily',
                                        })
                                    }
                                    className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                                >
                                    <option value="interval">{t('admin.news.cadence_interval')}</option>
                                    <option value="daily">{t('admin.news.cadence_daily')}</option>
                                </select>
                            </div>
                            {broadcastDraft.cadence === 'interval' ? (
                                <div className="space-y-2">
                                    <Label htmlFor="broadcast-interval">{t('admin.news.every_minutes')}</Label>
                                    <Input
                                        id="broadcast-interval"
                                        type="number"
                                        min={5}
                                        max={1440}
                                        className="sm:w-28"
                                        value={broadcastDraft.interval_minutes}
                                        onChange={(e) =>
                                            setBroadcastDraft({
                                                ...broadcastDraft,
                                                interval_minutes: Math.max(
                                                    5,
                                                    Math.min(1440, parseInt(e.target.value) || 60),
                                                ),
                                            })
                                        }
                                    />
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <Label htmlFor="broadcast-time">{t('admin.news.at_time')}</Label>
                                    <Input
                                        id="broadcast-time"
                                        type="time"
                                        className="sm:w-32"
                                        value={broadcastDraft.time}
                                        onChange={(e) =>
                                            setBroadcastDraft({ ...broadcastDraft, time: e.target.value })
                                        }
                                    />
                                </div>
                            )}
                            <Button
                                disabled={addingBroadcast || broadcastDraft.message.trim().length < 2}
                                onClick={addBroadcast}
                            >
                                <Plus className="mr-1.5 size-4" />
                                {t('common.add')}
                            </Button>
                        </div>

                        {broadcasts.length === 0 ? (
                            <p className="text-muted-foreground py-4 text-center text-sm">
                                {t('admin.news.no_broadcasts')}
                            </p>
                        ) : (
                            <div className="divide-y rounded-md border">
                                {broadcasts.map((broadcast) => (
                                    <div
                                        key={broadcast.id}
                                        className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">{broadcast.message}</p>
                                            <p className="text-muted-foreground text-xs">
                                                {broadcast.cadence === 'interval'
                                                    ? t('admin.news.repeats_every', {
                                                          minutes: String(broadcast.interval_minutes ?? 0),
                                                      })
                                                    : t('admin.news.repeats_daily', {
                                                          time: broadcast.time ?? '',
                                                          timezone: broadcast.timezone,
                                                      })}
                                                {broadcast.last_sent_at &&
                                                    ` · ${t('admin.news.last_sent', {
                                                        time: formatRelativeTime(broadcast.last_sent_at, t),
                                                    })}`}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Badge variant={broadcast.enabled ? 'secondary' : 'outline'}>
                                                {broadcast.enabled ? t('common.enabled') : t('common.disabled')}
                                            </Badge>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => broadcastAction(broadcast, 'send')}
                                            >
                                                {t('admin.news.send_now')}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => broadcastAction(broadcast, 'toggle')}
                                            >
                                                {broadcast.enabled ? t('common.disable') : t('common.enable')}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="size-8 p-0"
                                                onClick={() => broadcastAction(broadcast, 'delete')}
                                            >
                                                <Trash2 className="size-4 text-destructive" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            {editing ? t('admin.news.edit_post') : t('admin.news.new_post')}
                        </DialogTitle>
                        <DialogDescription>{t('admin.news.dialog_desc')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="news-title">{t('admin.news.field_title')}</Label>
                            <Input
                                id="news-title"
                                value={draft.title}
                                maxLength={150}
                                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="news-excerpt">{t('admin.news.field_excerpt')}</Label>
                            <Input
                                id="news-excerpt"
                                value={draft.excerpt}
                                maxLength={250}
                                onChange={(e) => setDraft({ ...draft, excerpt: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="news-body">{t('admin.news.field_body')}</Label>
                            <Textarea
                                id="news-body"
                                rows={10}
                                value={draft.body}
                                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                            />
                        </div>

                        <div className="flex flex-col gap-3">
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={draft.publish}
                                    onCheckedChange={(checked) =>
                                        setDraft({ ...draft, publish: checked === true })
                                    }
                                />
                                {t('admin.news.publish_now')}
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={draft.pinned}
                                    onCheckedChange={(checked) =>
                                        setDraft({ ...draft, pinned: checked === true })
                                    }
                                />
                                {t('admin.news.pin_post')}
                            </label>
                            {!editing && (
                                <label className="flex items-center gap-2 text-sm">
                                    <Checkbox
                                        checked={draft.broadcast}
                                        disabled={!draft.publish}
                                        onCheckedChange={(checked) =>
                                            setDraft({ ...draft, broadcast: checked === true })
                                        }
                                    />
                                    <span className="flex items-center gap-1.5">
                                        <Megaphone className="size-3.5" />
                                        {t('admin.news.broadcast_in_game')}
                                    </span>
                                </label>
                            )}
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            disabled={saving || draft.title.trim().length < 3 || draft.body.trim().length === 0}
                            onClick={save}
                        >
                            {t('common.save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={deleting !== null} onOpenChange={(isOpen) => !isOpen && setDeleting(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('admin.news.delete_post')}</DialogTitle>
                        <DialogDescription>
                            {t('admin.news.delete_confirm', { title: deleting?.title ?? '' })}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleting(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button variant="destructive" onClick={confirmDelete}>
                            {t('common.delete')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AppLayout>
    );
}
