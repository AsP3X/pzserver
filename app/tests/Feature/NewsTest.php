<?php

use App\Jobs\BroadcastMessage;
use App\Models\NewsPost;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

function newsAdmin(): User
{
    return User::factory()->admin()->create();
}

it('lists published posts publicly', function () {
    NewsPost::factory()->create(['title' => 'Server wipe incoming']);

    $this->get('/news')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('news')
            ->has('posts', 1)
            ->where('posts.0.title', 'Server wipe incoming')
        );
});

it('hides drafts and future-dated posts from the public list', function () {
    NewsPost::factory()->create(['title' => 'Published']);
    NewsPost::factory()->draft()->create(['title' => 'Draft']);
    NewsPost::factory()->scheduled()->create(['title' => 'Scheduled']);

    $this->get('/news')
        ->assertInertia(fn ($page) => $page
            ->has('posts', 1)
            ->where('posts.0.title', 'Published')
        );
});

it('puts pinned posts first', function () {
    NewsPost::factory()->create(['title' => 'Newest', 'published_at' => now()->subHour()]);
    NewsPost::factory()->pinned()->create(['title' => 'Pinned', 'published_at' => now()->subWeek()]);

    $this->get('/news')
        ->assertInertia(fn ($page) => $page->where('posts.0.title', 'Pinned'));
});

it('shows a published post by slug', function () {
    NewsPost::factory()->create(['slug' => 'server-wipe', 'title' => 'Wipe', 'body' => 'Everything goes.']);

    $this->get('/news/server-wipe')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('news-post')
            ->where('post.body', 'Everything goes.')
        );
});

it('does not serve a draft by slug', function () {
    NewsPost::factory()->draft()->create(['slug' => 'secret-plans']);

    $this->get('/news/secret-plans')->assertNotFound();
});

it('keeps the admin page away from players', function () {
    $this->actingAs(User::factory()->create())->get('/admin/news')->assertForbidden();
});

it('shows drafts to an admin', function () {
    NewsPost::factory()->draft()->create(['title' => 'Draft']);

    $this->actingAs(newsAdmin())->get('/admin/news')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('admin/news')
            ->has('posts', 1)
            ->where('posts.0.is_published', false)
        );
});

it('creates a post and derives a slug from the title', function () {
    $this->actingAs(newsAdmin())->postJson('/admin/news', [
        'title' => 'Server Wipe Incoming',
        'body' => 'Saturday.',
        'published_at' => now()->toIso8601String(),
    ])->assertCreated();

    expect(NewsPost::query()->first()->slug)->toBe('server-wipe-incoming');
});

it('suffixes a slug when the title repeats', function () {
    NewsPost::factory()->create(['slug' => 'server-wipe', 'title' => 'Server Wipe']);

    $this->actingAs(newsAdmin())->postJson('/admin/news', [
        'title' => 'Server Wipe',
        'body' => 'Again.',
    ])->assertCreated();

    expect(NewsPost::query()->where('title', 'Server Wipe')->pluck('slug')->all())
        ->toContain('server-wipe', 'server-wipe-2');
});

it('broadcasts a published post in-game when asked', function () {
    Queue::fake();

    $this->actingAs(newsAdmin())->postJson('/admin/news', [
        'title' => 'Double XP weekend',
        'body' => 'Starts now.',
        'published_at' => now()->toIso8601String(),
        'broadcast' => true,
    ])->assertCreated();

    Queue::assertPushed(BroadcastMessage::class);
});

it('does not broadcast a draft', function () {
    Queue::fake();

    $this->actingAs(newsAdmin())->postJson('/admin/news', [
        'title' => 'Unfinished thought',
        'body' => 'Later.',
        'published_at' => null,
        'broadcast' => true,
    ])->assertCreated();

    Queue::assertNothingPushed();
});

it('does not broadcast when the flag is absent', function () {
    Queue::fake();

    $this->actingAs(newsAdmin())->postJson('/admin/news', [
        'title' => 'Quiet update',
        'body' => 'No fanfare.',
        'published_at' => now()->toIso8601String(),
    ])->assertCreated();

    Queue::assertNothingPushed();
});

it('rebuilds the slug when the title changes', function () {
    $post = NewsPost::factory()->create(['slug' => 'old-title', 'title' => 'Old Title']);

    $this->actingAs(newsAdmin())
        ->patchJson("/admin/news/{$post->id}", ['title' => 'Brand New Title'])
        ->assertOk();

    expect($post->fresh()->slug)->toBe('brand-new-title');
});

it('deletes a post', function () {
    $post = NewsPost::factory()->create();

    $this->actingAs(newsAdmin())->deleteJson("/admin/news/{$post->id}")->assertOk();

    expect(NewsPost::query()->count())->toBe(0);
});

it('rejects a post with no body', function () {
    $this->actingAs(newsAdmin())
        ->postJson('/admin/news', ['title' => 'Titled but empty'])
        ->assertStatus(422);
});
