type Props = {
    src: string;
    name: string;
    size?: number;
};

export function ItemIcon({ src, name, size = 48 }: Props) {
    return (
        <img
            src={src}
            alt={name}
            width={size}
            height={size}
            className="rounded object-contain"
            onError={(e) => {
                (e.target as HTMLImageElement).src = '/images/items/placeholder.svg';
            }}
        />
    );
}
