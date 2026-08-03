import { Head, router } from '@inertiajs/react';
import { AlertTriangle, CheckCircle2, Link2, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AppLayout from '@/layouts/app-layout';
import { fetchAction } from '@/lib/fetch-action';
import type { BreadcrumbItem } from '@/types';

type Health = {
    path: string;
    healthy: boolean;
    writable: boolean;
    issues: string[];
    directories: Array<{ path: string; exists: boolean; writable: boolean; mode: string | null; sticky: boolean }>;
    files: Array<{
        name: string;
        exists: boolean;
        writable: boolean;
        world_writable: boolean;
        mode: string | null;
        size: number | null;
        mtime: string | null;
        age_seconds: number | null;
    }>;
    recent_errors: string[];
    pending_deposits: number;
    rates: { money_value: number; bundle_value: number };
};

type Checklist = {
    overall_ok: boolean;
    items: Array<{ id: string; label: string; ok: boolean; detail: string; severity: string }>;
    backup: { last_at: string | null; age_hours: number | null; stale: boolean };
    resources: { memory_usage: string | null; memory_limit: string | null; cpu_percent: number | null } | null;
    pending_deposits: number;
};

type DepositRow = {
    id: string;
    username: string;
    status: string;
    money_count: number;
    bundle_count: number;
    total_coins: number;
    message: string | null;
    source: string;
    dry_run: boolean;
    credited: boolean;
    created_at: string | null;
    processed_at: string | null;
};

type Props = {
    health: Health;
    checklist: Checklist;
    deposits: DepositRow[];
    rates: { money_value: number; bundle_value: number };
    mod_updates: Array<{ workshop_id: string; mod_id: string | null; title: string; time_updated: number | null }>;
};

export default function BridgePage({ health, checklist, deposits, rates, mod_updates }: Props) {
    const breadcrumbs: BreadcrumbItem[] = [
        { title: 'Dashboard', href: '/dashboard' },
        { title: 'Lua Bridge', href: '/admin/bridge' },
    ];
    const [busy, setBusy] = useState<string | null>(null);
    const [moneyValue, setMoneyValue] = useState(String(rates.money_value));
    const [bundleValue, setBundleValue] = useState(String(rates.bundle_value));
    const [simUser, setSimUser] = useState('');
    const [forceCoins, setForceCoins] = useState<Record<string, string>>({});
    const [message, setMessage] = useState<string | null>(null);

    async function runRepair() {
        setBusy('repair');
        setMessage(null);
        const res = await fetchAction('/admin/bridge/repair', { method: 'POST' });
        setBusy(null);
        if (res) {
            setMessage(res.ok ? 'Bridge repaired successfully.' : 'Repair finished with remaining issues.');
            router.reload();
        }
    }

    async function saveRates() {
        setBusy('rates');
        await fetchAction('/admin/bridge/rates', {
            method: 'POST',
            data: { money_value: Number(moneyValue), bundle_value: Number(bundleValue) },
        });
        setBusy(null);
        router.reload();
    }

    async function simulate() {
        if (!simUser.trim()) return;
        setBusy('sim');
        const res = await fetchAction('/admin/bridge/deposits/simulate', {
            method: 'POST',
            data: { username: simUser.trim() },
        });
        setBusy(null);
        if (res) {
            setMessage(`Simulate ${res.username}: ${res.status} — ~${res.total_coins} coins (${res.message})`);
            router.reload({ only: ['deposits'] });
        }
    }

    async function cancelDeposit(id: string) {
        setBusy(id);
        await fetchAction(`/admin/bridge/deposits/${id}/cancel`, { method: 'POST' });
        setBusy(null);
        router.reload({ only: ['deposits', 'health', 'checklist'] });
    }

    async function forceCredit(id: string) {
        const coins = Number(forceCoins[id] || '0');
        if (!coins) return;
        setBusy(id);
        await fetchAction(`/admin/bridge/deposits/${id}/force-credit`, {
            method: 'POST',
            data: { coins, message: 'Force-credited by admin from Lua Bridge page' },
        });
        setBusy(null);
        router.reload({ only: ['deposits'] });
    }

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title="Lua Bridge" />
            <div className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
                            <Link2 className="size-6" /> Lua Bridge
                        </h1>
                        <p className="text-muted-foreground text-sm">
                            Health, repair, deposit recovery, rates, and deploy checklist
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={() => router.reload()} disabled={!!busy}>
                            <RefreshCw className="mr-1.5 size-4" /> Refresh
                        </Button>
                        <Button onClick={runRepair} disabled={!!busy}>
                            {busy === 'repair' ? (
                                <Loader2 className="mr-1.5 size-4 animate-spin" />
                            ) : (
                                <Wrench className="mr-1.5 size-4" />
                            )}
                            Repair permissions
                        </Button>
                    </div>
                </div>

                {message && (
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{message}</div>
                )}

                <div className="grid gap-4 lg:grid-cols-3">
                    <Card className={health.healthy ? 'border-green-500/30' : 'border-red-500/40'}>
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                {health.healthy ? (
                                    <CheckCircle2 className="size-4 text-green-500" />
                                ) : (
                                    <AlertTriangle className="size-4 text-red-500" />
                                )}
                                Bridge health
                            </CardTitle>
                            <CardDescription className="font-mono text-xs break-all">{health.path}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex gap-2">
                                <Badge variant={health.healthy ? 'default' : 'destructive'}>
                                    {health.healthy ? 'Healthy' : 'Unhealthy'}
                                </Badge>
                                <Badge variant="secondary">pending deposits: {health.pending_deposits}</Badge>
                            </div>
                            {health.issues.length > 0 && (
                                <ul className="list-inside list-disc text-red-600 dark:text-red-400">
                                    {health.issues.map((i) => (
                                        <li key={i}>{i}</li>
                                    ))}
                                </ul>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base">Deploy checklist</CardTitle>
                            <CardDescription>
                                {checklist.overall_ok ? 'Critical checks passed' : 'Critical issues remain'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            {checklist.items.map((item) => (
                                <div key={item.id} className="flex items-start justify-between gap-2">
                                    <div>
                                        <div className="font-medium">{item.label}</div>
                                        <div className="text-muted-foreground text-xs">{item.detail}</div>
                                    </div>
                                    <Badge variant={item.ok ? 'default' : item.severity === 'critical' ? 'destructive' : 'secondary'}>
                                        {item.ok ? 'OK' : 'Fail'}
                                    </Badge>
                                </div>
                            ))}
                            {checklist.resources && (
                                <div className="text-muted-foreground border-t pt-2 text-xs">
                                    RAM {checklist.resources.memory_usage}
                                    {checklist.resources.memory_limit ? ` / ${checklist.resources.memory_limit}` : ''}
                                    {checklist.resources.cpu_percent != null ? ` · CPU ${checklist.resources.cpu_percent}%` : ''}
                                </div>
                            )}
                            {checklist.backup.stale && (
                                <div className="text-amber-600 text-xs">Backup is stale or missing — check Backups.</div>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base">Exchange rates</CardTitle>
                            <CardDescription>Coins per Money / MoneyBundle (synced to Lua)</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <Label htmlFor="mv">Money</Label>
                                    <Input id="mv" type="number" value={moneyValue} onChange={(e) => setMoneyValue(e.target.value)} />
                                </div>
                                <div>
                                    <Label htmlFor="bv">Bundle</Label>
                                    <Input id="bv" type="number" value={bundleValue} onChange={(e) => setBundleValue(e.target.value)} />
                                </div>
                            </div>
                            <Button size="sm" onClick={saveRates} disabled={!!busy}>
                                {busy === 'rates' && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                                Save rates
                            </Button>
                            <div className="space-y-2 border-t pt-3">
                                <Label>Simulate deposit (dry-run)</Label>
                                <div className="flex gap-2">
                                    <Input placeholder="PZ username" value={simUser} onChange={(e) => setSimUser(e.target.value)} />
                                    <Button variant="outline" onClick={simulate} disabled={!!busy || !simUser.trim()}>
                                        Run
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Bridge files</CardTitle>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="text-muted-foreground border-b">
                                    <th className="py-2 pr-3">File</th>
                                    <th className="py-2 pr-3">Mode</th>
                                    <th className="py-2 pr-3">Writable</th>
                                    <th className="py-2 pr-3">Age</th>
                                    <th className="py-2">Size</th>
                                </tr>
                            </thead>
                            <tbody>
                                {health.files.map((f) => (
                                    <tr key={f.name} className="border-b border-border/50">
                                        <td className="py-1.5 pr-3 font-mono text-xs">{f.name}</td>
                                        <td className="py-1.5 pr-3">{f.mode ?? '—'}</td>
                                        <td className="py-1.5 pr-3">{f.exists ? (f.world_writable ? 'yes' : 'no') : 'missing'}</td>
                                        <td className="py-1.5 pr-3">
                                            {f.age_seconds != null ? `${Math.round(f.age_seconds)}s` : '—'}
                                        </td>
                                        <td className="py-1.5">{f.size ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Deposit audit / recovery</CardTitle>
                        <CardDescription>Stuck pending deposits can be cancelled or force-credited</CardDescription>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="text-muted-foreground border-b">
                                    <th className="py-2 pr-2">User</th>
                                    <th className="py-2 pr-2">Status</th>
                                    <th className="py-2 pr-2">Coins</th>
                                    <th className="py-2 pr-2">Source</th>
                                    <th className="py-2 pr-2">Message</th>
                                    <th className="py-2">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {deposits.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="text-muted-foreground py-4 text-center">
                                            No deposits recorded yet
                                        </td>
                                    </tr>
                                )}
                                {deposits.map((d) => (
                                    <tr key={d.id} className="border-b border-border/50 align-top">
                                        <td className="py-2 pr-2 font-medium">{d.username}</td>
                                        <td className="py-2 pr-2">
                                            <Badge variant={d.status === 'credited' || d.status === 'success' ? 'default' : 'secondary'}>
                                                {d.status}
                                            </Badge>
                                            {d.dry_run && <Badge className="ml-1" variant="outline">dry</Badge>}
                                        </td>
                                        <td className="py-2 pr-2">{d.total_coins}</td>
                                        <td className="py-2 pr-2 text-xs">{d.source}</td>
                                        <td className="text-muted-foreground max-w-[220px] py-2 pr-2 text-xs">{d.message}</td>
                                        <td className="py-2">
                                            <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
                                                {d.status === 'pending' && (
                                                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => cancelDeposit(d.id)}>
                                                        Cancel
                                                    </Button>
                                                )}
                                                {!d.credited && d.status !== 'cancelled' && (
                                                    <div className="flex gap-1">
                                                        <Input
                                                            className="h-8 w-20"
                                                            placeholder="coins"
                                                            value={forceCoins[d.id] ?? String(d.total_coins || '')}
                                                            onChange={(e) => setForceCoins((s) => ({ ...s, [d.id]: e.target.value }))}
                                                        />
                                                        <Button size="sm" disabled={!!busy} onClick={() => forceCredit(d.id)}>
                                                            Credit
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>

                {health.recent_errors.length > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Recent Knox Relay log errors</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                                {health.recent_errors.join('\n')}
                            </pre>
                        </CardContent>
                    </Card>
                )}

                {mod_updates.length > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Workshop mods (sample)</CardTitle>
                            <CardDescription>Titles / last update times from Steam public API</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-1 text-sm">
                            {mod_updates.map((m) => (
                                <div key={m.workshop_id} className="flex justify-between gap-2 border-b border-border/40 py-1">
                                    <span>
                                        {m.title} <span className="text-muted-foreground font-mono text-xs">({m.workshop_id})</span>
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                        {m.time_updated ? new Date(m.time_updated * 1000).toLocaleString() : '—'}
                                    </span>
                                </div>
                            ))}
                        </CardContent>
                    </Card>
                )}
            </div>
        </AppLayout>
    );
}
