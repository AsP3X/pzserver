<?php

namespace Tests;

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use RuntimeException;

abstract class TestCase extends BaseTestCase
{
    public function createApplication(): Application
    {
        $app = parent::createApplication();

        $this->assertSafeTestingDatabase($app);

        return $app;
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutMiddleware([
            ThrottleRequests::class,
            ValidateCsrfToken::class,
        ]);
    }

    protected function assertSafeTestingDatabase(Application $app): void
    {
        $connection = (string) $app['config']->get('database.default');
        $database = (string) $app['config']->get("database.connections.{$connection}.database", '');
        $normalizedDatabase = strtolower($database);

        $usesSqliteMemory = $connection === 'sqlite' && $database === ':memory:';
        $looksLikeTestDatabase = str_contains($normalizedDatabase, 'test');

        if ($usesSqliteMemory || $looksLikeTestDatabase) {
            return;
        }

        throw new RuntimeException(sprintf(
            'Unsafe testing database detected: connection "%s", database "%s". Configure tests to use :memory: or a *_test database before running php artisan test.',
            $connection,
            $database === '' ? '(empty)' : $database
        ));
    }
}
