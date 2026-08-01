<?php

use App\Models\AuditLog;
use App\Models\PvpViolation;
use App\Models\User;
use App\Services\SafeZoneManager;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

function safeZoneAdmin(): User
{
    return User::factory()->admin()->create();
}

function mockSafeZoneManager(array $config = ['enabled' => false, 'zones' => []]): void
{
    $manager = Mockery::mock(SafeZoneManager::class);
    $manager->shouldReceive('getConfig')->andReturn($config)->byDefault();
    $manager->shouldReceive('updateConfig')->andReturn(true)->byDefault();
    $manager->shouldReceive('addZone')->andReturn(true)->byDefault();
    $manager->shouldReceive('removeZone')->andReturn(true)->byDefault();
    $manager->shouldReceive('importViolations')->andReturn(0)->byDefault();
    $manager->shouldReceive('resolveViolation')->andReturnUsing(function ($id, $status, $note, $resolvedBy) {
        $violation = PvpViolation::find($id);
        if ($violation) {
            $violation->update([
                'status' => $status,
                'resolution_note' => $note,
                'resolved_by' => $resolvedBy,
                'resolved_at' => now(),
            ]);
        }

        return $violation;
    })->byDefault();

    app()->instance(SafeZoneManager::class, $manager);
}

// --- Service DB Tests (moved from unit) ---

it('imports violations from JSON file into database', function () {
    $tempDir = sys_get_temp_dir().'/pz_safezone_feat_'.getmypid();
    mkdir($tempDir, 0755, true);
    $violationsPath = $tempDir.'/safezone_violations.json';
    $configPath = $tempDir.'/safezone_config.json';

    $violations = [
        'violations' => [
            [
                'attacker' => 'Griefer',
                'victim' => 'Victim1',
                'zone_id' => 'spawn_sz',
                'zone_name' => 'Spawn Zone',
                'attacker_x' => 10050,
                'attacker_y' => 10050,
                'strike_number' => 2,
                'occurred_at' => time(),
            ],
            [
                'attacker' => 'Griefer',
                'victim' => 'Victim2',
                'zone_id' => 'spawn_sz',
                'zone_name' => 'Spawn Zone',
                'attacker_x' => 10051,
                'attacker_y' => 10051,
                'strike_number' => 3,
                'occurred_at' => time(),
            ],
        ],
    ];
    file_put_contents($violationsPath, json_encode($violations));

    $manager = new SafeZoneManager($configPath, $violationsPath);
    $count = $manager->importViolations();

    expect($count)->toBe(2)
        ->and(PvpViolation::count())->toBe(2);

    $first = PvpViolation::query()->where('attacker', 'Griefer')->where('strike_number', 2)->first();
    expect($first)->not->toBeNull()
        ->and($first->victim)->toBe('Victim1')
        ->and($first->zone_name)->toBe('Spawn Zone')
        ->and($first->status)->toBe('pending');

    // Cleanup
    $data = json_decode(file_get_contents($violationsPath), true);
    expect($data['violations'])->toBe([]);
    array_map(fn ($f) => is_file($f) && unlink($f), glob($tempDir.'/*') ?: []);
    rmdir($tempDir);
});

it('resolves a violation in database', function () {
    $tempDir = sys_get_temp_dir().'/pz_safezone_feat2_'.getmypid();
    mkdir($tempDir, 0755, true);

    $manager = new SafeZoneManager($tempDir.'/config.json', $tempDir.'/violations.json');
    $violation = PvpViolation::factory()->create();

    $result = $manager->resolveViolation($violation->id, 'dismissed', 'Accidental', 'admin');

    expect($result)->not->toBeNull()
        ->and($result->status)->toBe('dismissed')
        ->and($result->resolution_note)->toBe('Accidental')
        ->and($result->resolved_by)->toBe('admin')
        ->and($result->resolved_at)->not->toBeNull();

    rmdir($tempDir);
});

// --- Controller Tests ---

it('renders the safe zones page', function () {
    mockSafeZoneManager();

    $response = $this->actingAs(safeZoneAdmin())->get('/admin/safe-zones');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('admin/safe-zones')
        ->has('config')
        ->has('violations')
    );
});

it('can toggle safe zone enabled status', function () {
    mockSafeZoneManager();

    $response = $this->actingAs(safeZoneAdmin())
        ->patchJson('/admin/safe-zones/config', ['enabled' => true]);

    $response->assertOk();
    $response->assertJson(['message' => 'Safe zones enabled']);
});

it('creates audit log when toggling config', function () {
    mockSafeZoneManager();
    $admin = safeZoneAdmin();

    $this->actingAs($admin)
        ->patchJson('/admin/safe-zones/config', ['enabled' => true]);

    $log = AuditLog::query()->where('action', 'safezone.config.update')->first();

    expect($log)->not->toBeNull()
        ->and($log->actor)->toBe($admin->name);
});

