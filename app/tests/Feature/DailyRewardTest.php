<?php

use App\Enums\TransactionSource;
use App\Enums\TransactionType;
use App\Models\RewardClaim;
use App\Models\User;
use App\Models\Wallet;
use App\Models\WalletTransaction;
use App\Services\DailyRewardService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    config(['zomboid.rewards.daily_coins' => 25]);
    $this->user = User::factory()->create();
});

it('credits wallet coins when claiming the daily reward', function () {
    $response = $this->actingAs($this->user)->postJson('/shop/rewards/daily');

    $response->assertSuccessful()
        ->assertJson([
            'ok' => true,
            'coins' => 25,
            'balance' => 25,
        ]);

    expect((float) Wallet::query()->where('user_id', $this->user->id)->value('balance'))->toBe(25.0);

    $this->assertDatabaseHas('reward_claims', [
        'user_id' => $this->user->id,
        'reward_key' => DailyRewardService::REWARD_KEY,
        'coins' => 25,
        'claim_date' => now()->toDateString(),
    ]);

    $tx = WalletTransaction::query()
        ->whereHas('wallet', fn ($q) => $q->where('user_id', $this->user->id))
        ->first();

    expect($tx)->not->toBeNull()
        ->and($tx->type)->toBe(TransactionType::Credit)
        ->and($tx->source)->toBe(TransactionSource::System)
        ->and((float) $tx->amount)->toBe(25.0)
        ->and($tx->reference_id)->toBeNull()
        ->and($tx->metadata)->toMatchArray([
            'reward_key' => DailyRewardService::REWARD_KEY,
            'claim_date' => now()->toDateString(),
        ]);
});

it('rejects a second claim on the same day', function () {
    $this->actingAs($this->user)->postJson('/shop/rewards/daily')->assertSuccessful();

    $response = $this->actingAs($this->user)->postJson('/shop/rewards/daily');

    $response->assertUnprocessable()
        ->assertJson([
            'ok' => false,
            'coins' => 0,
            'message' => 'Already claimed today.',
            'balance' => 25,
        ]);

    expect(RewardClaim::query()->where('user_id', $this->user->id)->count())->toBe(1)
        ->and((float) Wallet::query()->where('user_id', $this->user->id)->value('balance'))->toBe(25.0);
});

it('reports available status until claimed', function () {
    $service = app(DailyRewardService::class);

    $before = $service->statusFor($this->user);
    expect($before['available'])->toBeTrue()
        ->and($before['claimed_today'])->toBeFalse()
        ->and($before['coins'])->toBe(25);

    $this->actingAs($this->user)->postJson('/shop/rewards/daily')->assertSuccessful();

    $after = $service->statusFor($this->user);
    expect($after['available'])->toBeFalse()
        ->and($after['claimed_today'])->toBeTrue();
});

it('requires authentication', function () {
    $this->postJson('/shop/rewards/daily')->assertUnauthorized();
});
