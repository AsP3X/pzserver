<?php

use App\Models\User;
use App\Models\VehicleKeyHolder;
use App\Services\VehicleReader;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
    $this->tempDir = sys_get_temp_dir().'/vehicles_test_'.uniqid();
    mkdir($this->tempDir, 0755, true);
    $this->path = $this->tempDir.'/vehicles.json';

    app()->instance(VehicleReader::class, new VehicleReader($this->path));
});

afterEach(function () {
    if (file_exists($this->path)) {
        unlink($this->path);
    }
    if (is_dir($this->tempDir)) {
        rmdir($this->tempDir);
    }
});

function writeFleet(string $path, array $vehicles, ?string $timestamp = '1993-07-09T12:00:00'): void
{
    file_put_contents($path, json_encode([
        'timestamp' => $timestamp,
        'vehicle_count' => count($vehicles),
        'vehicles' => $vehicles,
    ]));
}

it('returns an empty fleet when nothing has been exported', function () {
    expect((new VehicleReader($this->path))->read()['vehicles'])->toBe([]);
});

it('survives a corrupt export', function () {
    file_put_contents($this->path, '{not json');

    expect((new VehicleReader($this->path))->read()['vehicles'])->toBe([]);
});

it('reads the fleet', function () {
    writeFleet($this->path, [[
        'id' => 12,
        'model' => 'CarNormal',
        'x' => 10750,
        'y' => 9500,
        'fuel_percent' => 42,
        'engine_quality' => 88,
        'engine_running' => true,
        'key_spawned' => true,
    ]]);

    $fleet = (new VehicleReader($this->path))->read();

    expect($fleet['vehicles'])->toHaveCount(1)
        ->and($fleet['vehicles'][0]['model'])->toBe('CarNormal')
        ->and($fleet['vehicles'][0]['fuel_percent'])->toBe(42)
        ->and($fleet['vehicles'][0]['engine_running'])->toBeTrue()
        ->and($fleet['timestamp'])->toBe('1993-07-09T12:00:00');
});

it('keeps unreadable fields null rather than reporting them as zero', function () {
    writeFleet($this->path, [['id' => 3, 'model' => 'VanSeats']]);

    $vehicle = (new VehicleReader($this->path))->read()['vehicles'][0];

    expect($vehicle['fuel_percent'])->toBeNull()
        ->and($vehicle['engine_quality'])->toBeNull()
        ->and($vehicle['x'])->toBeNull()
        ->and($vehicle['engine_running'])->toBeFalse();
});

it('orders vehicles by distance from a point', function () {
    writeFleet($this->path, [
        ['id' => 1, 'model' => 'Far', 'x' => 1000, 'y' => 1000],
        ['id' => 2, 'model' => 'Near', 'x' => 105, 'y' => 105],
        ['id' => 3, 'model' => 'Middle', 'x' => 300, 'y' => 300],
    ]);

    $nearest = (new VehicleReader($this->path))->nearest(100, 100);

    expect(array_column($nearest, 'model'))->toBe(['Near', 'Middle', 'Far']);
});

it('skips vehicles with no position when ranking by distance', function () {
    writeFleet($this->path, [
        ['id' => 1, 'model' => 'Lost'],
        ['id' => 2, 'model' => 'Parked', 'x' => 105, 'y' => 105],
    ]);

    $nearest = (new VehicleReader($this->path))->nearest(100, 100);

    expect($nearest)->toHaveCount(1)
        ->and($nearest[0]['model'])->toBe('Parked');
});

it('shows the fleet to an admin', function () {
    writeFleet($this->path, [['id' => 7, 'model' => 'PickUpTruck', 'x' => 1, 'y' => 2]]);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('admin/vehicles')
            ->has('vehicles', 1)
            ->where('vehicles.0.model', 'PickUpTruck')
            ->where('exported_at', '1993-07-09T12:00:00')
        );
});

it('keeps the fleet away from players', function () {
    $this->actingAs(User::factory()->create())->get('/admin/vehicles')->assertForbidden();
});

// ── Key ownership ────────────────────────────────────────────────────

it('shows a player carrying the key as holding the vehicle', function () {
    writeFleet($this->path, [[
        'id' => 12, 'model' => 'CarNormal', 'x' => 1, 'y' => 2,
        'key_id' => 400, 'key_holders' => ['Alice'],
    ]]);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertInertia(fn ($page) => $page
            ->has('vehicles.0.holders', 1)
            ->where('vehicles.0.holders.0.username', 'Alice')
            ->where('vehicles.0.holders.0.online', true)
        );
});

it('shows every holder when a key has been copied', function () {
    writeFleet($this->path, [[
        'id' => 12, 'model' => 'CarNormal', 'key_id' => 400,
        'key_holders' => ['Alice', 'Bob'],
    ]]);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertInertia(fn ($page) => $page->has('vehicles.0.holders', 2));
});

it('reports no holder for a vehicle whose key nobody carries', function () {
    writeFleet($this->path, [['id' => 12, 'model' => 'CarNormal', 'key_id' => 400, 'key_holders' => []]]);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertInertia(fn ($page) => $page->has('vehicles.0.holders', 0));
});

it('remembers a holder who has since logged off', function () {
    writeFleet($this->path, [['id' => 12, 'model' => 'CarNormal', 'key_id' => 400, 'key_holders' => ['Alice']]]);

    $this->artisan('zomboid:sync-vehicle-keys')->assertSuccessful();

    /** Alice logs off: the mod can no longer see her inventory. */
    writeFleet($this->path, [['id' => 12, 'model' => 'CarNormal', 'key_id' => 400, 'key_holders' => []]]);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertInertia(fn ($page) => $page
            ->has('vehicles.0.holders', 1)
            ->where('vehicles.0.holders.0.username', 'Alice')
            ->where('vehicles.0.holders.0.online', false)
        );
});

it('does not list a remembered holder twice when they come back', function () {
    writeFleet($this->path, [['id' => 12, 'model' => 'CarNormal', 'key_id' => 400, 'key_holders' => ['Alice']]]);

    $this->artisan('zomboid:sync-vehicle-keys')->assertSuccessful();

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertInertia(fn ($page) => $page
            ->has('vehicles.0.holders', 1)
            ->where('vehicles.0.holders.0.online', true)
        );
});

it('records one row per player per vehicle however often it syncs', function () {
    writeFleet($this->path, [['id' => 12, 'model' => 'CarNormal', 'key_id' => 400, 'key_holders' => ['Alice']]]);

    $this->artisan('zomboid:sync-vehicle-keys');
    $this->artisan('zomboid:sync-vehicle-keys');
    $this->artisan('zomboid:sync-vehicle-keys');

    expect(VehicleKeyHolder::query()->count())->toBe(1);
});

it('keeps holders of different vehicles apart', function () {
    writeFleet($this->path, [
        ['id' => 12, 'model' => 'CarNormal', 'key_id' => 400, 'key_holders' => ['Alice']],
        ['id' => 13, 'model' => 'PickUpTruck', 'key_id' => 401, 'key_holders' => ['Bob']],
    ]);

    $this->artisan('zomboid:sync-vehicle-keys')->assertSuccessful();

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertInertia(fn ($page) => $page
            ->where('vehicles.0.holders.0.username', 'Alice')
            ->where('vehicles.1.holders.0.username', 'Bob')
        );
});

it('treats a fleet from a mod too old to report keys as unowned', function () {
    writeFleet($this->path, [['id' => 12, 'model' => 'CarNormal']]);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/vehicles')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->has('vehicles.0.holders', 0)
            ->where('vehicles.0.key_id', null)
        );
});
