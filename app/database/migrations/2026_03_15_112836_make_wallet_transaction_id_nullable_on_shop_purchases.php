<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        if (DB::getDriverName() === 'sqlite') {
            // SQLite: recreate via Schema builder
            Schema::table('shop_purchases', function (Blueprint $table) {
                $table->uuid('wallet_transaction_id')->nullable()->change();
            });
        } else {
            DB::statement('ALTER TABLE shop_purchases ALTER COLUMN wallet_transaction_id DROP NOT NULL');
        }
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        if (DB::getDriverName() === 'sqlite') {
            Schema::table('shop_purchases', function (Blueprint $table) {
                $table->uuid('wallet_transaction_id')->nullable(false)->change();
            });
        } else {
            DB::statement('ALTER TABLE shop_purchases ALTER COLUMN wallet_transaction_id SET NOT NULL');
        }
    }
};
