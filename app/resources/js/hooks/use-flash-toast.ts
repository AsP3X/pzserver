import { usePage } from '@inertiajs/react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

interface FlashMessages {
    success?: string;
    error?: string;
}

/**
 * Auto-fires sonner toasts from Inertia shared flash data.
 * Call once in app layout — handles flash messages from redirects.
 */
export function useFlashToast() {
    const { flash } = usePage<{ flash: FlashMessages }>().props;
    const lastFlash = useRef<string | null>(null);

    useEffect(() => {
        const key = JSON.stringify(flash);
        if (key === lastFlash.current || key === '{}' || !flash) return;
        lastFlash.current = key;

        if (flash.success) {
            toast.success(flash.success);
        }
        if (flash.error) {
            toast.error(flash.error);
        }
    }, [flash]);
}
