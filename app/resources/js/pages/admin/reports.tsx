import { Head, router } from '@inertiajs/react';
import { LifeBuoy, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { fetchAction } from '@/lib/fetch-action';
import type { BreadcrumbItem } from '@/types';

type ReportStatus = 'open' | 'investigating' | 'resolved' | 'rejected';

type Report = {
    id: number;
    kind: 'report' | 'support';
    subject: string;
    body: string;
    accused: string | null;
    status: ReportStatus;
    resolution: string | null;
    author: string | null;
    handler: string | null;
    created_at: string | null;
    handled_at: string | null;
};

type Props = {
    reports: Report[];
    open_count: number;
};

const statusVariants: Record<ReportStatus, 'secondary' | 'outline' | 'destructive'> = {
    open: 'secondary',
    investigating: 'secondary',
    resolved: 'outline',
    rejected: 'destructive',
};

export default function AdminReports({ reports, open_count }: Props) {
    const { t } = useTranslation();
    const [target, setTarget] = useState<Report | null>(null);
    const [status, setStatus] = useState<ReportStatus>('resolved');
    const [resolution, setResolution] = useState('');
    const [saving, setSaving] = useState(false);

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('admin.reports.breadcrumb'), href: '/admin/reports' },
    ];

    function openHandler(report: Report) {
        setTarget(report);
        setStatus(report.status === 'open' ? 'investigating' : report.status);
        setResolution(report.resolution ?? '');
    }

    async function save() {
        if (!target) return;
        setSaving(true);

        const result = await fetchAction(`/admin/reports/${target.id}`, {
            method: 'PATCH',
            data: { status, resolution: resolution || null },
        });

        setSaving(false);

        if (result) {
            setTarget(null);
            router.reload({ only: ['reports', 'open_count'] });
        }
    }

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.reports.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('admin.reports.title')}</h1>
                    <p className="text-muted-foreground text-sm">
                        {t('admin.reports.description', { count: String(open_count) })}
                    </p>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.reports.queue')}</CardTitle>
                        <CardDescription>{t('admin.reports.queue_desc')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {reports.length === 0 ? (
                            <p className="text-muted-foreground py-8 text-center text-sm">
                                {t('admin.reports.empty')}
                            </p>
                        ) : (
                            <div className="divide-y rounded-md border">
                                {reports.map((report) => (
                                    <div key={report.id} className="px-4 py-3">
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="flex items-center gap-2 text-sm font-medium">
                                                    {report.kind === 'report' ? (
                                                        <ShieldAlert className="text-muted-foreground size-4" />
                                                    ) : (
                                                        <LifeBuoy className="text-muted-foreground size-4" />
                                                    )}
                                                    {report.subject}
                                                </p>
                                                <p className="text-muted-foreground mt-0.5 text-xs">
                                                    {t('admin.reports.from', { player: report.author ?? '—' })}
                                                    {report.accused &&
                                                        ` · ${t('admin.reports.about', { player: report.accused })}`}
                                                    {report.created_at &&
                                                        ` · ${formatRelativeTime(report.created_at, t)}`}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Badge variant={statusVariants[report.status]}>
                                                    {t(`reports.status.${report.status}`)}
                                                </Badge>
                                                <Button variant="outline" size="sm" onClick={() => openHandler(report)}>
                                                    {t('admin.reports.handle')}
                                                </Button>
                                            </div>
                                        </div>
                                        <p className="text-muted-foreground mt-2 whitespace-pre-wrap text-sm">
                                            {report.body}
                                        </p>
                                        {report.resolution && (
                                            <p className="bg-muted mt-2 rounded-md p-2 text-sm">
                                                <span className="font-medium">
                                                    {report.handler ?? t('admin.reports.team')}:{' '}
                                                </span>
                                                {report.resolution}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Dialog open={target !== null} onOpenChange={(isOpen) => !isOpen && setTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('admin.reports.handle')}</DialogTitle>
                        <DialogDescription>{target?.subject}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="report-status">{t('common.status')}</Label>
                            <select
                                id="report-status"
                                value={status}
                                onChange={(e) => setStatus(e.target.value as ReportStatus)}
                                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                            >
                                <option value="open">{t('reports.status.open')}</option>
                                <option value="investigating">{t('reports.status.investigating')}</option>
                                <option value="resolved">{t('reports.status.resolved')}</option>
                                <option value="rejected">{t('reports.status.rejected')}</option>
                            </select>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="report-resolution">{t('admin.reports.reply')}</Label>
                            <Textarea
                                id="report-resolution"
                                rows={5}
                                value={resolution}
                                onChange={(e) => setResolution(e.target.value)}
                                placeholder={t('admin.reports.reply_placeholder')}
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setTarget(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button disabled={saving} onClick={save}>
                            {t('common.save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AppLayout>
    );
}
