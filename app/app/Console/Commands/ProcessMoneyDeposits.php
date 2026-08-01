<?php

namespace App\Console\Commands;

use App\Services\MoneyDepositManager;
use App\Services\WalletService;
use Illuminate\Console\Command;

class ProcessMoneyDeposits extends Command
{
    protected $signature = 'zomboid:process-money-deposits';

    protected $description = 'Process in-game money deposit results and credit wallets';

    public function handle(MoneyDepositManager $depositManager, WalletService $walletService): int
    {
        // Clean up stale requests and requests that already have results
        $depositManager->cleanupStaleRequests();

        // Process results and credit wallets, collecting IDs of credited results
        $creditedIds = $depositManager->processResults($walletService);

        if (count($creditedIds) > 0) {
            $this->info('Credited '.count($creditedIds).' money deposit(s) to wallets.');

            // Remove only the successfully credited results; failed results stay visible
            $depositManager->removeProcessedResults($creditedIds);
        }

        return self::SUCCESS;
    }
}
