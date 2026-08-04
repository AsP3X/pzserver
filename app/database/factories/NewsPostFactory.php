<?php

namespace Database\Factories;

use App\Models\NewsPost;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/** @extends Factory<NewsPost> */
class NewsPostFactory extends Factory
{
    protected $model = NewsPost::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $title = fake()->unique()->sentence(4);

        return [
            'slug' => Str::slug($title).'-'.fake()->unique()->randomNumber(5),
            'title' => $title,
            'excerpt' => fake()->sentence(),
            'body' => fake()->paragraphs(3, true),
            'pinned' => false,
            'published_at' => now()->subDay(),
            'author_id' => null,
        ];
    }

    public function draft(): static
    {
        return $this->state(['published_at' => null]);
    }

    public function pinned(): static
    {
        return $this->state(['pinned' => true]);
    }

    public function scheduled(): static
    {
        return $this->state(['published_at' => now()->addWeek()]);
    }
}
