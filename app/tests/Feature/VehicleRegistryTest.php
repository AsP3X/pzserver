<?php

use App\Models\User;
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
