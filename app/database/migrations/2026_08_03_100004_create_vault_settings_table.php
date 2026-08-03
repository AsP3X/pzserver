<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vault_settings', function (Blueprint $table) {
            $table->id();
            $table->unsignedInteger('default_slots')->default(50);
            $table->unsignedInteger('max_slots')->default(500);
            $table->unsignedInteger('slot_upgrade_increment')->default(10);
            $table->decimal('slot_upgrade_cost', 12, 2)->default(100);
            $table->decimal('withdraw_fee_flat', 12, 2)->default(5);
            $table->decimal('withdraw_fee_per_item', 12, 2)->default(0);
            $table->boolean('enabled')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vault_settings');
    }
};
