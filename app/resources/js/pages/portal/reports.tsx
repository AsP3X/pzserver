import { Head, router } from '@inertiajs/react';
import { LifeBuoy, Plus, ShieldAlert } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { fetchAction } from '@/lib/fetch-action';
import type { BreadcrumbItem } from '@/types';

type Report = {
    id: number;
    kind: 'report' | 'support';
    subject: string;
    body: string;
    accused: string | null;
    status: 'open' | 'investigating' | 'resolved' | 'rejected';
    resolution: string | null;
    created_at: string | null;
    handled_at: string | null;
};

type Props = {
    reports: Report[];
};

const statusVariants: Record<Report['status'], 'secondary' | 'outline' | 'destructive'> = {
    open: 'secondary',
    investigating: 'secondary',
    resolved: 'outline',
    rejected: 'destructive',
};

export default function PortalReports({ reports }: Props) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [kind, setKind] = useState<'report' | 'support'>('support');
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [accused, setAccused] = useState('');

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('portal.reports.breadcrumb'), href: '/portal/reports' },
    ];

    async function submit() {
        setSaving(true);

        const result = await fetchAction('/portal/reports', {
            data: {
                kind,
                subject,
                body,
                accused: kind === 'report' ? accused : null,
            },
        });

        setSaving(false);

        if (result) {
            setOpen(false);
            setSubject('');
            setBody('');
            setAccused('');
            router.reload({ only: ['reports'] });
        }
    }

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('portal.reports.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">{t('portal.reports.title')}</h1>
                        <p className="text-muted-foreground text-sm">{t('portal.reports.description')}</p>
                    </div>
                    <Button onClick={() => setOpen(true)}>
                        <Plus className="mr-1.5 size-4" />
                        {t('portal.reports.new')}
                    </Button>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('portal.reports.mine')}</CardTitle>
                        <CardDescription>{t('portal.reports.mine_desc')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {reports.length === 0 ? (
                            <p className="text-muted-foreground py-8 text-center text-sm">
                                {t('portal.reports.empty')}
                            </p>
                        ) : (
                            <div className="divide-y rounded-md border">
                                {reports.map((report) => (
                                    <div key={report.id} className="px-4 py-3">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="flex items-center gap-2 text-sm font-medium">
                                                {report.kind === 'report' ? (
                                                    <ShieldAlert className="text-muted-foreground size-4" />
                                                ) : (
                                                    <LifeBuoy className="text-muted-foreground size-4" />
                                                )}
                                                {report.subject}
                                            </span>
                                            <Badge variant={statusVariants[report.status]}>
                                                {t(`reports.status.${report.status}`)}
                                            </Badge>
                                        </div>
                                        <p className="text-muted-foreground mt-1 whitespace-pre-wrap text-sm">
                                            {report.body}
                                        </p>
                                        <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 text-xs">
                                            {report.accused && (
                                                <span>{t('portal.reports.about', { player: report.accused })}</span>
                                            )}
                                            {report.created_at && <span>{formatRelativeTime(report.created_at, t)}</span>}
                                        </div>
                                        {report.resolution && (
                                            <p className="bg-muted mt-2 rounded-md p-2 text-sm">
                                                <span className="font-medium">{t('portal.reports.reply')}: </span>
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

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t('portal.reports.new')}</DialogTitle>
                        <DialogDescription>{t('portal.reports.dialog_desc')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="report-kind">{t('portal.reports.kind')}</Label>
                            <select
                                id="report-kind"
                                value={kind}
                                onChange={(e) => setKind(e.target.value as 'report' | 'support')}
                                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                            >
                                <option value="support">{t('portal.reports.kind_support')}</option>
                                <option value="report">{t('portal.reports.kind_report')}</option>
                            </select>
                        </div>

                        {kind === 'report' && (
                            <div className="space-y-2">
                                <Label htmlFor="report-accused">{t('portal.reports.accused')}</Label>
                                <Input
                                    id="report-accused"
                                    value={accused}
                                    maxLength={50}
                                    onChange={(e) => setAccused(e.target.value)}
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="report-subject">{t('portal.reports.subject')}</Label>
                            <Input
                                id="report-subject"
                                value={subject}
                                maxLength={150}
                                onChange={(e) => setSubject(e.target.value)}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="report-body">{t('portal.reports.details')}</Label>
                            <Textarea
                                id="report-body"
                                rows={6}
                                value={body}
                                onChange={(e) => setBody(e.target.value)}
                                placeholder={t('portal.reports.details_placeholder')}
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            disabled={
                                saving ||
                                subject.trim().length < 3 ||
                                body.trim().length < 10 ||
                                (kind === 'report' && accused.trim().length === 0)
                            }
                            onClick={submit}
                        >
                            {t('portal.reports.submit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AppLayout>
    );
}