it('can add a safe zone', function () {
    mockSafeZoneManager();

    $response = $this->actingAs(safeZoneAdmin())
        ->postJson('/admin/safe-zones', [
            'id' => 'spawn_sz',
            'name' => 'Spawn Zone',
            'x1' => 10000,
            'y1' => 10000,
            'x2' => 10100,
            'y2' => 10100,
        ]);

    $response->assertOk();
    $response->assertJsonFragment(['message' => "Safe zone 'Spawn Zone' created"]);
});

it('creates audit log when adding zone', function () {
    mockSafeZoneManager();

    $this->actingAs(safeZoneAdmin())
        ->postJson('/admin/safe-zones', [
            'id' => 'market',
            'name' => 'Market',
            'x1' => 5000,
            'y1' => 5000,
            'x2' => 5100,
            'y2' => 5100,
        ]);

    $log = AuditLog::query()->where('action', 'safezone.zone.create')->first();

    expect($log)->not->toBeNull()
        ->and($log->target)->toBe('Market');
});

it('validates zone creation input', function () {
    mockSafeZoneManager();

    $this->actingAs(safeZoneAdmin())
        ->postJson('/admin/safe-zones', [])
        ->assertUnprocessable();

    $this->actingAs(safeZoneAdmin())
        ->postJson('/admin/safe-zones', ['id' => 'test', 'name' => 'Test'])
        ->assertUnprocessable();
});

it('can delete a safe zone', function () {
    mockSafeZoneManager(['enabled' => true, 'zones' => [
        ['id' => 'spawn_sz', 'name' => 'Spawn Zone', 'x1' => 10000, 'y1' => 10000, 'x2' => 10100, 'y2' => 10100],
    ]]);

    $response = $this->actingAs(safeZoneAdmin())
        ->deleteJson('/admin/safe-zones/spawn_sz');

    $response->assertOk();
    $response->assertJson(['message' => 'Safe zone removed']);
});

it('creates audit log when deleting zone', function () {
    mockSafeZoneManager(['enabled' => true, 'zones' => [
        ['id' => 'spawn_sz', 'name' => 'Spawn Zone', 'x1' => 10000, 'y1' => 10000, 'x2' => 10100, 'y2' => 10100],
    ]]);

    $this->actingAs(safeZoneAdmin())
        ->deleteJson('/admin/safe-zones/spawn_sz');

    $log = AuditLog::query()->where('action', 'safezone.zone.delete')->first();

    expect($log)->not->toBeNull()
        ->and($log->target)->toBe('Spawn Zone');
});

it('can resolve a violation as dismissed', function () {
    mockSafeZoneManager();
    $violation = PvpViolation::factory()->create();

    $response = $this->actingAs(safeZoneAdmin())
        ->postJson("/admin/safe-zones/violations/{$violation->id}/resolve", [
            'status' => 'dismissed',
            'note' => 'Accidental hit',
        ]);

    $response->assertOk();
    $response->assertJson(['message' => 'Violation dismissed']);

    $violation->refresh();
    expect($violation->status)->toBe('dismissed')
        ->and($violation->resolution_note)->toBe('Accidental hit');
});

it('can resolve a violation as actioned', function () {
    mockSafeZoneManager();
    $violation = PvpViolation::factory()->create();

    $response = $this->actingAs(safeZoneAdmin())
        ->postJson("/admin/safe-zones/violations/{$violation->id}/resolve", [
            'status' => 'actioned',
            'note' => 'Player banned',
        ]);

    $response->assertOk();
    $response->assertJson(['message' => 'Violation actioned']);
});

it('creates audit log when resolving violation', function () {
    mockSafeZoneManager();
    $violation = PvpViolation::factory()->create();
    $admin = safeZoneAdmin();

    $this->actingAs($admin)
        ->postJson("/admin/safe-zones/violations/{$violation->id}/resolve", [
            'status' => 'actioned',
            'note' => 'Banned',
        ]);

    $log = AuditLog::query()->where('action', 'safezone.violation.actioned')->first();

    expect($log)->not->toBeNull()
        ->and($log->actor)->toBe($admin->name)
        ->and($log->target)->toBe($violation->attacker);
});

it('validates resolve violation input', function () {
    mockSafeZoneManager();
    $violation = PvpViolation::factory()->create();

    $this->actingAs(safeZoneAdmin())
        ->postJson("/admin/safe-zones/violations/{$violation->id}/resolve", [])
        ->assertUnprocessable();

    $this->actingAs(safeZoneAdmin())
        ->postJson("/admin/safe-zones/violations/{$violation->id}/resolve", ['status' => 'invalid'])
        ->assertUnprocessable();
});

it('requires auth for safe zone pages', function () {
    $this->get('/admin/safe-zones')->assertRedirect('/login');
    $this->patchJson('/admin/safe-zones/config', ['enabled' => true])->assertUnauthorized();
    $this->postJson('/admin/safe-zones', [])->assertUnauthorized();
});

it('blocks players from safe zone pages', function () {
    $player = User::factory()->create(['role' => \App\Enums\UserRole::Player]);

    $this->actingAs($player)->get('/admin/safe-zones')->assertForbidden();
    $this->actingAs($player)->patchJson('/admin/safe-zones/config', ['enabled' => true])->assertForbidden();
});
