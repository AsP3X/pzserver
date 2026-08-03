<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vault_transactions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('vault_id')->constrained()->cascadeOnDelete();
            $table->string('direction');
            $table->string('status')->default('pending');
            $table->string('full_type');
            $table->decimal('condition', 4, 2)->default(1.00);
            $table->unsignedInteger('requested_count');
            $table->unsignedInteger('actual_count')->default(0);
            $table->decimal('fee_charged', 12, 2)->default(0);
            $table->foreignUuid('wallet_transaction_id')->nullable()->constrained('wallet_transactions')->nullOnDelete();
            $table->string('delivery_id')->nullable();
            $table->text('message')->nullable();
            $table->timestamps();
            $table->index(['vault_id', 'created_at']);
            $table->index(['status', 'delivery_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vault_transactions');
    }
};
