<?php

use App\Models\PlayerStat;
use App\Services\PlayerStatsService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/player_stats_test_'.uniqid();
    mkdir($this->tempDir, 0755, true);
    $this->filePath = $this->tempDir.'/player_stats.json';
});

afterEach(function () {
    if (file_exists($this->filePath)) {
        unlink($this->filePath);
    }
    if (is_dir($this->tempDir)) {
        rmdir($this->tempDir);
    }
});

test('sync returns 0 when file does not exist', function () {
    $service = new PlayerStatsService($this->filePath);

    expect($service->sync())->toBe(0);
});

test('sync returns 0 for empty players array', function () {
    file_put_contents($this->filePath, json_encode([
        'timestamp' => '2026-02-27T14:30:00',
        'player_count' => 0,
        'players' => [],
    ]));

    $service = new PlayerStatsService($this->filePath);

    expect($service->sync())->toBe(0);
});

test('sync creates new player stat records', function () {
    $data = [
        'timestamp' => '2026-02-27T14:30:00',
        'player_count' => 2,
        'players' => [
            [
                'username' => 'Alice',
                'zombie_kills' => 42,
                'hours_survived' => 15.5,
                'profession' => 'Lumberjack',
                'skills' => ['Axe' => 3, 'Carpentry' => 2],
                'is_dead' => false,
            ],
            [
                'username' => 'Bob',
                'zombie_kills' => 100,
                'hours_survived' => 30.2,
                'profession' => 'FireOfficer',
                'skills' => ['Axe' => 5],
                'is_dead' => false,
            ],
        ],
    ];

    file_put_contents($this->filePath, json_encode($data));

    $service = new PlayerStatsService($this->filePath);
    $count = $service->sync();

    expect($count)->toBe(2);
    expect(PlayerStat::count())->toBe(2);

    $alice = PlayerStat::find('Alice');
    expect($alice)->not->toBeNull()
        ->and($alice->zombie_kills)->toBe(42)
        ->and($alice->hours_survived)->toBe(15.5)
        ->and($alice->profession)->toBe('Lumberjack')
        ->and($alice->skills)->toBe(['Axe' => 3, 'Carpentry' => 2]);
});

test('sync updates existing player stat records', function () {
    PlayerStat::query()->create([
        'username' => 'Alice',
        'zombie_kills' => 10,
        'hours_survived' => 5.0,
        'profession' => 'Lumberjack',
    ]);

    $data = [
        'timestamp' => '2026-02-27T14:30:00',
        'player_count' => 1,
        'players' => [
            [
                'username' => 'Alice',
                'zombie_kills' => 50,
                'hours_survived' => 20.0,
                'profession' => 'Lumberjack',
                'skills' => ['Axe' => 5],
                'is_dead' => false,
            ],
        ],
    ];

    file_put_contents($this->filePath, json_encode($data));

    $service = new PlayerStatsService($this->filePath);
    $count = $service->sync();

    expect($count)->toBe(1);

    $alice = PlayerStat::find('Alice');
    expect($alice->zombie_kills)->toBe(50)
        ->and($alice->hours_survived)->toBe(20.0);
});

test('sync skips unknown username entries', function () {
    $data = [
        'timestamp' => '2026-02-27T14:30:00',
        'player_count' => 1,
        'players' => [
            [
                'username' => 'unknown',
                'zombie_kills' => 5,
                'hours_survived' => 1.0,
            ],
        ],
    ];

    file_put_contents($this->filePath, json_encode($data));

    $service = new PlayerStatsService($this->filePath);
    $count = $service->sync();

    expect($count)->toBe(0);
    expect(PlayerStat::count())->toBe(0);
});

test('sync returns 0 for malformed JSON', function () {
    file_put_contents($this->filePath, 'not valid json');

    $service = new PlayerStatsService($this->filePath);

    expect($service->sync())->toBe(0);
});

test('getLeaderboard returns top players by zombie kills', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 50, 'hours_survived' => 10]);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 100, 'hours_survived' => 20]);
    PlayerStat::query()->create(['username' => 'Charlie', 'zombie_kills' => 75, 'hours_survived' => 15]);

    $service = new PlayerStatsService($this->filePath);
    $leaderboard = $service->getLeaderboard('zombie_kills', 2);

    expect($leaderboard)->toHaveCount(2)
        ->and($leaderboard[0]['username'])->toBe('Bob')
        ->and($leaderboard[1]['username'])->toBe('Charlie');
});

test('getLeaderboard returns top players by hours survived', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 50, 'hours_survived' => 30.5]);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 100, 'hours_survived' => 20.0]);

    $service = new PlayerStatsService($this->filePath);
    $leaderboard = $service->getLeaderboard('hours_survived', 10);

    expect($leaderboard)->toHaveCount(2)
        ->and($leaderboard[0]['username'])->toBe('Alice');
});

test('sync persists traits and vitals when the mod exports them', function () {
    file_put_contents($this->filePath, json_encode([
        'timestamp' => '2026-08-04T14:30:00',
        'player_count' => 1,
        'players' => [
            [
                'username' => 'Alice',
                'zombie_kills' => 42,
                'hours_survived' => 15.5,
                'profession' => 'Lumberjack',
                'skills' => ['Axe' => 3],
                'traits' => [['id' => 'Thickskinned', 'label' => 'Thick Skinned']],
                'vitals' => ['health' => 91.2, 'bleeding_parts' => 2, 'infected' => true, 'has_cold' => false],
                'is_dead' => false,
            ],
        ],
    ]));

    (new PlayerStatsService($this->filePath))->sync();

    $alice = PlayerStat::query()->find('Alice');

    expect($alice->traits)->toBe([['id' => 'Thickskinned', 'label' => 'Thick Skinned']])
        ->and($alice->vitals['health'])->toBe(91.2)
        ->and($alice->vitals['bleeding_parts'])->toBe(2)
        ->and($alice->vitals['infected'])->toBeTrue();
});

