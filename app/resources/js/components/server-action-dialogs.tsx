import { router } from '@inertiajs/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { fetchAction } from '@/lib/fetch-action';

const COUNTDOWN_OPTIONS = [
    { value: '0', label: 'Immediately' },
    { value: '60', label: '1 minute' },
    { value: '120', label: '2 minutes' },
    { value: '300', label: '5 minutes' },
    { value: '600', label: '10 minutes' },
    { value: '900', label: '15 minutes' },
    { value: '1800', label: '30 minutes' },
    { value: '3600', label: '60 minutes' },
] as const;

// --- Restart Dialog ---
export function RestartDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [countdown, setCountdown] = useState('0');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleRestart() {
        setLoading(true);
        const cd = parseInt(countdown, 10);
        const data: Record<string, unknown> = {};
        if (cd > 0) {
            data.countdown = cd;
            if (message.trim()) {
                data.message = message.trim();
            }
        }
        await fetchAction('/admin/server/restart', { data: Object.keys(data).length > 0 ? data : undefined });
        setLoading(false);
        onOpenChange(false);
        setCountdown('0');
        setMessage('');
        setTimeout(() => router.reload({ only: ['server'] }), 2000);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Restart Server</DialogTitle>
                    <DialogDescription>
                        Choose a delay to warn players before restarting, or restart immediately.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="restart-countdown">Countdown</Label>
                        <Select value={countdown} onValueChange={setCountdown}>
                            <SelectTrigger id="restart-countdown">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {COUNTDOWN_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {countdown !== '0' && (
                        <div className="grid gap-2">
                            <Label htmlFor="restart-message">Warning message (optional)</Label>
                            <Input
                                id="restart-message"
                                placeholder="Server restarting for maintenance..."
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                maxLength={500}
                            />
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        variant={countdown === '0' ? 'destructive' : 'default'}
                        onClick={handleRestart}
                        disabled={loading}
                    >
                        {loading ? 'Restarting...' : countdown === '0' ? 'Restart Now' : 'Schedule Restart'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// --- Stop Dialog ---
export function StopDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [countdown, setCountdown] = useState('0');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleStop() {
        setLoading(true);
        const cd = parseInt(countdown, 10);
        const data: Record<string, unknown> = {};
        if (cd > 0) {
            data.countdown = cd;
            if (message.trim()) {
                data.message = message.trim();
            }
        }
        await fetchAction('/admin/server/stop', { data: Object.keys(data).length > 0 ? data : undefined });
        setLoading(false);
        onOpenChange(false);
        setCountdown('0');
        setMessage('');
        setTimeout(() => router.reload({ only: ['server'] }), 2000);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Stop Server</DialogTitle>
                    <DialogDescription>
                        Choose a delay to warn players before shutting down, or stop immediately.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="stop-countdown">Countdown</Label>
                        <Select value={countdown} onValueChange={setCountdown}>
                            <SelectTrigger id="stop-countdown">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {COUNTDOWN_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {countdown !== '0' && (
                        <div className="grid gap-2">
                            <Label htmlFor="stop-message">Warning message (optional)</Label>
                            <Input
                                id="stop-message"
                                placeholder="Server shutting down for maintenance..."
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                maxLength={500}
                            />
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleStop} disabled={loading}>
                        {loading ? 'Stopping...' : countdown === '0' ? 'Stop Now' : 'Schedule Shutdown'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// --- Update Dialog ---
export function UpdateDialog({
    open,
    onOpenChange,
    currentBranch,
    currentVersion,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentBranch: string;
    currentVersion: string | null;
}) {
    const [branch, setBranch] = useState(currentBranch);
    const [countdown, setCountdown] = useState('0');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleUpdate() {
        setLoading(true);
        const cd = parseInt(countdown, 10);
        const data: Record<string, unknown> = {};
        if (branch !== currentBranch) {
            data.branch = branch;
        }
        if (cd > 0) {
            data.countdown = cd;
            if (message.trim()) {
                data.message = message.trim();
            }
        }
        await fetchAction('/admin/server/update', { data: Object.keys(data).length > 0 ? data : undefined });
        setLoading(false);
        onOpenChange(false);
        setCountdown('0');
        setMessage('');
        setTimeout(() => router.reload({ only: ['server'] }), 2000);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Update Game Server</DialogTitle>
                    <DialogDescription>
                        Force a SteamCMD re-download. Optionally change the Steam branch.
                        A pre-update backup will be created automatically.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
                        {currentVersion
                            ? `Current version: v${currentVersion} (${currentBranch})`
                            : `Current branch: ${currentBranch}`}
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="update-branch">Steam Branch</Label>
                        <Select value={branch} onValueChange={setBranch}>
                            <SelectTrigger id="update-branch">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="public">public</SelectItem>
                                <SelectItem value="unstable">unstable</SelectItem>
                                <SelectItem value="iwillbackupmysave">iwillbackupmysave</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="update-countdown">Countdown</Label>
                        <Select value={countdown} onValueChange={setCountdown}>
                            <SelectTrigger id="update-countdown">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {COUNTDOWN_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {countdown !== '0' && (
                        <div className="grid gap-2">
                            <Label htmlFor="update-message">Warning message (optional)</Label>
                            <Input
                                id="update-message"
                                placeholder="Server updating — expect downtime..."
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                maxLength={500}
                            />
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                        The server will be stopped, SteamCMD will re-download game files, then the server will restart.
                        This may take several minutes depending on download speed.
                    </p>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button onClick={handleUpdate} disabled={loading}>
                        {loading ? 'Updating...' : countdown === '0' ? 'Update Now' : 'Schedule Update'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// --- Wipe Dialog ---
export function WipeDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [countdown, setCountdown] = useState('0');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [confirmStep, setConfirmStep] = useState(0);

    function handleOpenChange(isOpen: boolean) {
        onOpenChange(isOpen);
        if (!isOpen) {
            setConfirmStep(0);
        }
    }

    async function handleWipe() {
        if (confirmStep < 2) {
            setConfirmStep(confirmStep + 1);
            return;
        }
        setLoading(true);
        const cd = parseInt(countdown, 10);
        const data: Record<string, unknown> = {};
        if (cd > 0) {
            data.countdown = cd;
            if (message.trim()) {
                data.message = message.trim();
            }
        }
        await fetchAction('/admin/server/wipe', { data: Object.keys(data).length > 0 ? data : undefined });
        setLoading(false);
        handleOpenChange(false);
        setCountdown('0');
        setMessage('');
        setConfirmStep(0);
        setTimeout(() => router.reload({ only: ['server'] }), 2000);
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="text-destructive">Wipe Server</DialogTitle>
                    <DialogDescription>
                        This will permanently delete all save data. A backup will be created automatically before wiping.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                        All player progress, buildings, and world state will be permanently destroyed.
                        This action cannot be undone.
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="wipe-countdown">Countdown</Label>
                        <Select value={countdown} onValueChange={setCountdown}>
                            <SelectTrigger id="wipe-countdown">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {COUNTDOWN_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {countdown !== '0' && (
                        <div className="grid gap-2">
                            <Label htmlFor="wipe-message">Warning message (optional)</Label>
                            <Input
                                id="wipe-message"
                                placeholder="Server wiping — all progress will be reset..."
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                maxLength={500}
                            />
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => handleOpenChange(false)}
                        disabled={loading}
                    >
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleWipe} disabled={loading}>
                        {loading
                            ? 'Wiping...'
                            : confirmStep === 0
                              ? 'Confirm Wipe'
                              : confirmStep === 1
                                ? 'Are you sure? Click again'
                                : countdown === '0'
                                  ? 'Wipe Now'
                                  : 'Schedule Wipe'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
