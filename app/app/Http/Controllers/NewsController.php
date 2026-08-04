<?php

namespace App\Http\Controllers;

use App\Models\NewsPost;
use Inertia\Inertia;
use Inertia\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Server news, as the public reads it.
 *
 * Drafts and future-dated posts are filtered in the query rather than in the
 * page, so an unpublished announcement never reaches the browser at all.
 */
class NewsController extends Controller
{
    private const PAGE_SIZE = 20;

    public function index(): Response
    {
        $posts = NewsPost::query()
            ->published()
            ->with('author:id,name,username')
            ->inReadingOrder()
            ->limit(self::PAGE_SIZE)
            ->get()
            ->map(fn (NewsPost $post) => $this->summarise($post));

        return Inertia::render('news', [
            'server_name' => config('zomboid.server_name', 'Project Zomboid Server'),
            'posts' => $posts,
        ]);
    }

    public function show(string $slug): Response
    {
        $post = NewsPost::query()
            ->published()
            ->with('author:id,name,username')
            ->where('slug', $slug)
            ->first();

        if ($post === null) {
            throw new NotFoundHttpException('Post not found');
        }

        return Inertia::render('news-post', [
            'server_name' => config('zomboid.server_name', 'Project Zomboid Server'),
            'post' => [
                ...$this->summarise($post),
                'body' => $post->body,
            ],
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function summarise(NewsPost $post): array
    {
        return [
            'id' => $post->id,
            'slug' => $post->slug,
            'title' => $post->title,
            'excerpt' => $post->excerpt,
            'pinned' => $post->pinned,
            'published_at' => $post->published_at?->toIso8601String(),
            'author' => $post->author?->name ?? $post->author?->username,
        ];
    }
}
