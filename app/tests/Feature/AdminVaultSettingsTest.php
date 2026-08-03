<?php

use App\Models\AuditLog;
use App\Models\User;
use App\Models\VaultSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(fn () => $this->withoutVite());

function validVaultSettings(array $overrides = []): array
{
    return array_merge([
        'default_slots' => 20,
        'max_slots' => 200,
        'slot_upgrade_increment' => 5,
        'slot_upgrade_cost' => 75,
        'withdraw_fee_flat' => 3,
        'withdraw_fee_per_item' => 0.5,
        'enabled' => true,
    ], $overrides);
}

it('renders the vault settings page for admins', function () {
    $response = $this->actingAs(User::factory()->admin()->create())->get('/admin/vault');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page->component('admin/vault-settings')->has('settings'));
});

it('blocks non-admins', function () {
    $this->actingAs(User::factory()->create())->get('/admin/vault')->assertForbidden();
});

it('blocks guests', function () {
    $this->get('/admin/vault')->assertRedirect('/login');
});

it('updates the settings', function () {
    $admin = User::factory()->admin()->create();

    $this->actingAs($admin)->patch('/admin/vault', validVaultSettings())->assertRedirect();

    expect(VaultSetting::instance()->default_slots)->toBe(20)
        ->and(VaultSetting::instance()->withdraw_fee_flat)->toBe(3.0);
});

it('writes an audit log entry', function () {
    $admin = User::factory()->admin()->create();

    $this->actingAs($admin)->patch('/admin/vault', validVaultSettings());

    expect(AuditLog::query()->where('action', 'vault.settings.update')->exists())->toBeTrue();
});

it('rejects invalid settings', function () {
    $admin = User::factory()->admin()->create();

    $this->actingAs($admin)
        ->patch('/admin/vault', validVaultSettings(['default_slots' => 0]))
        ->assertSessionHasErrors('default_slots');
});
