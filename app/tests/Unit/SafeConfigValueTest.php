<?php

use App\Rules\SafeConfigValue;

/**
 * Run the rule and return the failure message, or null when the value passed.
 */
function validateConfigValue(SafeConfigValue $rule, string $attribute, mixed $value): ?string
{
    $failure = null;

    $rule->validate($attribute, $value, function (string $message) use (&$failure) {
        $failure ??= $message;
    });

    return $failure;
}

function iniRule(): SafeConfigValue
{
    return new SafeConfigValue(allowBackslash: true);
}

function luaRule(): SafeConfigValue
{
    return new SafeConfigValue;
}

describe('rich text INI keys', function () {
    it('accepts welcome messages with PZ markup', function (string $message) {
        expect(validateConfigValue(iniRule(), 'settings.ServerWelcomeMessage', $message))->toBeNull();
    })->with([
        'line breaks' => 'Welcome! <LINE> <LINE> Happy surviving!',
        'colour tag' => '<RGB:1,0,0>Welcome to Knox County!<RGB:1,1,1>',
        'size tag' => '<SIZE:medium> <CENTRE> Welcome!',
        'colour then line' => '<RGB:0.2,0.8,1> Rules <LINE> No griefing. <LINE> Have fun!',
        'ellipsis' => 'Welcome... and good luck out there!',
        'georgian prose' => 'კეთილი იყოს თქვენი მობრძანება! <LINE> წარმატებებს გისურვებთ!',
        'quotes and parentheses' => 'Type "/help" (or press T) to chat.',
        'ampersand and url' => 'Discord & rules: https://example.com/rules',
        'em dash' => "Welcome \u{2014} read the rules first.",
    ]);

    it('rejects a welcome message that would inject a second INI key', function () {
        expect(validateConfigValue(iniRule(), 'settings.ServerWelcomeMessage', "Welcome!\nRCONPassword=hacked"))
            ->toBe('The :attribute must not contain line breaks or control characters.');
    });

    it('rejects control characters in a welcome message', function (string $message) {
        expect(validateConfigValue(iniRule(), 'settings.ServerWelcomeMessage', $message))
            ->toBe('The :attribute must not contain line breaks or control characters.');
    })->with([
        'carriage return' => "Welcome!\rRCONPassword=hacked",
        'null byte' => "Welcome!\0",
    ]);

    it('rejects invalid UTF-8 in a welcome message', function () {
        expect(validateConfigValue(iniRule(), 'settings.ServerWelcomeMessage', "Welcome \xC3\x28"))
            ->toBe('The :attribute must be valid UTF-8 text.');
    });

    it('rejects a welcome message longer than one sane INI line', function () {
        expect(validateConfigValue(iniRule(), 'settings.ServerWelcomeMessage', str_repeat('a', 2001)))
            ->toBe('The :attribute must not be longer than 2000 characters.');
    });

    it('accepts a welcome message at the length limit', function () {
        expect(validateConfigValue(iniRule(), 'settings.ServerWelcomeMessage', str_repeat('a', 2000)))->toBeNull();
    });

    it('does not relax other INI keys', function (string $key) {
        expect(validateConfigValue(iniRule(), "settings.{$key}", 'Welcome <LINE> there'))
            ->toBe('The :attribute contains unsafe characters for config files.');
    })->with([
        'map' => 'Map',
        'server name' => 'ServerName',
    ]);

    it('does not relax the Lua sandbox config', function () {
        expect(validateConfigValue(luaRule(), 'settings.ServerWelcomeMessage', 'Welcome <LINE> there'))
            ->toBe('The :attribute contains unsafe characters for config files.');
    });

    it('still blocks path traversal in Map', function () {
        expect(validateConfigValue(iniRule(), 'settings.Map', '../../etc'))
            ->toBe('The :attribute contains unsafe characters for config files.');
    });
});

describe('plain config values', function () {
    it('accepts ordinary INI values', function (string $value) {
        expect(validateConfigValue(iniRule(), 'settings.MaxPlayers', $value))->toBeNull();
    })->with([
        'number' => '32',
        'map name' => 'Muldraugh, KY',
        'mod list' => 'ModA;ModB;ModC',
        'b42 mod id' => 'KnoxRelay\\42',
        'empty' => '',
    ]);

    it('rejects injection attempts in INI values', function (string $value) {
        expect(validateConfigValue(iniRule(), 'settings.MaxPlayers', $value))
            ->toBe('The :attribute contains unsafe characters for config files.');
    })->with([
        'newline' => "32\nRCONPassword=hacked",
        'double quote' => 'test"injection',
        'backtick' => 'test`cmd`',
        'parentheses' => 'os.execute()',
        'curly braces' => 'test{inject}',
        'angle bracket' => 'test<inject>',
    ]);

    it('rejects backslash in Lua values', function () {
        expect(validateConfigValue(luaRule(), 'settings.ZombieLore.Speed', 'test\\escape'))
            ->toBe('The :attribute contains unsafe characters for config files.');
    });

    it('rejects the Lua concatenation operator', function () {
        expect(validateConfigValue(luaRule(), 'settings.ZombieLore.Speed', '3..5'))
            ->toBe('The :attribute contains unsafe characters for config files.');
    });

    it('rejects non-scalar values', function () {
        expect(validateConfigValue(iniRule(), 'settings.MaxPlayers', ['32']))
            ->toBe('The :attribute must be a scalar value.');
    });
});
