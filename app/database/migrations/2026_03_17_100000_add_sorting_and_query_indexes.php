<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->index('actor');
        });

        Schema::table('shop_purchases', function (Blueprint $table) {
            $table->index(['user_id', 'created_at']);
            $table->index('delivery_status');
            $table->index('created_at');
        });

        Schema::table('game_events', function (Blueprint $table) {
            $table->index(['player', 'created_at']);
            $table->index('created_at');
        });

        Schema::table('wallet_transactions', function (Blueprint $table) {
            $table->index(['wallet_id', 'created_at']);
        });

        Schema::table('shop_deliveries', function (Blueprint $table) {
            $table->index(['status', 'attempts']);
            $table->index('shop_purchase_id');
        });

        Schema::table('whitelist_entries', function (Blueprint $table) {
            $table->index(['user_id', 'active']);
        });

        Schema::table('shop_items', function (Blueprint $table) {
            $table->index(['is_active', 'category_id']);
        });

        Schema::table('shop_promotions', function (Blueprint $table) {
            $table->index(['is_active', 'starts_at']);
        });
    }

    public function down(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropIndex(['actor']);
        });

        Schema::table('shop_purchases', function (Blueprint $table) {
            $table->dropIndex(['user_id', 'created_at']);
            $table->dropIndex(['delivery_status']);
            $table->dropIndex(['created_at']);
        });

        Schema::table('game_events', function (Blueprint $table) {
            $table->dropIndex(['player', 'created_at']);
            $table->dropIndex(['created_at']);
        });

        Schema::table('wallet_transactions', function (Blueprint $table) {
            $table->dropIndex(['wallet_id', 'created_at']);
        });

        Schema::table('shop_deliveries', function (Blueprint $table) {
            $table->dropIndex(['status', 'attempts']);
            $table->dropIndex(['shop_purchase_id']);
        });

        Schema::table('whitelist_entries', function (Blueprint $table) {
            $table->dropIndex(['user_id', 'active']);
        });

        Schema::table('shop_items', function (Blueprint $table) {
            $table->dropIndex(['is_active', 'category_id']);
        });

        Schema::table('shop_promotions', function (Blueprint $table) {
            $table->dropIndex(['is_active', 'starts_at']);
        });
    }
};
