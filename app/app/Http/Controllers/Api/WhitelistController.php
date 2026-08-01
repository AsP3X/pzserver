<?php

namespace App\Http\Controllers\Api;

use App\Http\Requests\Api\AddWhitelistRequest;
use App\Services\AuditLogger;
use App\Services\WhitelistManager;
use Illuminate\Http\JsonResponse;

class WhitelistController
{
    public function __construct(
        private readonly WhitelistManager $whitelistManager,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function index(): JsonResponse
    {
        try {
            $entries = $this->whitelistManager->list();
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Failed to read whitelist database',
                'detail' => $e->getMessage(),
            ], 503);
        }

        return response()->json([
            'entries' => $entries,
            'count' => count($entries),
        ]);
    }

    public function store(AddWhitelistRequest $request): JsonResponse
    {
        $username = $request->validated('username');
        $password = $request->validated('password');

        try {
            $added = $this->whitelistManager->add($username, $password);
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Failed to add to whitelist',
                'detail' => $e->getMessage(),
            ], 503);
        }

        if (! $added) {
            return response()->json([
                'error' => 'User already whitelisted',
                'username' => $username,
            ], 409);
        }

        $this->auditLogger->log(
            actor: 'api-key',
            action: 'whitelist.add',
            target: $username,
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'User added to whitelist',
            'username' => $username,
        ], 201);
    }

    public function destroy(string $username): JsonResponse
    {
        try {
            $removed = $this->whitelistManager->remove($username);
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Failed to remove from whitelist',
                'detail' => $e->getMessage(),
            ], 503);
        }

        if (! $removed) {
            return response()->json([
                'error' => 'User not found in whitelist',
            ], 404);
        }

        $this->auditLogger->log(
            actor: 'api-key',
            action: 'whitelist.remove',
            target: $username,
            ip: request()->ip(),
        );

        return response()->json([
            'message' => 'User removed from whitelist',
            'username' => $username,
        ]);
    }

    public function status(string $username): JsonResponse
    {
        try {
            $exists = $this->whitelistManager->exists($username);
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Failed to check whitelist',
                'detail' => $e->getMessage(),
            ], 503);
        }

        return response()->json([
            'username' => $username,
            'whitelisted' => $exists,
        ]);
    }

    public function sync(): JsonResponse
    {
        try {
            $result = $this->whitelistManager->syncWithPostgres();
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Sync failed',
                'detail' => $e->getMessage(),
            ], 503);
        }

        $this->auditLogger->log(
            actor: 'api-key',
            action: 'whitelist.sync',
            details: $result,
            ip: request()->ip(),
        );

        return response()->json([
            'message' => 'Whitelist sync completed',
            'added' => $result['added'],
            'removed' => $result['removed'],
            'mismatches' => $result['mismatches'],
        ]);
    }
}
