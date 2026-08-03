<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vault_items', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('vault_id')->constrained()->cascadeOnDelete();
            $table->string('full_type');
            $table->string('name');
            $table->string('category')->default('General');
            $table->decimal('condition', 4, 2)->default(1.00);
            $table->unsignedInteger('count')->default(1);
            $table->timestamps();
            $table->unique(['vault_id', 'full_type', 'condition']);
            $table->index(['vault_id', 'full_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vault_items');
    }
};
