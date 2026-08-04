<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\AuditLogger;
use App\Services\SteamOpenIdVerifier;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * Steam sign-in.
 *
 * Deliberately does not create accounts. Registration here also provisions a
 * Project Zomboid account and syncs its password, none of which Steam can
 * supply — so Steam links to an account that already exists, and afterwards
 * signs that account in.
 */
class SteamAuthController extends Controller
{
    public function __construct(
        private readonly SteamOpenIdVerifier $steam,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function redirect(): RedirectResponse
    {
        return redirect()->away($this->steam->redirectUrl(
            returnUrl: route('steam.callback'),
            realm: config('app.url'),
        ));
    }

    public function callback(Request $request): RedirectResponse
    {
        $steamId = $this->steam->verify($request->query());

        if ($steamId === null) {
            return redirect()->route('login')->withErrors([
                'steam' => __('Steam could not confirm that sign-in. Please try again.'),
            ]);
        }

        $linked = User::query()->where('steam_id', $steamId)->first();

        if ($request->user() !== null) {
            return $this->link($request->user(), $steamId, $linked);
        }

        if ($linked === null) {
            return redirect()->route('login')->withErrors([
                'steam' => __('That Steam account is not linked to anyone here yet. Sign in once, then link it from your profile.'),
            ]);
        }

        Auth::login($linked, remember: true);
        $request->session()->regenerate();

        return redirect()->intended(route('portal'));
    }

    /**
     * Attach a Steam ID to the signed-in account.
     *
     * The column is unique, so a Steam account already spoken for is refused
     * rather than silently moved — two web accounts sharing one Steam identity
     * would make the sign-in path ambiguous.
     */
    private function link(User $user, string $steamId, ?User $linked): RedirectResponse
    {
        if ($linked !== null && $linked->isNot($user)) {
            return redirect()->route('profile.edit')->withErrors([
                'steam' => __('That Steam account is already linked to another account here.'),
            ]);
        }

        if ($user->steam_id !== $steamId) {
            $user->forceFill(['steam_id' => $steamId])->save();

            $this->auditLogger->log(
                actor: $user->username ?? $user->name ?? 'user',
                action: 'account.steam.linked',
                target: $user->username,
                details: ['steam_id' => $steamId],
                ip: request()->ip(),
            );
        }

        return redirect()->route('profile.edit')->with('status', __('Steam account linked.'));
    }
}
