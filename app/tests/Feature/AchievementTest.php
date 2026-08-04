<?php

use App\Models\PlayerStat;
use App\Services\AchievementService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
    $this->achievements = new AchievementService;
});

function statFor(array $overrides = []): PlayerStat
{
    return PlayerStat::query()->create([
        'username' => 'Alice',
        'zombie_kills' => 0,
        'hours_survived' => 0,
        'profession' => null,
        'skills' => [],
        'is_dead' => false,
        ...$overrides,
    ]);
}

function badgeIds(array $badges): array
{
    return array_column($badges, 'id');
}

it('awards nothing to a fresh character', function () {
    expect($this->achievements->forPlayer(statFor()))->toBe([]);
});

it('awards the slayer badge once the first threshold is passed', function () {
    $badges = $this->achievements->forPlayer(statFor(['zombie_kills' => 150]));

    expect($badges)->toHaveCount(1)
        ->and($badges[0]['id'])->toBe('slayer')
        ->and($badges[0]['tier'])->toBe('bronze')
        ->and($badges[0]['value'])->toBe(150);
});

it('shows only the highest tier reached', function () {
    $badges = $this->achievements->forPlayer(statFor(['zombie_kills' => 6000]));

    expect($badges)->toHaveCount(1)
        ->and($badges[0]['tier'])->toBe('gold');
});

it('does not award a tier below its threshold', function () {
    expect($this->achievements->forPlayer(statFor(['zombie_kills' => 99])))->toBe([]);
});

it('awards a survival tier on hours survived', function () {
    $badges = $this->achievements->forPlayer(statFor(['hours_survived' => 200]));

    expect(badgeIds($badges))->toBe(['survivor'])
        ->and($badges[0]['tier'])->toBe('silver');
});

it('awards mastery for a skill at ten', function () {
    $badges = $this->achievements->forPlayer(statFor(['skills' => ['Axe' => 10, 'Cooking' => 3]]));

    expect(badgeIds($badges))->toContain('master')
        ->and(collect($badges)->firstWhere('id', 'master')['value'])->toBe(1);
});

it('does not award mastery for a skill at nine', function () {
    expect(badgeIds($this->achievements->forPlayer(statFor(['skills' => ['Axe' => 9]]))))
        ->not->toContain('master');
});

it('awards the generalist badge for five skills at level five', function () {
    $skills = ['Axe' => 5, 'Cooking' => 5, 'Farming' => 6, 'Carpentry' => 5, 'Fishing' => 7];

    expect(badgeIds($this->achievements->forPlayer(statFor(['skills' => $skills]))))
        ->toContain('generalist');
});

it('does not award the generalist badge for four', function () {
    $skills = ['Axe' => 5, 'Cooking' => 5, 'Farming' => 6, 'Carpentry' => 5];

    expect(badgeIds($this->achievements->forPlayer(statFor(['skills' => $skills]))))
        ->not->toContain('generalist');
});

it('awards the professional badge for an occupation', function () {
    expect(badgeIds($this->achievements->forPlayer(statFor(['profession' => 'Lumberjack']))))
        ->toContain('professional');
});

it('treats an empty profession as unemployed', function () {
    expect(badgeIds($this->achievements->forPlayer(statFor(['profession' => '']))))
        ->not->toContain('professional');
});

it('stacks every badge a veteran has earned', function () {
    $badges = $this->achievements->forPlayer(statFor([
        'zombie_kills' => 5200,
        'hours_survived' => 800,
        'profession' => 'Lumberjack',
        'skills' => ['Axe' => 10, 'Cooking' => 5, 'Farming' => 5, 'Carpentry' => 5, 'Fishing' => 5],
    ]));

    expect(badgeIds($badges))->toContain('slayer', 'survivor', 'master', 'generalist', 'professional');
});

it('shows badges on the public profile', function () {
    statFor(['zombie_kills' => 1500]);

    $this->get('/rankings/Alice')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->has('badges', 1)
            ->where('badges.0.id', 'slayer')
            ->where('badges.0.tier', 'silver')
        );
});
