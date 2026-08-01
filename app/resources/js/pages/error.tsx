import { Head, Link } from '@inertiajs/react';
import { AlertTriangle, ArrowLeft, Home, ServerCrash, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';

const errorConfig: Record<number, { title: string; description: string; icon: typeof AlertTriangle }> = {
    403: {
        title: 'Forbidden',
        description: 'You do not have permission to access this page.',
        icon: ShieldX,
    },
    404: {
        title: 'Page Not Found',
        description: 'The page you are looking for does not exist or has been moved.',
        icon: AlertTriangle,
    },
    500: {
        title: 'Server Error',
        description: 'Something went wrong on our end. Please try again later.',
        icon: ServerCrash,
    },
    503: {
        title: 'Service Unavailable',
        description: 'The server is currently under maintenance. Please check back soon.',
        icon: ServerCrash,
    },
};

export default function ErrorPage({ status }: { status: number }) {
    const config = errorConfig[status] ?? {
        title: `Error ${status}`,
        description: 'An unexpected error occurred.',
        icon: AlertTriangle,
    };

    const Icon = config.icon;

    return (
        <>
            <Head title={`${status} - ${config.title}`} />
            <div className="flex min-h-screen items-center justify-center bg-background p-4">
                <div className="mx-auto max-w-md text-center">
                    <div className="mb-6 flex justify-center">
                        <div className="rounded-full bg-destructive/10 p-4">
                            <Icon className="size-12 text-destructive" />
                        </div>
                    </div>
                    <h1 className="text-4xl font-bold tracking-tight text-foreground">
                        {status}
                    </h1>
                    <h2 className="mt-2 text-xl font-semibold text-foreground">
                        {config.title}
                    </h2>
                    <p className="mt-3 text-muted-foreground">
                        {config.description}
                    </p>
                    <div className="mt-8 flex items-center justify-center gap-3">
                        <Button variant="outline" onClick={() => window.history.back()}>
                            <ArrowLeft className="mr-1.5 size-4" />
                            Go Back
                        </Button>
                        <Button asChild>
                            <Link href="/dashboard">
                                <Home className="mr-1.5 size-4" />
                                Dashboard
                            </Link>
                        </Button>
                    </div>
                </div>
            </div>
        </>
    );
}
