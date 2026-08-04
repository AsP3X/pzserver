<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Str;

class NewsPost extends Model
{
    use HasFactory;

    protected $fillable = [
        'slug',
        'title',
        'excerpt',
        'body',
        'pinned',
        'published_at',
        'author_id',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'pinned' => 'boolean',
            'published_at' => 'datetime',
        ];
    }

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_id');
    }

    /**
     * Posts the public may see: published, and not dated into the future.
     */
    public function scopePublished(Builder $query): Builder
    {
        return $query->whereNotNull('published_at')->where('published_at', '<=', now());
    }

    /**
     * Pinned posts first, then newest — the order the news page reads in.
     */
    public function scopeInReadingOrder(Builder $query): Builder
    {
        return $query->orderByDesc('pinned')->orderByDesc('published_at')->orderByDesc('id');
    }

    public function isPublished(): bool
    {
        return $this->published_at !== null && $this->published_at->isPast();
    }

    /**
     * A URL-safe slug for `$title`, suffixed until it is unique.
     *
     * Titles repeat across seasons ("Server wipe"), and a collision would
     * otherwise make the second post unreachable.
     */
    public static function uniqueSlug(string $title, ?int $ignoreId = null): string
    {
        $base = Str::slug($title) ?: 'post';
        $slug = $base;
        $suffix = 2;

        while (static::query()
            ->where('slug', $slug)
            ->when($ignoreId !== null, fn (Builder $query) => $query->whereKeyNot($ignoreId))
            ->exists()
        ) {
            $slug = $base.'-'.$suffix;
            $suffix++;
        }

        return $slug;
    }
}
