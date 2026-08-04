<?php

use App\Models\User;
use App\Services\SteamOpenIdVerifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
    $this->verifier = new SteamOpenIdVerifier;
});

function steamCallbackQuery(string $steamId = '76561198000000001', string $mode = 'id_res'): array
{
    return [
        'openid.ns' => 'http://specs.openid.net/auth/2.0',
        'openid.mode' => $mode,
        'openid.claimed_id' => "https://steamcommunity.com/openid/id/{$steamId}",
        'openid.identity' => "https://steamcommunity.com/openid/id/{$steamId}",
        'openid.sig' => 'abc123',
        'openid.signed' => 'signed,op_endpoint,claimed_id,identity',
    ];
}

it('sends the player to Steam to sign in', function () {
    $response = $this->get('/auth/steam');

    $response->assertRedirectContains('steamcommunity.com/openid/login');
    $response->assertRedirectContains('checkid_setup');
});

it('accepts a callback Steam vouches for', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n")]);

    expect($this->verifier->verify(steamCallbackQuery()))->toBe('76561198000000001');
});

it('rejects a callback Steam does not vouch for', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response("is_valid:false\n")]);

    expect($this->verifier->verify(steamCallbackQuery()))->toBeNull();
});

it('rejects a callback that never reached Steam', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('', 500)]);

    expect($this->verifier->verify(steamCallbackQuery()))->toBeNull();
});

it('rejects a claimed id that is not a Steam profile', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:true')]);

    $query = steamCallbackQuery();
    $query['openid.claimed_id'] = 'https://evil.example.com/openid/id/76561198000000001';

    expect($this->verifier->verify($query))->toBeNull();
});

it('rejects a cancelled sign-in', function () {
    expect($this->verifier->verify(steamCallbackQuery(mode: 'cancel')))->toBeNull();
});

it('sends the exact parameters back to Steam for checking', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:true')]);

    $this->verifier->verify(steamCallbackQuery());

    Http::assertSent(function ($request) {
        return $request['openid.mode'] === 'check_authentication'
            && $request['openid.sig'] === 'abc123'
            && $request['openid.identity'] === 'https://steamcommunity.com/openid/id/76561198000000001';
    });
});

it('links Steam to the signed-in account', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:true')]);

    $user = User::factory()->create(['steam_id' => null]);

    $this->actingAs($user)->get('/auth/steam/callback?'.http_build_query(steamCallbackQuery()))
        ->assertRedirect(route('profile.edit'));

    expect($user->fresh()->steam_id)->toBe('76561198000000001');
});

it('refuses to move a Steam account already linked elsewhere', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:true')]);

    User::factory()->create(['steam_id' => '76561198000000001']);
    $other = User::factory()->create(['steam_id' => null]);

    $this->actingAs($other)->get('/auth/steam/callback?'.http_build_query(steamCallbackQuery()))
        ->assertSessionHasErrors('steam');

    expect($other->fresh()->steam_id)->toBeNull();
});

it('signs in an account that already linked Steam', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:true')]);

    $user = User::factory()->create(['steam_id' => '76561198000000001']);

    $this->get('/auth/steam/callback?'.http_build_query(steamCallbackQuery()))
        ->assertRedirect(route('portal'));

    $this->assertAuthenticatedAs($user);
});

it('does not create an account for an unknown Steam id', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:true')]);

    $this->get('/auth/steam/callback?'.http_build_query(steamCallbackQuery()))
        ->assertRedirect(route('login'))
        ->assertSessionHasErrors('steam');

    $this->assertGuest();
    expect(User::query()->count())->toBe(0);
});

it('does not sign anyone in when Steam rejects the callback', function () {
    Http::fake(['steamcommunity.com/openid/login' => Http::response('is_valid:false')]);

    User::factory()->create(['steam_id' => '76561198000000001']);

    $this->get('/auth/steam/callback?'.http_build_query(steamCallbackQuery()))
        ->assertRedirect(route('login'));

    $this->assertGuest();
});
