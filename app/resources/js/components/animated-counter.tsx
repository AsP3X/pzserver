import { useEffect, useRef, useState } from 'react';
import { useInView } from 'motion/react';

interface AnimatedCounterProps {
    value: number;
    duration?: number;
    suffix?: string;
    format?: boolean;
    decimals?: number;
}

export function AnimatedCounter({
    value,
    duration = 1.5,
    suffix = '',
    format = true,
    decimals = 0,
}: AnimatedCounterProps) {
    const ref = useRef<HTMLSpanElement>(null);
    const isInView = useInView(ref, { once: true });
    const [displayValue, setDisplayValue] = useState(0);

    useEffect(() => {
        if (!isInView) return;

        const startTime = performance.now();
        const durationMs = duration * 1000;

        function animate(currentTime: number) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / durationMs, 1);

            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplayValue(eased * value);

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        }

        requestAnimationFrame(animate);
    }, [isInView, value, duration]);

    const formatted = decimals > 0
        ? displayValue.toFixed(decimals)
        : Math.round(displayValue).toString();

    const display = format
        ? Number(formatted).toLocaleString(undefined, { maximumFractionDigits: decimals })
        : formatted;

    return (
        <span ref={ref}>
            {display}{suffix}
        </span>
    );
}
