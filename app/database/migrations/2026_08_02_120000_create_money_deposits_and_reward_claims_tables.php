<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('money_deposits', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('username', 50)->index();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('status', 32)->default('pending')->index(); // pending|success|failed|timeout|cancelled|credited
            $table->unsignedInteger('money_count')->default(0);
            $table->unsignedInteger('bundle_count')->default(0);
            $table->unsignedInteger('total_coins')->default(0);
            $table->string('message')->nullable();
            $table->string('source', 32)->default('web'); // web|admin_simulate|admin_force
            $table->boolean('dry_run')->default(false);
            $table->boolean('credited')->default(false);
            $table->timestamp('processed_at')->nullable();
            $table->timestamp('credited_at')->nullable();
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->index(['username', 'status']);
            $table->index(['created_at']);
        });

        Schema::create('reward_claims', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('reward_key', 64); // e.g. daily_login
            $table->unsignedInteger('coins')->default(0);
            $table->date('claim_date'); // server-local calendar day
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->unique(['user_id', 'reward_key', 'claim_date']);
            $table->index(['reward_key', 'claim_date']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('reward_claims');
        Schema::dropIfExists('money_deposits');
    }
};
