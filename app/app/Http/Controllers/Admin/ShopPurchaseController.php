<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Concerns\SortsQuery;
use App\Http\Controllers\Controller;
use App\Models\ShopPurchase;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class ShopPurchaseController extends Controller
{
    use SortsQuery;

    /**
     * Display all shop purchases for admin management.
     */
    public function index(Request $request): Response
    {
        $query = ShopPurchase::query()
            ->with(['user', 'purchasable', 'deliveries']);

        if ($search = $request->query('search')) {
            $query->whereHas('user', fn ($q) => $q->where('username', 'ilike', "%{$search}%"));
        }

        if ($status = $request->query('status')) {
            $query->where('delivery_status', $status);
        }

        $sortParams = $this->applySort($query, $request, ['total_price', 'quantity_bought', 'created_at', 'delivery_status']);

        $purchases = $query->paginate(25)->withQueryString();

        $totalRevenue = ShopPurchase::query()->sum('total_price');
        $totalPurchases = ShopPurchase::query()->count();
        $itemsSold = ShopPurchase::query()->sum('quantity_bought');

        return Inertia::render('admin/shop-purchases', [
            'purchases' => $purchases,
            'stats' => [
                'total_revenue' => (float) $totalRevenue,
                'total_purchases' => $totalPurchases,
                'items_sold' => (int) $itemsSold,
            ],
            'filters' => [
                'search' => $search ?? '',
                'status' => $status ?? '',
                ...$sortParams,
            ],
        ]);
    }
}
