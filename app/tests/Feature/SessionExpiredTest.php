<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Session\TokenMismatchException;
use Illuminate\Support\Facades\Route;

/** The `web` stack queries the database on its way to the handler. */
uses(RefreshDatabase::class);

/**
 * ValidateCsrfToken short-circuits under `runningUnitTests()`, so a real
 * request can never reach a token mismatch here. Raise the exception the
 * middleware would have raised and assert on what the handler makes of it.
 */
beforeEach(function () {
    Route::middleware('web')->post('/testing/csrf-mismatch', function () {
        throw new TokenMismatchException('CSRF token mismatch.');
    });
});

it('tells an XHR caller to reload rather than retry', function () {
    $this->postJson('/testing/csrf-mismatch')
        ->assertStatus(419)
        ->assertExactJson(['error' => 'Your session expired. Reload the page to sign in again.']);
});

it('sends a browser back with the same explanation', function () {
    $this->from('/dashboard')
        ->post('/testing/csrf-mismatch')
        ->assertRedirect('/dashboard')
        ->assertSessionHas('error', 'Your session expired. Reload the page to sign in again.');
});
