<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\VehicleKeyHolder;
use App\Services\VehicleReader;
use Illuminate\Support\Collection;
use Inertia\Inertia;
use Inertia\Response;

class VehicleController extends Controller
{
    public function __construct(
        private readonly VehicleReader $vehicles,
    ) {}

    public function index(): Response
    {
        $fleet = $this->vehicles->read();
        $remembered = $this->rememberedHolders();

        $vehicles = array_map(
            fn (array $vehicle) => [
                ...$vehicle,
                'holders' => $this->holdersFor($vehicle, $remembered),
            ],
            $fleet['vehicles'],
        );

        return Inertia::render('admin/vehicles', [
            'vehicles' => $vehicles,
            'exported_at' => $fleet['timestamp'],
        ]);
    }

    /**
     * Everyone ever seen with a key, keyed by vehicle.
     *
     * @return Collection<int, Collection<int, VehicleKeyHolder>>
     */
    private function rememberedHolders(): Collection
    {
        return VehicleKeyHolder::query()
            ->orderByDesc('last_seen_at')
            ->get()
            ->groupBy('vehicle_id');
    }

    /**
     * Who holds this vehicle's key, merging the live export with what was
     * remembered from earlier.
     *
     * The mod can only see loaded inventories, so a holder who is offline is
     * still shown — marked as last seen rather than present, since a car whose
     * owner logged off has not become ownerless.
     *
     * @param  array<string, mixed>  $vehicle
     * @param  Collection<int, Collection<int, VehicleKeyHolder>>  $remembered
     * @return array<int, array{username: string, online: bool, last_seen_at: string|null}>
     */
    private function holdersFor(array $vehicle, Collection $remembered): array
    {
        $live = $vehicle['key_holders'];

        $holders = array_map(
            fn (string $username) => ['username' => $username, 'online' => true, 'last_seen_at' => null],
            $live,
        );

        foreach ($remembered->get($vehicle['id'], collect()) as $record) {
            if (in_array($record->username, $live, true)) {
                continue;
            }

            $holders[] = [
                'username' => $record->username,
                'online' => false,
                'last_seen_at' => $record->last_seen_at?->toIso8601String(),
            ];
        }

        return $holders;
    }
}
