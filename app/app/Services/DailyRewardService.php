<?php

namespace App\Services;

use App\Enums\TransactionSource;
use App\Models\RewardClaim;
use App\Models\User;
use Illuminate\Support\Facades\DB;

class DailyRewardService
{
    public const REWARD_KEY = 'daily_login';

    public function __construct(
        private readonly WalletService $walletService,
    ) {}

    public function dailyCoins(): int
    {
        return max(0, (int) config('zomboid.rewards.daily_coins', 25));
    }

    /**
     * @return array{available: bool, claimed_today: bool, coins: int, next_claim_at: ?string, last_claim_at: ?string}
     */
    public function statusFor(User $user): array
    {
        $today = now()->toDateString();
        $claim = RewardClaim::query()
            ->where('user_id', $user->id)
            ->where('reward_key', self::REWARD_KEY)
            ->whereDate('claim_date', $today)
            ->first();

        $last = RewardClaim::query()
            ->where('user_id', $user->id)
            ->where('reward_key', self::REWARD_KEY)
            ->orderByDesc('claim_date')
            ->first();

        return [
            'available' => $claim === null && $this->dailyCoins() > 0,
            'claimed_today' => $claim !== null,
            'coins' => $this->dailyCoins(),
            'next_claim_at' => $claim ? now()->endOfDay()->addSecond()->toIso8601String() : null,
            'last_claim_at' => $last?->created_at?->toIso8601String(),
        ];
    }

    /**
     * @return array{ok: bool, coins: int, message: string, balance: float|null}
     */
    public function claim(User $user): array
    {
        $coins = $this->dailyCoins();
        if ($coins <= 0) {
            return ['ok' => false, 'coins' => 0, 'message' => 'Daily rewards are disabled.', 'balance' => null];
        }

        $today = now()->toDateString();

        return DB::transaction(function () use ($user, $coins, $today) {
            $exists = RewardClaim::query()
                ->where('user_id', $user->id)
                ->where('reward_key', self::REWARD_KEY)
                ->whereDate('claim_date', $today)
                ->lockForUpdate()
                ->exists();

            if ($exists) {
                return [
                    'ok' => false,
                    'coins' => 0,
                    'message' => 'Already claimed today.',
                    'balance' => $this->walletService->getBalance($user),
                ];
            }

            $claim = RewardClaim::query()->create([
                'user_id' => $user->id,
                'reward_key' => self::REWARD_KEY,
                'coins' => $coins,
                'claim_date' => $today,
                'meta' => ['source' => 'daily_login'],
            ]);

            $wallet = $this->walletService->getOrCreateWallet($user);
            // reference_id is a UUID column; keep claim details in metadata instead.
            $this->walletService->credit(
                $wallet,
                (float) $coins,
                TransactionSource::System,
                'Daily login reward',
                null,
                null,
                [
                    'reward_key' => self::REWARD_KEY,
                    'claim_date' => $today,
                    'reward_claim_id' => $claim->id,
                ],
            );

            return [
                'ok' => true,
                'coins' => $coins,
                'message' => "Claimed {$coins} coins.",
                'balance' => $this->walletService->getBalance($user),
            ];
        });
    }
}
