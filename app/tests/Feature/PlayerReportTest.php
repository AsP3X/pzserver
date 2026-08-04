<?php

use App\Models\AuditLog;
use App\Models\PlayerReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

it('redirects guests to login', function () {
    $this->get('/portal/reports')->assertRedirect('/login');
});

it('lets a player file a support ticket', function () {
    $this->actingAs(User::factory()->create())
        ->postJson('/portal/reports', [
            'kind' => 'support',
            'subject' => 'Lost my safehouse key',
            'body' => 'I dropped it somewhere near the warehouse and cannot get back in.',
        ])
        ->assertCreated();

    expect(PlayerReport::query()->sole()->status->value)->toBe('open');
});

it('requires a name when reporting a player', function () {
    $this->actingAs(User::factory()->create())
        ->postJson('/portal/reports', [
            'kind' => 'report',
            'subject' => 'Base raided during safe hours',
            'body' => 'Someone broke into my base while PvP was off.',
        ])
        ->assertStatus(422)
        ->assertJsonValidationErrors('accused');
});

it('rejects a report too short to act on', function () {
    $this->actingAs(User::factory()->create())
        ->postJson('/portal/reports', ['kind' => 'support', 'subject' => 'Help', 'body' => 'pls'])
        ->assertStatus(422);
});

it('shows a player only their own submissions', function () {
    $mine = User::factory()->create();
    PlayerReport::factory()->create(['user_id' => $mine->id, 'subject' => 'Mine']);
    PlayerReport::factory()->create(['subject' => 'Someone else']);

    $this->actingAs($mine)->get('/portal/reports')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('portal/reports')
            ->has('reports', 1)
            ->where('reports.0.subject', 'Mine')
        );
});

it('keeps the admin queue away from players', function () {
    $this->actingAs(User::factory()->create())->get('/admin/reports')->assertForbidden();
});

it('shows every report to an admin, unresolved first', function () {
    PlayerReport::factory()->resolved()->create(['subject' => 'Old business']);
    PlayerReport::factory()->create(['subject' => 'Needs attention']);

    $this->actingAs(User::factory()->admin()->create())->get('/admin/reports')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('admin/reports')
            ->has('reports', 2)
            ->where('reports.0.subject', 'Needs attention')
            ->where('open_count', 1)
        );
});

it('records who handled a report and when', function () {
    $report = PlayerReport::factory()->create();
    $admin = User::factory()->admin()->create();

    $this->actingAs($admin)
        ->patchJson("/admin/reports/{$report->id}", [
            'status' => 'resolved',
            'resolution' => 'Banned the player for a week.',
        ])
        ->assertOk();

    $fresh = $report->fresh();

    expect($fresh->status->value)->toBe('resolved')
        ->and($fresh->handled_by)->toBe($admin->id)
        ->and($fresh->handled_at)->not->toBeNull()
        ->and($fresh->resolution)->toBe('Banned the player for a week.');
});

it('clears the handled stamp when a report is reopened', function () {
    $report = PlayerReport::factory()->resolved()->create();

    $this->actingAs(User::factory()->admin()->create())
        ->patchJson("/admin/reports/{$report->id}", ['status' => 'investigating'])
        ->assertOk();

    expect($report->fresh()->handled_at)->toBeNull();
});

it('audits a resolution', function () {
    $report = PlayerReport::factory()->accusing('Mallory')->create();

    $this->actingAs(User::factory()->admin()->create())
        ->patchJson("/admin/reports/{$report->id}", ['status' => 'rejected'])
        ->assertOk();

    $audit = AuditLog::query()->where('action', 'report.rejected')->sole();

    expect($audit->details['accused'])->toBe('Mallory');
});

it('rejects an unknown status', function () {
    $report = PlayerReport::factory()->create();

    $this->actingAs(User::factory()->admin()->create())
        ->patchJson("/admin/reports/{$report->id}", ['status' => 'ignored_forever'])
        ->assertStatus(422);
});

it('lets a player read the team reply on their own report', function () {
    $player = User::factory()->create();
    $report = PlayerReport::factory()->create(['user_id' => $player->id]);

    $this->actingAs(User::factory()->admin()->create())
        ->patchJson("/admin/reports/{$report->id}", [
            'status' => 'resolved',
            'resolution' => 'Sorted, thanks for flagging it.',
        ]);

    $this->actingAs($player)->get('/portal/reports')
        ->assertInertia(fn ($page) => $page
            ->where('reports.0.resolution', 'Sorted, thanks for flagging it.')
        );
});
