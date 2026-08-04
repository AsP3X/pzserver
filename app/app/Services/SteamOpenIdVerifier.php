<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;

/**
 * Steam sign-in, verified against Steam itself.
 *
 * Steam speaks OpenID 2.0, not OAuth2, so Socialite cannot drive it without a
 * third-party provider package. The protocol here is small enough to implement
 * directly: send the user to Steam, then hand every parameter Steam sent back
 * straight to Steam and ask whether it signed them.
 *
 * The signature check is the whole of the security. Without it the callback is
 * a query string anyone could type, so a failed or unreachable verification
 * must always be treated as a failed sign-in.
 */
class SteamOpenIdVerifier
{
    private const LOGIN_URL = 'https://steamcommunity.com/openid/login';

    private const IDENTIFIER = 'http://specs.openid.net/auth/2.0/identifier_select';

    /** Steam IDs are 17-digit 64-bit values; anything else is not one. */
    private const CLAIMED_ID_PATTERN = '#^https?://steamcommunity\.com/openid/id/(\d{17})$#';

    /**
     * Where to send someone to sign in with Steam.
     */
    public function redirectUrl(string $returnUrl, string $realm): string
    {
        return self::LOGIN_URL.'?'.http_build_query([
            'openid.ns' => 'http://specs.openid.net/auth/2.0',
            'openid.mode' => 'checkid_setup',
            'openid.return_to' => $returnUrl,
            'openid.realm' => $realm,
            'openid.identity' => self::IDENTIFIER,
            'openid.claimed_id' => self::IDENTIFIER,
        ]);
    }

    /**
     * The verified 64-bit Steam ID behind a callback, or null.
     *
     * @param  array<string, mixed>  $query  Every openid.* parameter as received
     */
    public function verify(array $query): ?string
    {
        if (($query['openid.mode'] ?? null) !== 'id_res') {
            return null;
        }

        $claimedId = (string) ($query['openid.claimed_id'] ?? '');

        if (! preg_match(self::CLAIMED_ID_PATTERN, $claimedId, $matches)) {
            return null;
        }

        /**
         * Echo the parameters back verbatim apart from the mode, which becomes
         * the verification request. Rewriting any other value would invalidate
         * the signature and reject a legitimate sign-in.
         */
        $payload = array_merge(
            array_filter($query, fn (string $key) => str_starts_with($key, 'openid.'), ARRAY_FILTER_USE_KEY),
            ['openid.mode' => 'check_authentication'],
        );

        try {
            $response = Http::asForm()->timeout(10)->post(self::LOGIN_URL, $payload);
        } catch (\Throwable) {
            return null;
        }

        if (! $response->successful()) {
            return null;
        }

        /** Steam answers with a tiny key:value document, not JSON. */
        if (! preg_match('/is_valid\s*:\s*true/i', $response->body())) {
            return null;
        }

        return $matches[1];
    }
}
