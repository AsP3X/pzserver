import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('ErrorBoundary caught:', error, info.componentStack);
    }

    handleRetry = (): void => {
        this.setState({ hasError: false, error: null });
    };

    handleReload = (): void => {
        window.location.reload();
    };

    render(): ReactNode {
        if (this.state.hasError) {
            return (
                <div className="flex min-h-[400px] items-center justify-center p-8">
                    <div className="mx-auto max-w-md text-center">
                        <div className="mb-4 flex justify-center">
                            <div className="rounded-full bg-destructive/10 p-3">
                                <AlertTriangle className="size-8 text-destructive" />
                            </div>
                        </div>
                        <h2 className="text-lg font-semibold">Something went wrong</h2>
                        <p className="mt-2 text-sm text-muted-foreground">
                            An unexpected error occurred while rendering this page.
                        </p>
                        {this.state.error && (
                            <pre className="mt-4 max-h-32 overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
                                {this.state.error.message}
                            </pre>
                        )}
                        <div className="mt-6 flex items-center justify-center gap-3">
                            <Button variant="outline" onClick={this.handleRetry}>
                                Try Again
                            </Button>
                            <Button onClick={this.handleReload}>
                                <RefreshCw className="mr-1.5 size-4" />
                                Reload Page
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
