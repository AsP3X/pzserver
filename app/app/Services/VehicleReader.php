<?php

namespace App\Services;

/**
 * The server's vehicle fleet, as the Lua mod last saw it.
 *
 * Read-only. The panel answers "where did my car end up", it does not move
 * anything — vehicle teleportation is not something an HTTP request should do.
 */
class VehicleReader
{
    private string $path;

    public function __construct(?string $path = null)
    {
        $this->path = $path ?? config('zomboid.lua_bridge.vehicles');
    }

    /**
     * @return array{timestamp: string|null, vehicles: array<int, array<string, mixed>>}
     */
    public function read(): array
    {
        $empty = ['timestamp' => null, 'vehicles' => []];

        if (! is_file($this->path)) {
            return $empty;
        }

        $content = file_get_contents($this->path);
        if ($content === false) {
            return $empty;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE || ! is_array($data)) {
            return $empty;
        }

        return [
            'timestamp' => $data['timestamp'] ?? null,
            'vehicles' => array_values(array_map($this->normalise(...), $data['vehicles'] ?? [])),
        ];
    }

    /**
     * Vehicles nearest a point, for "where is the car I left by the warehouse".
     *
     * @return array<int, array<string, mixed>>
     */
    public function nearest(float $x, float $y, int $limit = 10): array
    {
        $vehicles = array_filter(
            $this->read()['vehicles'],
            fn (array $vehicle) => $vehicle['x'] !== null && $vehicle['y'] !== null,
        );

        usort(
            $vehicles,
            fn (array $a, array $b) => $this->distance($a, $x, $y) <=> $this->distance($b, $x, $y),
        );

        return array_slice(array_values($vehicles), 0, $limit);
    }

    /**
     * @param  array<string, mixed>  $vehicle
     */
    private function distance(array $vehicle, float $x, float $y): float
    {
        return (($vehicle['x'] - $x) ** 2) + (($vehicle['y'] - $y) ** 2);
    }

    /**
     * @param  array<string, mixed>  $vehicle
     * @return array<string, mixed>
     */
    private function normalise(array $vehicle): array
    {
        return [
            'id' => (int) ($vehicle['id'] ?? 0),
            'model' => (string) ($vehicle['model'] ?? 'unknown'),
            'x' => isset($vehicle['x']) ? (int) $vehicle['x'] : null,
            'y' => isset($vehicle['y']) ? (int) $vehicle['y'] : null,
            /** Absent rather than zero when the mod could not read it. */
            'fuel_percent' => isset($vehicle['fuel_percent']) ? (int) $vehicle['fuel_percent'] : null,
            'engine_quality' => isset($vehicle['engine_quality']) ? (int) $vehicle['engine_quality'] : null,
            'engine_running' => (bool) ($vehicle['engine_running'] ?? false),
            'key_spawned' => (bool) ($vehicle['key_spawned'] ?? false),
        ];
    }
}
