<?php

use App\Services\HoldingsReader;

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/holdings_test_'.uniqid();
    mkdir($this->tempDir, 0755, true);
    $this->path = $this->tempDir.'/holdings.json';
});

afterEach(function () {
    if (file_exists($this->path)) {
        unlink($this->path);
    }
    if (is_dir($this->tempDir)) {
        rmdir($this->tempDir);
    }
});

function writeHoldings(string $path, array $data): void
{
    file_put_contents($path, json_encode($data));
}

it('returns empty lists when the export does not exist', function () {
    $holdings = (new HoldingsReader($this->path))->read();

    expect($holdings['safehouses'])->toBe([])
        ->and($holdings['factions'])->toBe([])
        ->and($holdings['timestamp'])->toBeNull();
});

it('survives a corrupt export', function () {
    file_put_contents($this->path, '{not json');

    expect((new HoldingsReader($this->path))->read()['safehouses'])->toBe([]);
});

it('reads safehouses and factions', function () {
    writeHoldings($this->path, [
        'timestamp' => '1993-07-09T12:00:00',
        'safehouses' => [[
            'title' => 'The Mall',
            'owner' => 'Alice',
            'members' => ['Bob'],
            'x' => 100, 'y' => 200, 'x2' => 110, 'y2' => 210,
        ]],
        'factions' => [[
            'name' => 'Knox Militia', 'tag' => 'KM', 'owner' => 'Alice', 'members' => ['Alice', 'Bob'],
        ]],
    ]);

    $holdings = (new HoldingsReader($this->path))->read();

    expect($holdings['safehouses'])->toHaveCount(1)
        ->and($holdings['safehouses'][0]['title'])->toBe('The Mall')
        ->and($holdings['factions'][0]['tag'])->toBe('KM')
        ->and($holdings['timestamp'])->toBe('1993-07-09T12:00:00');
});

it('counts the owner among those entitled to be inside', function () {
    $reader = new HoldingsReader($this->path);

    $members = $reader->membersOf(['owner' => 'Alice', 'members' => ['Bob', 'Alice']]);

    expect($members)->toHaveCount(2)
        ->and($members)->toContain('Alice', 'Bob');
});

it('finds the claim containing a point', function () {
    writeHoldings($this->path, [
        'safehouses' => [[
            'title' => 'The Mall', 'owner' => 'Alice', 'members' => [],
            'x' => 100, 'y' => 200, 'x2' => 110, 'y2' => 210,
        ]],
    ]);

    $reader = new HoldingsReader($this->path);

    expect($reader->claimAt(105, 205)['title'])->toBe('The Mall')
        ->and($reader->claimAt(100, 200))->not->toBeNull();
});

it('treats the far edge of a claim as outside it', function () {
    writeHoldings($this->path, [
        'safehouses' => [[
            'title' => 'The Mall', 'owner' => 'Alice', 'members' => [],
            'x' => 100, 'y' => 200, 'x2' => 110, 'y2' => 210,
        ]],
    ]);

    $reader = new HoldingsReader($this->path);

    expect($reader->claimAt(110, 205))->toBeNull()
        ->and($reader->claimAt(105, 210))->toBeNull()
        ->and($reader->claimAt(99, 205))->toBeNull();
});
