<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreNewsPostRequest;
use App\Http\Requests\Admin\UpdateNewsPostRequest;
use App\Jobs\BroadcastMessage;
use App\Models\NewsPost;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class NewsController extends Controller
{
    public function __construct(
        private readonly AuditLogger $auditLogger,
    ) {}

    /**
     * Every post, drafts included — this is the editing view.
     */
    public function index(): Response
    {
        $posts = NewsPost::query()
            ->with('author:id,name,username')
            ->inReadingOrder()
            ->get()
            ->map(fn (NewsPost $post) => [
                'id' => $post->id,
                'slug' => $post->slug,
                'title' => $post->title,
                'excerpt' => $post->excerpt,
                'body' => $post->body,
                'pinned' => $post->pinned,
                'published_at' => $post->published_at?->toIso8601String(),
                'is_published' => $post->isPublished(),
                'author' => $post->author?->name ?? $post->author?->username,
                'created_at' => $post->created_at?->toIso8601String(),
            ]);

        return Inertia::render('admin/news', [
            'posts' => $posts,
        ]);
    }

    public function store(StoreNewsPostRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $post = NewsPost::query()->create([
            'slug' => NewsPost::uniqueSlug($validated['title']),
            'title' => $validated['title'],
            'excerpt' => $validated['excerpt'] ?? null,
            'body' => $validated['body'],
            'pinned' => $validated['pinned'] ?? false,
            'published_at' => $validated['published_at'] ?? null,
            'author_id' => $request->user()->id,
        ]);

        /**
         * Announcing in-game is opt-in per post, and only for something that
         * is already public — a draft has nothing to announce yet.
         */
        if (($validated['broadcast'] ?? false) && $post->isPublished()) {
            BroadcastMessage::dispatch($post->title);
        }

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'news.create',
            target: $post->title,
            details: ['post_id' => $post->id, 'published' => $post->isPublished()],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Post created', 'post' => $post], 201);
    }

    public function update(UpdateNewsPostRequest $request, NewsPost $newsPost): JsonResponse
    {
        $validated = $request->validated();

        if (isset($validated['title']) && $validated['title'] !== $newsPost->title) {
            $validated['slug'] = NewsPost::uniqueSlug($validated['title'], $newsPost->id);
        }

        $newsPost->update($validated);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'news.update',
            target: $newsPost->title,
            details: ['post_id' => $newsPost->id, 'published' => $newsPost->isPublished()],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Post updated', 'post' => $newsPost->fresh()]);
    }

    public function destroy(Request $request, NewsPost $newsPost): JsonResponse
    {
        $title = $newsPost->title;
        $newsPost->delete();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'news.delete',
            target: $title,
            details: [],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Post deleted']);
    }
}
