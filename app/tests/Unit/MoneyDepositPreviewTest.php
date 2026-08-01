<?php

use App\Services\InventoryReader;
use App\Services\MoneyDepositManager;

it('previews coins from inventory snapshot', function () {
    $dir = sys_get_temp_dir().'/pz_dep_prev_'.getmypid();
    mkdir($dir.'/inventory', 0777, true);
    config([
        'zomboid.lua_bridge.inventory_dir' => $dir.'/inventory',
        'zomboid.lua_bridge.deposit_requests' => $dir.'/deposit_requests.json',
        'zomboid.lua_bridge.deposit_results' => $dir.'/deposit_results.json',
        'zomboid.money_deposit.money_value' => 2,
        'zomboid.money_deposit.bundle_value' => 50,
    ]);

    file_put_contents($dir.'/inventory/AsP3X.json', json_encode([
        'username' => 'AsP3X',
        'items' => [
            ['full_type' => 'Base.Money', 'count' => 3],
            ['full_type' => 'Base.MoneyBundle', 'count' => 1],
            ['full_type' => 'Base.Axe', 'count' => 1],
        ],
    ]));

    $manager = new MoneyDepositManager($dir.'/deposit_requests.json', $dir.'/deposit_results.json');
    $reader = new InventoryReader($dir.'/inventory', $dir.'/export_requests.json');
    $preview = $manager->previewForUsername('AsP3X', $reader);

    expect($preview['money_count'])->toBe(3)
        ->and($preview['bundle_count'])->toBe(1)
        ->and($preview['estimated_coins'])->toBe(3 * 2 + 50)
        ->and($preview['inventory_found'])->toBeTrue();

    @unlink($dir.'/inventory/AsP3X.json');
    @rmdir($dir.'/inventory');
    @rmdir($dir);
});
