<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\VehicleReader;
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

        return Inertia::render('admin/vehicles', [
            'vehicles' => $fleet['vehicles'],
            'exported_at' => $fleet['timestamp'],
        ]);
    }
}