test('sync leaves traits and vitals null for an older mod that omits them', function () {
    file_put_contents($this->filePath, json_encode([
        'timestamp' => '2026-08-04T14:30:00',
        'player_count' => 1,
        'players' => [
            [
                'username' => 'Bob',
                'zombie_kills' => 1,
                'hours_survived' => 1.0,
                'skills' => [],
                'is_dead' => false,
            ],
        ],
    ]));

    (new PlayerStatsService($this->filePath))->sync();

    $bob = PlayerStat::query()->find('Bob');

    expect($bob->traits)->toBeNull()
        ->and($bob->vitals)->toBeNull();
});

test('sync records an empty trait list distinctly from an absent one', function () {
    file_put_contents($this->filePath, json_encode([
        'timestamp' => '2026-08-04T14:30:00',
        'player_count' => 1,
        'players' => [
            ['username' => 'Cara', 'zombie_kills' => 0, 'hours_survived' => 0.0, 'traits' => [], 'is_dead' => false],
        ],
    ]));

    (new PlayerStatsService($this->filePath))->sync();

    expect(PlayerStat::query()->find('Cara')->traits)->toBe([]);
});

// ── syncIfChanged() ─────────────────────────────────────────────────

/**
 * Write an export naming one player, with an explicit mtime so a test can
 * control whether the file looks newer than the last import.
 */
function writeStatsExport(string $path, string $username, int $kills, int $mtime): void
{
    file_put_contents($path, json_encode([
        'timestamp' => '2026-08-08T14:30:00',
        'player_count' => 1,
        'players' => [
            ['username' => $username, 'zombie_kills' => $kills, 'hours_survived' => 1.0, 'skills' => [], 'is_dead' => false],
        ],
    ]));

    touch($path, $mtime);
    clearstatcache(true, $path);
}

test('syncIfChanged imports an export it has not seen', function () {
    writeStatsExport($this->filePath, 'Alice', 10, 1_760_000_000);

    expect((new PlayerStatsService($this->filePath))->syncIfChanged())->toBe(1)
        ->and(PlayerStat::query()->find('Alice')->zombie_kills)->toBe(10);
});

test('syncIfChanged skips an export that has not been rewritten', function () {
    writeStatsExport($this->filePath, 'Alice', 10, 1_760_000_000);

    $service = new PlayerStatsService($this->filePath);
    $service->syncIfChanged();

    expect($service->syncIfChanged())->toBe(0);
});

test('syncIfChanged picks the export back up once the mod rewrites it', function () {
    writeStatsExport($this->filePath, 'Alice', 10, 1_760_000_000);

    $service = new PlayerStatsService($this->filePath);
    $service->syncIfChanged();

    writeStatsExport($this->filePath, 'Alice', 99, 1_760_000_030);

    expect($service->syncIfChanged())->toBe(1)
        ->and(PlayerStat::query()->find('Alice')->zombie_kills)->toBe(99);
});

test('syncIfChanged returns 0 when the mod has never exported', function () {
    expect((new PlayerStatsService($this->filePath))->syncIfChanged())->toBe(0);
});

// ── lastExportedAt() ────────────────────────────────────────────────

test('lastExportedAt reports when the mod last handed over players', function () {
    writeStatsExport($this->filePath, 'Alice', 10, 1_760_000_000);

    $service = new PlayerStatsService($this->filePath);
    $service->syncIfChanged();

    expect($service->lastExportedAt()?->getTimestamp())->toBe(1_760_000_000);
});

test('lastExportedAt is null before anything has been imported', function () {
    writeStatsExport($this->filePath, 'Alice', 10, 1_760_000_000);

    expect((new PlayerStatsService($this->filePath))->lastExportedAt())->toBeNull();
});

test('lastExportedAt is null when the mod has never exported', function () {
    $service = new PlayerStatsService($this->filePath);
    $service->syncIfChanged();

    expect($service->lastExportedAt())->toBeNull();
});

/**
 * The repair service drops an empty export in place of a missing one, and a
 * stopped mod leaves its last file behind. Neither is the bridge reporting in,
 * so neither may move the freshness clock.
 */
test('lastExportedAt ignores an export carrying no players', function () {
    writeStatsExport($this->filePath, 'Alice', 10, 1_760_000_000);

    $service = new PlayerStatsService($this->filePath);
    $service->syncIfChanged();

    file_put_contents($this->filePath, json_encode(['players' => [], 'updated_at' => '2026-08-08T12:00:00+00:00']));
    touch($this->filePath, 1_760_009_999);
    clearstatcache(true, $this->filePath);

    expect($service->syncIfChanged())->toBe(0)
        ->and($service->lastExportedAt()?->getTimestamp())->toBe(1_760_000_000);
});

test('lastExportedAt ignores an export that is a zero-byte stub', function () {
    file_put_contents($this->filePath, '');
    touch($this->filePath, 1_760_000_000);
    clearstatcache(true, $this->filePath);

    $service = new PlayerStatsService($this->filePath);

    expect($service->syncIfChanged())->toBe(0)
        ->and($service->lastExportedAt())->toBeNull();
});
